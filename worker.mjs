// worker.mjs — DoguIA music proxy (proxy + truncate + R2 cache).
//
// Por que não tem transcodificação? Tentamos com mpg123-decoder (WASM)
// + lamejs, mas o decoder depende de `@eshaz/web-worker` que referencia
// a API `Worker` do browser — CF Workers runtime não expõe isso e a
// validação de upload do script falha com `Worker is not defined`.
// Pra mexer no formato precisaria de CF Containers (ffmpeg nativo) ou
// de um microsserviço externo. O atalho aqui mantém o MP3 original do
// Deezer (128 kbps stereo 44.1 kHz) e ataca o problema de freeze por
// 2 vias:
//   1. Cache em R2 → 2ª request por música é ~10 ms em vez de 1-3 s.
//   2. ?max_kb=N → trunca o arquivo, encurtando download HTTPS.
//
// API igual ao worker antigo: ?q=, ?max_kb=, headers X-Title / X-Artist
// / X-Duration. Só foi adicionado X-Cache: HIT/MISS.

const HEADERS_BASE = {
  'Content-Type': 'audio/mpeg',
  'Cache-Control': 'public, max-age=86400',
  'Access-Control-Allow-Origin': '*',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const q = url.searchParams.get('q');
    if (!q) return jsonErr(400, 'missing ?q=<query>');

    const maxKb = parseInt(url.searchParams.get('max_kb') || '0', 10);

    try {
      // 1) Cache key — query normalizada. max_kb não entra na chave:
      //    armazenamos o MP3 inteiro e cortamos só na hora de servir.
      const cacheKey = `tracks/${await sha1(q.trim().toLowerCase())}.mp3`;

      // 2) Tenta cache hit
      if (env.MUSIC) {
        const hit = await env.MUSIC.get(cacheKey);
        if (hit) {
          const meta = hit.customMetadata || {};
          return serveMp3(hit.body, meta, maxKb, /*cache=*/'HIT');
        }
      }

      // 3) Cache miss → busca no Deezer
      const sr = await fetch(
        `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=1&order=RANKING`,
        { cf: { cacheTtl: 3600, cacheEverything: true } },
      );
      if (!sr.ok) return jsonErr(502, `deezer search ${sr.status}`);
      const search = await sr.json();
      if (!search?.data?.length) return jsonErr(404, 'not found on deezer');
      const track = search.data[0];

      // 4) Baixa o MP3 inteiro (precisa do arquivo todo pra cachear)
      const ar = await fetch(track.preview, {
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      if (!ar.ok) return jsonErr(502, `preview fetch ${ar.status}`);
      const mp3Bytes = new Uint8Array(await ar.arrayBuffer());

      const meta = {
        title: asciiSafe(track.title),
        artist: asciiSafe(track.artist?.name || ''),
        duration: String(track.duration ?? 30),
      };

      // 5) Grava no R2 sem bloquear (fire-and-forget)
      if (env.MUSIC) {
        ctx.waitUntil(
          env.MUSIC.put(cacheKey, mp3Bytes, {
            httpMetadata: { contentType: 'audio/mpeg' },
            customMetadata: meta,
          }).catch((e) => console.error('R2 put failed:', e)),
        );
      }

      return serveMp3(mp3Bytes, meta, maxKb, /*cache=*/'MISS');
    } catch (e) {
      return jsonErr(500, `proxy error: ${e?.message || e}`);
    }
  },
};

// ---------- helpers ----------

function jsonErr(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function asciiSafe(s) {
  return (s || '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '');
}

async function sha1(s) {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function serveMp3(body, meta, maxKb, cacheStatus) {
  const headers = {
    ...HEADERS_BASE,
    'X-Title': meta.title || '',
    'X-Artist': meta.artist || '',
    'X-Duration': meta.duration || '30',
    'X-Cache': cacheStatus,
  };

  // Sem truncamento → devolve o stream/buffer direto.
  if (maxKb <= 0) return new Response(body, { headers });

  const limit = maxKb * 1024;

  // body já é Uint8Array (cache miss path) → fatia direto.
  if (body instanceof Uint8Array) {
    const out = body.byteLength > limit ? body.subarray(0, limit) : body;
    return new Response(out, { headers });
  }

  // body é ReadableStream (cache hit path) → corta on-the-fly via TransformStream.
  let bytesSent = 0;
  const truncator = new TransformStream({
    transform(chunk, controller) {
      if (bytesSent >= limit) return;
      const remaining = limit - bytesSent;
      if (chunk.byteLength <= remaining) {
        controller.enqueue(chunk);
        bytesSent += chunk.byteLength;
      } else {
        controller.enqueue(chunk.slice(0, remaining));
        bytesSent = limit;
        controller.terminate();
      }
    },
  });

  return new Response(body.pipeThrough(truncator), { headers });
}
