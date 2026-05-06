# Deploy do zanolla-reel-service no EasyPanel

Passo a passo completo, em ordem. O workflow no n8n (EURETwY9ucilW8aq) ja esta configurado e desativado, esperando esse servico ficar online.

## Pre-requisito: 3 musicas

Baixe 3 mp3 livres para uso comercial e renomeie:

```
track_01.mp3
track_02.mp3
track_03.mp3
```

Onde pegar (ja sao todas livres pra uso comercial sem creditar):

**Pixabay Music** (https://pixabay.com/music/) - tem botao de download direto
- Pesquise por "inspiring background", "corporate motivational", "uplifting cinematic"
- Baixe 3 que tenham 1:30+ de duracao (mais que os 28s do reel para nao cortar curto)

**YouTube Audio Library** (https://studio.youtube.com -> Audio Library)
- Filtros: Genre = Inspirational ou Corporate, Attribution = "No attribution required"

Coloque os 3 mp3 num lugar facil, vai precisar deles na hora do deploy.

## Caminho 1: Deploy via GitHub (recomendado)

### Passo 1.1: Criar repositorio Git

1. Cria um repo privado no GitHub: `zanolla-reel-service`
2. Local, na pasta `zanolla-reel-service`:

```bash
cd zanolla-reel-service
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/seu-user/zanolla-reel-service.git
git branch -M main
git push -u origin main
```

3. Copie os 3 mp3 para `public/music/`, commit, push:

```bash
cp ~/Downloads/track_01.mp3 public/music/
cp ~/Downloads/track_02.mp3 public/music/
cp ~/Downloads/track_03.mp3 public/music/
git add public/music/
git commit -m "Add background music tracks"
git push
```

Atencao: o `.gitignore` que criei NAO bloqueia `public/music/*.mp3`. Os mp3 vao para o repo. Se preferir nao commitar musica (anti-pattern em alguns ambientes), pode pular esse passo e fazer upload manual via volume no EasyPanel (Caminho 2 abaixo).

### Passo 1.2: Criar o servico no EasyPanel

1. Login em `https://n8nufem-easypanel.vftbuz.easypanel.host` (ou seu painel)
2. Selecione o projeto onde estao seus outros servicos UFEM
3. Botao **+ Service** -> **App**
4. Nome do servico: `zanolla-reel`
5. Aba **Source**:
   - Type: **Git**
   - Repository URL: `https://github.com/seu-user/zanolla-reel-service.git`
   - Branch: `main`
   - Auto Deploy: **ON** (push no main = redeploy automatico)
   - Se o repo for privado: clique em **Generate Deploy Key**, copie a chave SSH e cole nas Deploy Keys do GitHub (Settings -> Deploy keys -> Add)
6. Aba **Build**:
   - Type: **Dockerfile**
   - Path: `Dockerfile` (default)
7. Aba **Environment**:
   - Adicione: `NODE_ENV=production` (opcional, ja vem do Dockerfile)
8. Aba **Deploy**:
   - Replicas: 1
   - Resources: 
     - CPU: **2 cores** (Puppeteer renderiza paralelo e ffmpeg usa CPU)
     - Memory: **2 GB** (Chromium consome ~500MB, ffmpeg ~200MB)
     - Storage: 5 GB (libs Node + Chromium ~1.5GB)
9. Aba **Domains**:
   - Add Domain
   - Host: `zanolla-reel.vftbuz.easypanel.host`
   - Port: **3000**
   - HTTPS: **ON** (Lets Encrypt automatico)
10. **Save** e depois **Deploy**

Aguarde o build (primeira vez leva 4-6 minutos por causa do Chromium).

### Passo 1.3: Verificar saude

```bash
curl https://zanolla-reel.vftbuz.easypanel.host/health
```

Resposta esperada:
```json
{
  "status": "ok",
  "service": "zanolla-reel-service",
  "musicas_disponiveis": 3,
  "musicas": ["track_01.mp3", "track_02.mp3", "track_03.mp3"]
}
```

Se `musicas_disponiveis: 0`, as musicas nao foram para o container. Voce esqueceu de commitar os mp3, ou usou o Caminho 2 mas nao colocou os arquivos no volume.

## Caminho 2: Deploy via volume (sem commitar mp3 no Git)

Mesma coisa do Caminho 1 ate o passo 1.2.

Adicione na aba **Mounts** do servico:
- Type: **Volume**
- Name: `zanolla-reel-music`
- Mount Path: `/app/public/music`

Apos primeiro deploy:

1. Aba **Console** do servico (terminal direto no container)
2. Verifique que `/app/public/music/` esta vazio (so o `.gitkeep`)
3. Saia do console
4. No EasyPanel, va em **Volumes** (menu lateral) -> `zanolla-reel-music` -> **Browse**
5. Faca upload dos 3 mp3 pela interface
6. **Restart** o servico
7. Verifique `/health` novamente

## Passo 2: Migration no Postgres

Conecta no banco que serve o workflow (mesma credencial usada pelos nodes Postgres). Roda o SQL do arquivo `migration_shorts_columns.sql` que esta no zip.

Pode ser via DBeaver, pgAdmin, ou direto no console do Postgres no EasyPanel.

Apos rodar, vai mostrar 4 linhas (uma por coluna nova) confirmando que estao criadas.

## Passo 3: Credencial OAuth do YouTube no n8n

### Se voce ja tem credencial Google OAuth para outros services

1. n8n -> Credentials -> nova **YouTube OAuth2 API**
2. Pode reusar o mesmo client_id / client_secret de outras credenciais Google
3. Importante: o escopo OAuth precisa incluir `https://www.googleapis.com/auth/youtube.upload`. As credenciais Google que voce usa pra Drive/Sheets nao tem esse escopo, entao mesmo reaproveitando client_id/secret, vai precisar fazer um novo fluxo de autorizacao OAuth para o YouTube.

### Se precisar configurar do zero

1. Google Cloud Console (https://console.cloud.google.com)
2. Selecione o projeto que voce ja usa para outros services UFEM
3. **APIs & Services** -> **Library** -> habilite **YouTube Data API v3**
4. **Credentials** -> **Create Credentials** -> **OAuth client ID**
5. Type: **Web application**
6. Authorized redirect URIs: `https://n8nufem-n8nlasted.vftbuz.easypanel.host/rest/oauth2-credential/callback`
7. Copie client_id e client_secret
8. n8n -> Credentials -> **YouTube OAuth2 API** (NAO Google OAuth2 generico, e o YouTube especifico)
9. Cola client_id e client_secret
10. Click no botao **Connect** / **Sign in with Google**
11. Login com a conta dona do canal de YouTube. Pode ser conta Google da UFEM.
12. Aprova o acesso (escopo upload + manage)
13. Salva a credencial

### Associar a credencial ao node

1. Abre o workflow `Zanolla 200 Carrosseis Diarios - Etica Publica` no n8n
2. Click no node **YouTube Upload Short**
3. Campo **Credentials** -> seleciona a credencial youTubeOAuth2Api criada
4. Save (Ctrl+S)

## Passo 4: Teste manual

Workflow ainda desativado. Editor do n8n aberto.

1. Clica no botao **Execute Workflow** (canto inferior do editor)
2. Acompanhe a execucao node a node
3. Espere ~5 minutos (e o tempo total: render do MP4 ~1-2min + upload Cloudinary ~30s + upload YouTube ~1-2min)

Validacoes:
- **Branch IG:** posts no @proftiagozanolla devem aparecer normalmente
- **Branch Shorts:** novo Short deve aparecer no canal de YouTube com tag #Shorts
- **Banco:** linha em etica_dicas com `postada=TRUE`, `shorts_postada=TRUE`, `youtube_id` preenchido
- **Cloudinary:** asset novo no folder `zanolla_etica_reels`

## Passo 5: Reativar

Apos teste OK:
1. Workflow editor -> toggle **Active** (canto superior direito) -> ON
2. O cron volta a rodar todo dia 09h UTC (06h BRT)

## Troubleshooting

### `Render Reel Service` retorna 500
- Console do servico no EasyPanel -> ver logs
- Possiveis causas: Chromium nao iniciou (faltou alguma lib do apt), ffmpeg nao encontrou musica, HTML invalido

### `YouTube Upload Short` retorna 403
- Escopo OAuth errado: a credencial precisa do escopo `youtube.upload`. Refaz o OAuth.

### `YouTube Upload Short` retorna 401
- Token expirou. n8n geralmente refaz refresh sozinho, mas se o canal mudou de proprietario, pode precisar reconectar.

### Video sobe mas nao aparece como Short
- Verifica se #Shorts esta no titulo OU descricao
- Verifica se aspect ratio do MP4 e exatamente 9:16 (alguns players adicionam padding)
- Aguarda 30-60 minutos. YouTube reclassifica em background.

### Musica muito alta ou baixa
- Edita `src/server.js`, linha do `volume=0.65` no afade. Valores: 0.5 mais baixo, 0.8 mais alto.
- Commit + push = redeploy automatico se Auto Deploy ON.

## Arquivos no zip

- `zanolla-reel-service/` - codigo do servico
- `migration_shorts_columns.sql` - SQL da migration
- `LEIA-ME-DEPLOY.md` - este arquivo
