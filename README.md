# music-cache (Cloudflare Worker)

Proxy do Cloudflare Worker que serve preview de músicas do Deezer pro
firmware DoguIA (zzpet-s3), com cache em R2 e truncamento opcional.

## Por que não tem transcodificação?

A intenção original era reencodar os MP3 do Deezer (128 kbps stereo
44.1 kHz) pra mono 22050 Hz 64 kbps usando `mpg123-decoder` (WASM).
Não funciona em CF Workers — o decoder depende de
`@eshaz/web-worker` que referencia a API `Worker` do browser, e
a runtime do CF Workers não expõe isso (validação falha com
`Worker is not defined`).

Pra reencodar de fato precisaria de **CF Containers** (ffmpeg nativo,
em GA mas alguns accounts ainda em waitlist) ou de um microsserviço
externo (Render/Fly.io) chamado pelo Worker.

## O que ESTE worker faz

| Recurso | Comportamento |
|---|---|
| `?q=<query>` | Busca no Deezer, devolve preview MP3 |
| `?max_kb=<N>` | Trunca o MP3 nos primeiros N KB (encurta download) |
| Cache R2 | Música já buscada → 2ª request em ~10 ms |
| Headers | `X-Title`, `X-Artist`, `X-Duration`, `X-Cache` |

## Fluxo

```
ESP32 ──HTTPS──> Worker
                    │
                    ├─ R2 hit? ──> serve direto (~10 ms)
                    │
                    └─ miss ──> Deezer API ──> preview MP3 ──> R2.put + serve
```

## Deploy

```bash
cd musicmarvin
npm install
npx wrangler login
npx wrangler r2 bucket create music-cache   # uma vez só
npx wrangler deploy
```

URL gerada: `https://music-cache.<seu-account>.workers.dev`

## Testes

### Sanity check

```bash
curl -sD - -o /tmp/song.mp3 \
  "https://music-cache.<seu-account>.workers.dev/?q=ramones+blitzkrieg" \
  | grep -E 'X-Cache|X-Title|X-Artist|Content-Length'

ls -la /tmp/song.mp3
ffprobe /tmp/song.mp3 2>&1 | grep -E 'Audio|Duration'
# esperado: Audio: mp3, 44100 Hz, stereo, 128 kb/s
#           Duration: ~30s
#           ~480 KB
```

### Cache hit

```bash
curl -sI "https://music-cache.<seu-account>.workers.dev/?q=ramones+blitzkrieg" \
  | grep X-Cache
# 1ª: X-Cache: MISS  (~3 s)
# 2ª: X-Cache: HIT   (~50 ms)
```

### Truncamento

```bash
curl -s -o /tmp/short.mp3 \
  "https://music-cache.<seu-account>.workers.dev/?q=ramones&max_kb=120"
ls -la /tmp/short.mp3   # ~120 KB → ~7.5 s de música
```

## Custos

| Recurso | Free tier | Suficiente pra |
|---|---|---|
| Workers requests | 100 k/dia | uso doméstico |
| R2 storage | 10 GB | ~20 mil músicas a 480 KB |
| R2 Class A (PUT) | 1 M ops/mês | 33 mil músicas novas/mês |
| R2 Class B (GET) | 10 M ops/mês | 333 mil hits/mês |

**Total**: $0 fixo. Diferente da versão com transcode (que exigia
Workers Paid $5/mês), este worker fica todo no free tier.

## Manutenção

```bash
npm run r2:list                                  # lista chaves
npx wrangler r2 object delete music-cache tracks/<sha1>.mp3   # deleta uma
npm run r2:purge                                 # apaga tudo + recria
npm run tail                                     # logs ao vivo
```

## Lifecycle (TTL automático no R2)

Pra evitar acumular músicas pra sempre, configure no painel:

1. R2 → music-cache → **Settings** → **Object Lifecycle Rules**
2. **Add rule**:
   - Name: `expire-old-tracks`
   - Apply to: `tracks/`
   - Action: Delete after **90 days**
3. Save

Após o TTL, a música é deletada automaticamente. Próxima request por
ela faz cache miss e renova.

## Compatibilidade com firmware

A API é idêntica à do worker antigo — o ESP32 continua chamando:

```
https://music-cache.<seu-account>.workers.dev/?q=<query>
```

E recebe MP3 com headers `X-Title`/`X-Artist`/`X-Duration`. Nenhuma
mudança no firmware é necessária.

## Pendências (próximos passos opcionais)

1. **Transcoding real** quando CF Containers estiver disponível na sua
   conta — adicionar Dockerfile com ffmpeg, chamar via container
   binding. Reduz arquivo de 480 KB → 240 KB.
2. **Suporte a Jamendo** como fallback quando Deezer não acha a música
   (firmware já tem `SearchJamendo` implementado).
3. **Métricas** via `wrangler tail` ou Cloudflare Workers Analytics
   pra entender quais músicas batem mais o cache.
