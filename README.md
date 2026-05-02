# music-proxy (Cloudflare Worker)

Proxy do Cloudflare Worker que serve preview de músicas do Deezer pro
firmware DoguIA (zzpet-s3), reencodando para um formato leve que o
ESP32-S3 consegue baixar e decodificar sem travar.

## Diferenças do worker antigo

| Item | Antes | Agora |
|---|---|---|
| Formato | MP3 stereo 44100 Hz 128 kbps | **MP3 mono 22050 Hz 64 kbps** |
| Tamanho típico (30 s) | ~480 KB | **~240 KB** |
| Janela TLS | ~20 s download | **~10 s download** |
| Cache | só CF edge cache (varia) | **R2 cache permanente** (10 GB grátis) |
| API | `?q=` `?max_kb=` | **idêntica** + header `X-Cache: HIT/MISS` |

A API é compatível: o firmware já existente continua chamando
`https://music-proxy.<seu-account>.workers.dev/?q=ramones+blitzkrieg` e
recebe MP3. As headers `X-Title`, `X-Artist`, `X-Duration` continuam.

## Pré-requisitos

- Conta Cloudflare Workers **Paid** ($5/mês). O free tier (10 ms CPU)
  estoura no transcode (~10 s de CPU por música).
- `node` 20+ e `npm` na máquina de deploy.
- `wrangler` CLI (instala via `npm install`).

## Deploy

```bash
cd worker-music-proxy
npm install

# Login (abre browser pra OAuth)
npx wrangler login

# Cria o bucket R2 (uma vez só por conta)
npm run r2:create

# Deploy
npm run deploy
```

A URL gerada vai aparecer no fim:
`https://music-proxy.<seu-account>.workers.dev`

Atualize o firmware (`main/boards/zzpet-s3/music_streamer.cc:RegisterMcpTools`
e `zzpet_web_server.cc:HandlePlayProxy`) pra apontar pra ela se mudou de
URL — se vc reusar o mesmo nome do worker antigo (`music-proxy`), nada
muda no firmware.

## Testes

### CPU + tamanho

Primeira chamada (cold cache):
```bash
curl -s -o /tmp/light.mp3 -D - \
  "https://music-proxy.<seu-account>.workers.dev/?q=ramones+blitzkrieg" \
  | grep -E 'X-Cache|X-Title|X-Artist|Content-Length'
ls -la /tmp/light.mp3
ffprobe /tmp/light.mp3 2>&1 | grep -E 'Audio|Duration'
```

Esperado:
```
X-Cache: MISS
X-Title: Blitzkrieg Bop
X-Artist: Ramones
~240 KB de arquivo
Audio: mp3, 22050 Hz, mono, fltp, 64 kb/s
Duration: ~30s
```

Segunda chamada (cache hit):
```bash
curl -sI "https://music-proxy.<seu-account>.workers.dev/?q=ramones+blitzkrieg" | grep X-Cache
# → X-Cache: HIT  (TTFB ~10 ms)
```

### Truncamento

```bash
curl -s -o /tmp/short.mp3 \
  "https://music-proxy.<seu-account>.workers.dev/?q=ramones+blitzkrieg&max_kb=80"
ls -la /tmp/short.mp3   # ~80 KB → ~10 s de áudio
```

### End-to-end no firmware

```bash
curl -s "http://doguia.local/doguia/play_proxy?q=ramones+blitzkrieg"
```

Esperado nos logs serial (ESP_LOGW):
```
W (xxxx) MusicStreamer: stream 22050 Hz, 1 ch, 16 bps        ← era 44100/2
W (xxxx) MusicStreamer: prebuffered 13230 samples (1200ms) in <1500 ms
W (xxxx) MusicStreamer: dl request 1: HTTP 200, +240000 bytes, total 240000 complete
W (xxxx) MusicStreamer: stream done — pushed N frames
```

## Local dev

```bash
npm run dev
# Abre wrangler dev em http://localhost:8787
# Curl ali pra testar sem fazer deploy:
curl -s -o /tmp/dev.mp3 "http://localhost:8787/?q=ramones"
```

`wrangler dev` por padrão usa **R2 local** (filesystem do dev), não toca
no bucket de produção. Pra usar o bucket real durante dev:
```bash
npx wrangler dev --remote
```

## Manutenção

### Listar / limpar cache

```bash
npm run r2:list                      # lista chaves
npx wrangler r2 object delete music-cache tracks/<sha1>.mp3   # deleta uma
npm run r2:purge                     # apaga tudo + recria bucket
```

### Logs em produção

```bash
npm run tail
# Stream em tempo real dos logs (console.log/console.error do worker)
```

## Como funciona internamente

1. Recebe `?q=<query>`.
2. Calcula `cacheKey = sha1(q.trim().toLowerCase())`.
3. Tenta `MUSIC.get(cacheKey)` no R2. Se hit → serve direto (10 ms).
4. Cache miss:
   - `GET https://api.deezer.com/search?q=...&limit=1` → preview URL +
     metadata (title/artist/duration).
   - `GET <preview URL>` → MP3 stereo 128 kbps 44100 Hz inteiro (~480 KB).
   - `mpg123-decoder` (WASM) decodifica → Float32 PCM stereo.
   - Downmix L+R/2 + decimate 2:1 → Int16 mono 22050 Hz.
   - `lamejs` encoda → MP3 mono 64 kbps 22050 Hz (~240 KB).
   - `ctx.waitUntil(MUSIC.put(...))` salva em R2 sem bloquear resposta.
5. Devolve com headers `X-Title`, `X-Artist`, `X-Duration`, `X-Cache`.

## Custos esperados (uso doméstico, 1 robô)

| Item | Quota free | Custo extra |
|---|---|---|
| Workers Paid | 10 M req/mês incl. | $0 |
| R2 storage | 10 GB grátis (~40 mil músicas) | $0 |
| R2 Class A (PUT) | 1 M ops/mês grátis | $0 |
| R2 Class B (GET) | 10 M ops/mês grátis | $0 |
| **Total fixo** | — | **$5/mês (Workers Paid)** |

A partir do 2º hit por música, custo zero (R2 grátis).

## Rollback

Se o transcode der problema (artefato sonoro, OOM, CPU stall), volta
pro worker antigo:

```bash
git checkout HEAD~1 worker.mjs   # se vc commitou em cima do antigo
npm run deploy
```

Ou simplesmente re-deploya o `music-proxy.js` original — eles ocupam o
mesmo namespace `name = "music-proxy"`.

## Dúvidas frequentes

**P: Por que não usar `Range` no upstream pra economizar download Deezer?**
R: Pra decodificar MP3 inteiro a partir do offset 0 a gente PRECISA dos
frames todos. Range com bytes parciais quebra o decoder.

**P: Não dá pra fazer o transcode no Worker free tier?**
R: Não. O encode lamejs sozinho já passa de 5s de CPU. Free é 10ms.

**P: A qualidade de 64 kbps mono não fica ruim?**
R: Pra preview vocal de 30s no alto-falante mono do robô a diferença é
imperceptível. Se quiser melhor → muda para 96 kbps em `transcode()` no
worker.mjs.

**P: O R2 vai expirar essas músicas?**
R: Não automaticamente. Precisa rodar `r2:purge` ou deletar manualmente.
Pra TTL automático, configure [Object Lifecycle Rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
no painel do R2.
