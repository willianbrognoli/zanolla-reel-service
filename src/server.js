// ============================================================
// Zanolla Reel Service v1.1
// POST /render-reel  -> recebe array de HTMLs, devolve MP4 1080x1920
// POST /render-image -> compativel com /screenshot existente (fallback)
// GET  /health
//
// Mudancas v1.1:
// - Duracao dinamica: alvo ~25s, min 3s, max 8s por slide (ignora duration_per_slide do body)
// - Transicoes com crossfade 0.3s entre slides (xfade)
// - Musica em loop infinito com -stream_loop -1, fade-in 0.5s e fade-out 0.8s no fim real
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

// ----------------------- CONFIG DURACAO -----------------------
const TARGET_TOTAL_SECONDS = 25;
const MIN_PER_SLIDE = 3;
const MAX_PER_SLIDE = 8;
const TRANSITION_DURATION = 0.3; // crossfade entre slides
const AUDIO_FADE_IN = 0.5;
const AUDIO_FADE_OUT = 0.8;
const AUDIO_VOLUME = 0.65;

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

function calcDurationPerSlide(numSlides) {
  let d = TARGET_TOTAL_SECONDS / numSlides;
  d = Math.max(MIN_PER_SLIDE, Math.min(MAX_PER_SLIDE, d));
  // arredonda em casa decimal pra estabilidade do ffmpeg
  return Math.round(d * 100) / 100;
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

// Gera 1 segmento MP4 a partir de 1 JPEG, com duracao exata
function renderSlideSegment(imagePath, outPath, durationSeconds, fps) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop 1', '-t ' + durationSeconds])
      .outputOptions([
        '-r ' + fps,
        '-c:v libx264',
        '-preset medium',
        '-crf 20',
        '-pix_fmt yuv420p',
        '-vf format=yuv420p',
        '-movflags +faststart'
      ])
      .on('error', reject)
      .on('end', resolve)
      .save(outPath);
  });
}

// Monta filter_complex de xfade encadeado para N segmentos
// Resultado: cadeia [0:v][1:v]xfade=offset=A => [v01], [v01][2:v]xfade=offset=B => [v02], ...
function buildXfadeFilter(numSegments, durationPerSlide, transitionDuration) {
  if (numSegments === 1) {
    return { filter: null, finalLabel: '0:v', totalDuration: durationPerSlide };
  }

  const parts = [];
  let cumulativeOffset = 0;
  let prevLabel = '[0:v]';

  for (let i = 1; i < numSegments; i++) {
    // offset = onde a transicao comeca no tempo do video acumulado ate aqui
    cumulativeOffset += (durationPerSlide - transitionDuration);
    const outLabel = (i === numSegments - 1) ? '[vout]' : '[v' + i + ']';
    parts.push(
      prevLabel + '[' + i + ':v]xfade=transition=fade:duration=' +
      transitionDuration + ':offset=' + cumulativeOffset.toFixed(3) + outLabel
    );
    prevLabel = outLabel;
  }

  // Total real do video: cada slide contribui (duration - transition), exceto o ultimo que contribui completo
  const totalDuration = (numSegments * durationPerSlide) - ((numSegments - 1) * transitionDuration);

  return {
    filter: parts.join(';'),
    finalLabel: 'vout',
    totalDuration: totalDuration
  };
}

// ----------------------- ENDPOINT /render-reel -----------------------
app.post('/render-reel', async (req, res) => {
  const startTs = Date.now();
  const {
    htmls,                 // array de strings HTML (1 por slide)
    width = 1080,
    height = 1920,
    fps = 30,
    audio = true
    // duration_per_slide do body e ignorado: calculo dinamico aqui
  } = req.body || {};

  if (!Array.isArray(htmls) || htmls.length === 0) {
    return res.status(400).json({ error: 'htmls (array) obrigatorio' });
  }

  const durationPerSlide = calcDurationPerSlide(htmls.length);
  console.log('[render-reel] ' + htmls.length + ' slides x ' + durationPerSlide + 's/slide');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel_work_'));
  const cleanupPaths = [workDir];

  try {
    // 1. Renderizar cada HTML como JPEG
    const imagePaths = [];
    for (let i = 0; i < htmls.length; i++) {
      const buf = await renderHtmlToImage(htmls[i], width, height);
      const p = path.join(workDir, 'slide_' + String(i).padStart(3, '0') + '.jpg');
      fs.writeFileSync(p, buf);
      imagePaths.push(p);
    }

    // 2. Cada JPEG vira segmento MP4 individual com duracao exata
    const segmentPaths = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const segPath = path.join(workDir, 'seg_' + String(i).padStart(3, '0') + '.mp4');
      await renderSlideSegment(imagePaths[i], segPath, durationPerSlide, fps);
      segmentPaths.push(segPath);
    }

    // 3. Concatenar segmentos com xfade crossfade
    const videoNoAudio = path.join(workDir, 'video_noaudio.mp4');
    const xfade = buildXfadeFilter(segmentPaths.length, durationPerSlide, TRANSITION_DURATION);

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg();
      segmentPaths.forEach(seg => cmd.input(seg));

      const outputOptions = [
        '-r ' + fps,
        '-c:v libx264',
        '-preset medium',
        '-crf 20',
        '-pix_fmt yuv420p',
        '-movflags +faststart'
      ];

      if (xfade.filter) {
        cmd.complexFilter(xfade.filter, [xfade.finalLabel]);
      }

      cmd
        .outputOptions(outputOptions)
        .on('error', reject)
        .on('end', resolve)
        .save(videoNoAudio);
    });

    const totalDuration = xfade.totalDuration;

    // 4. Adicionar musica em loop, trim, fade-in, fade-out, volume
    let finalVideo = videoNoAudio;
    let musicaUsada = null;
    if (audio) {
      const musicPath = pickRandomMusic();
      musicaUsada = path.basename(musicPath);
      const videoWithAudio = path.join(workDir, 'video_final.mp4');
      const fadeOutStart = Math.max(0, totalDuration - AUDIO_FADE_OUT);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(videoNoAudio)
          .input(musicPath)
          .inputOptions(['-stream_loop -1']) // aplicado ao ultimo input (musica): loop infinito ate o -t
          .outputOptions([
            '-map 0:v:0',
            '-map 1:a:0',
            '-c:v copy',
            '-c:a aac',
            '-b:a 192k',
            '-t ' + totalDuration.toFixed(3),
            '-af volume=' + AUDIO_VOLUME +
              ',afade=t=in:st=0:d=' + AUDIO_FADE_IN +
              ',afade=t=out:st=' + fadeOutStart.toFixed(3) + ':d=' + AUDIO_FADE_OUT
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
    res.setHeader('X-Reel-Duration-Per-Slide', durationPerSlide);
    res.setHeader('X-Reel-Total-Duration', totalDuration.toFixed(3));
    res.setHeader('X-Reel-Transition', TRANSITION_DURATION);
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
    version: '1.1',
    config: {
      target_total_seconds: TARGET_TOTAL_SECONDS,
      min_per_slide: MIN_PER_SLIDE,
      max_per_slide: MAX_PER_SLIDE,
      transition_duration: TRANSITION_DURATION
    },
    musicas_disponiveis: musicFiles.length,
    musicas: musicFiles
  });
});

app.listen(PORT, () => {
  console.log('Zanolla Reel Service v1.1 rodando em :' + PORT);
});