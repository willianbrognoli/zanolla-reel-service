# Zanolla Reel Service

Servico de render de Reels/YouTube Shorts a partir de cards HTML.
Pipeline: HTML -> Puppeteer (JPEGs) -> ffmpeg concat -> overlay de audio -> MP4 1080x1920.

## Endpoints

### POST /render-reel
Recebe array de HTMLs, devolve MP4 1080x1920 30fps com musica de fundo.

Request:
```json
{
  "htmls": ["<!DOCTYPE html>...", "<!DOCTYPE html>..."],
  "width": 1080,
  "height": 1920,
  "duration_per_slide": 4,
  "fps": 30,
  "audio": true
}
```

Response: binary MP4. Headers extras:
- X-Reel-Slides
- X-Reel-Duration (segundos)
- X-Reel-Music (nome do arquivo escolhido)
- X-Reel-Render-Ms

### POST /render-image
Compativel com a API do screenshot service (renderiza HTML como JPEG unico).

### GET /health
Lista musicas disponiveis e status do servico.

## Setup

### 1. Musicas (3 faixas obrigatorias)

Coloque 3 arquivos MP3/M4A em `public/music/`. O servico escolhe uma aleatoriamente a cada render.

Recomendacoes (todas livres de copyright, adequadas para educacao/concursos):

**Opcao A: YouTube Audio Library** (Creative Commons / livre para uso comercial)
- "Inspiring Cinematic Ambient" - busque em studio.youtube.com/channel/UC.../music
- "Motivational Corporate" - genero Inspirational
- "Uplifting Background" - genero Corporate

**Opcao B: Pixabay Music** (https://pixabay.com/music/) - licenca livre incluindo uso comercial
- "Inspiring Cinematic Background" by Lexin_Music
- "Corporate Motivational" by Music_Unlimited
- "Uplifting Background" by Music_For_Videos

**Opcao C: Free Music Archive** (filtro CC BY)
- Scott Holmes - "Hopeful Freedom"
- Kevin MacLeod - "Inspired" (CC BY 4.0)
- Lee Rosevere - "Featherlight"

Salve como:
```
public/music/track_01.mp3
public/music/track_02.mp3
public/music/track_03.mp3
```

Qualquer arquivo `.mp3`, `.m4a`, `.aac` ou `.wav` em `public/music/` entra no pool.

### 2. Deploy no EasyPanel

1. Crie um novo App (tipo "App / Service").
2. Source: GitHub (push esse repo) ou Dockerfile direto.
3. Build: Dockerfile (auto-detect).
4. Port: 3000 (HTTP).
5. Domain: `zanolla-reel.vftbuz.easypanel.host` (sugestao).
6. Deploy.

Apos subir, antes do primeiro deploy faca commit dos arquivos de musica em `public/music/`. Ou monte um volume persistente.

### 3. Teste

```bash
curl https://zanolla-reel.vftbuz.easypanel.host/health
```

Deve retornar:
```json
{
  "status": "ok",
  "service": "zanolla-reel-service",
  "musicas_disponiveis": 3,
  "musicas": ["track_01.mp3", "track_02.mp3", "track_03.mp3"]
}
```

## Recursos do container

Recomendado no EasyPanel:
- 2 vCPU
- 2GB RAM (Puppeteer + ffmpeg)
- 5GB disk
