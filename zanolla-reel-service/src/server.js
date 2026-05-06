// ============================================================
// Zanolla Reel Service v1.0
// POST /render-reel  -> recebe array de HTMLs, devolve MP4 1080x1920
// POST /render-image -> compativel com /screenshot existente (fallback)
// GET  /health
// ============================================================

const express = require('express');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const MUSIC_DIR = path.join(__dirname, '..', 'public', 'music');

// ----------------------- BROWSER POOL -----------------------
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--font-render-hinting=none'
      ]
    });
  }
  return browserPromise;
}

// ----------------------- HELPERS -----------------------
function tmpPath(ext) {
  return path.join(os.tmpdir(), 'reel_' + crypto.randomBytes(8).toString('hex') + '.' + ext);
}

function pickRandomMusic() {
  if (!fs.existsSync(MUSIC_DIR)) {
    throw new Error('MUSIC_DIR nao existe: ' + MUSIC_DIR);
  }
  const files = fs.readdirSync(MUSIC_DIR).filter(f => f.match(/\.(mp3|m4a|aac|wav)$/i));
  if (files.length === 0) {
    throw new Error('Nenhuma musica encontrada em ' + MUSIC_DIR);
  }
  const pick = files[Math.floor(Math.random() * files.length)];
  return path.join(MUSIC_DIR, pick);
}

async function renderHtmlToImage(html, width, height) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));
    const buf = await page.screenshot({
      type: 'jpeg',
      quality: 95,
      clip: { x: 0, y: 0, width, height }
    });
    return buf;
  } finally {
    await page.close();
  }
}

// ----------------------- ENDPOINT /render-reel -----------------------
app.post('/render-reel', async (req, res) => {
  const startTs = Date.now();
  const {
    htmls,                 // array de strings HTML (1 por slide)
    width = 1080,
    height = 1920,
    duration_per_slide = 4, // segundos
    fps = 30,
    audio = true
  } = req.body || {};

  if (!Array.isArray(htmls) || htmls.length === 0) {
    return res.status(400).json({ error: 'htmls (array) obrigatorio' });
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel_work_'));
  const cleanupPaths = [workDir];

  try {
    // 1. Renderizar cada HTML como imagem JPEG
    console.log('[render-reel] renderizando ' + htmls.length + ' slides em ' + width + 'x' + height);
    const imagePaths = [];
    for (let i = 0; i < htmls.length; i++) {
      const buf = await renderHtmlToImage(htmls[i], width, height);
      const p = path.join(workDir, 'slide_' + String(i).padStart(3, '0') + '.jpg');
      fs.writeFileSync(p, buf);
      imagePaths.push(p);
    }

    // 2. Montar concat list para ffmpeg
    const concatListPath = path.join(workDir, 'concat.txt');
    const concatLines = imagePaths.map(p =>
      "file '" + p + "'\nduration " + duration_per_slide
    );
    // ffmpeg concat exige a ultima imagem repetida (sem duration)
    concatLines.push("file '" + imagePaths[imagePaths.length - 1] + "'");
    fs.writeFileSync(concatListPath, concatLines.join('\n'));

    // 3. Montar video sem audio
    const videoNoAudio = path.join(workDir, 'video_noaudio.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions([
          '-vsync vfr',
          '-pix_fmt yuv420p',
          '-r ' + fps,
          '-c:v libx264',
          '-preset medium',
          '-crf 20',
          '-movflags +faststart'
        ])
        .on('error', reject)
        .on('end', resolve)
        .save(videoNoAudio);
    });

    // 4. Adicionar musica (se audio=true)
    let finalVideo = videoNoAudio;
    let musicaUsada = null;
    if (audio) {
      const musicPath = pickRandomMusic();
      musicaUsada = path.basename(musicPath);
      const videoWithAudio = path.join(workDir, 'video_final.mp4');
      const totalDuration = htmls.length * duration_per_slide;

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(videoNoAudio)
          .input(musicPath)
          .outputOptions([
            '-c:v copy',
            '-c:a aac',
            '-b:a 192k',
            '-shortest',
            '-t ' + totalDuration,
            '-af afade=t=in:st=0:d=0.5,afade=t=out:st=' + (totalDuration - 0.8) + ':d=0.8,volume=0.65'
          ])
          .on('error', reject)
          .on('end', resolve)
          .save(videoWithAudio);
      });

      finalVideo = videoWithAudio;
    }

    // 5. Streamar resultado
    const stat = fs.statSync(finalVideo);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="reel.mp4"');
    res.setHeader('X-Reel-Slides', htmls.length);
    res.setHeader('X-Reel-Duration', htmls.length * duration_per_slide);
    res.setHeader('X-Reel-Music', musicaUsada || 'none');
    res.setHeader('X-Reel-Render-Ms', Date.now() - startTs);

    const stream = fs.createReadStream(finalVideo);
    stream.pipe(res);
    stream.on('close', () => {
      cleanupPaths.forEach(p => {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
      });
    });
  } catch (err) {
    console.error('[render-reel] erro:', err);
    cleanupPaths.forEach(p => {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
    });
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ----------------------- ENDPOINT /render-image (compat) -----------------------
app.post('/render-image', async (req, res) => {
  const { html, width = 1080, height = 1920, format = 'jpeg', quality = 95 } = req.body || {};
  if (!html) return res.status(400).json({ error: 'html obrigatorio' });
  try {
    const buf = await renderHtmlToImage(html, width, height);
    res.setHeader('Content-Type', 'image/' + format);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ----------------------- HEALTH -----------------------
app.get('/health', (req, res) => {
  const musicFiles = fs.existsSync(MUSIC_DIR)
    ? fs.readdirSync(MUSIC_DIR).filter(f => f.match(/\.(mp3|m4a|aac|wav)$/i))
    : [];
  res.json({
    status: 'ok',
    service: 'zanolla-reel-service',
    musicas_disponiveis: musicFiles.length,
    musicas: musicFiles
  });
});

app.listen(PORT, () => {
  console.log('Zanolla Reel Service rodando em :' + PORT);
});
