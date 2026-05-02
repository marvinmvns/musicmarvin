// worker.mjs — DoguIA music proxy com transcodificação leve em-Worker.
//
// Mantém a API do worker antigo (?q=..., ?max_kb=..., headers X-Title /
// X-Artist / X-Duration) mas reencoda o MP3 do Deezer para mono 22050 Hz
// 64 kbps usando mpg123-decoder (WASM) + lamejs (puro JS). Resultado:
// arquivo cai de ~480 KB → ~240 KB, dobra a chance do download terminar
// antes do TLS do ESP dar EAGAIN.
//
// Cache em R2 (binding `MUSIC`): primeira request por música paga o
// transcode (~8-12 s de CPU); subsequentes lêem em ~10 ms.

import { MPEGDecoder } from 'mpg123-decoder';
import lamejs from '@breezystack/lamejs';

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
      // 1) Cache por R2 — chave determinística por query normalizada.
      //    max_kb não entra na chave: armazenamos o arquivo inteiro
      //    transcodificado e cortamos só na hora de servir.
      const cacheKey = `tracks/${await sha1(q.trim().toLowerCase())}.mp3`;

      if (env.MUSIC) {
        const hit = await env.MUSIC.get(cacheKey);
        if (hit) {
          const meta = hit.customMetadata || {};
          return serveMp3(hit.body, meta, maxKb, /*cache=*/'HIT');
        }
      }

      // 2) Cache miss → Deezer search.
      const sr = await fetch(
        `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=1&order=RANKING`,
        { cf: { cacheTtl: 3600, cacheEverything: true } },
      );
      if (!sr.ok) return jsonErr(502, `deezer search ${sr.status}`);
      const search = await sr.json();
      if (!search?.data?.length) return jsonErr(404, 'not found on deezer');
      const track = search.data[0];

      // 3) Baixa o MP3 INTEIRO do preview (Range não — precisamos do
      //    arquivo completo pra decodificar todos os frames MP3).
      const ar = await fetch(track.preview, {
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      if (!ar.ok) return jsonErr(502, `preview fetch ${ar.status}`);
      const sourceMp3 = new Uint8Array(await ar.arrayBuffer());

      // 4) Decode → downmix → decimate → encode 64 kbps mono 22050 Hz.
      const transcoded = await transcode(sourceMp3);

      // 5) Grava no cache (não bloqueia a resposta — se falhar, perdemos
      //    cache mas servimos a música).
      const meta = {
        title: asciiSafe(track.title),
        artist: asciiSafe(track.artist?.name || ''),
        duration: String(track.duration ?? 30),
      };
      if (env.MUSIC) {
        ctx.waitUntil(
          env.MUSIC.put(cacheKey, transcoded, {
            httpMetadata: { contentType: 'audio/mpeg' },
            customMetadata: meta,
          }).catch((e) => console.error('R2 put failed:', e)),
        );
      }

      return serveMp3(transcoded, meta, maxKb, /*cache=*/'MISS');
    } catch (e) {
      return jsonErr(500, `transcode error: ${e?.message || e}`);
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

  // Truncamento opcional. body pode ser ReadableStream (R2) ou Uint8Array
  // (transcode fresco). Materializamos pra Uint8Array só se vamos cortar.
  if (maxKb > 0) {
    const limit = maxKb * 1024;
    if (body instanceof Uint8Array) {
      const out = body.byteLength > limit ? body.subarray(0, limit) : body;
      return new Response(out, { headers });
    }
    // body é stream — materializa, corta, devolve.
    return materializeAndSlice(body, limit, headers);
  }

  return new Response(body, { headers });
}

async function materializeAndSlice(stream, limit, headers) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  reader.cancel().catch(() => {});
  let assembled = new Uint8Array(Math.min(total, limit));
  let off = 0;
  for (const c of chunks) {
    if (off >= limit) break;
    const take = Math.min(c.byteLength, limit - off);
    assembled.set(c.subarray(0, take), off);
    off += take;
  }
  return new Response(assembled.subarray(0, off), { headers });
}

// ---------- transcoder pipeline ----------

let _decoderPromise = null;
async function getDecoder() {
  if (!_decoderPromise) {
    _decoderPromise = (async () => {
      const dec = new MPEGDecoder();
      await dec.ready;
      return dec;
    })();
  }
  return _decoderPromise;
}

async function transcode(mp3Bytes) {
  // mpg123-decoder: dec.decode(uint8) → { channelData: Float32Array[], sampleRate, samplesDecoded }
  // Precisa de uma instância "fresca" por arquivo pra resetar estado interno.
  const dec = new MPEGDecoder();
  await dec.ready;
  let decoded;
  try {
    decoded = dec.decode(mp3Bytes);
  } finally {
    dec.free();
  }

  const { channelData, sampleRate } = decoded;
  if (!channelData?.length) throw new Error('decode returned no audio');
  const left = channelData[0];
  const right = channelData[1] || channelData[0];

  // Downmix stereo → mono + decimate pro target 22050 Hz.
  const mono22k = downmixAndDecimate(left, right, sampleRate, 22050);

  // Encode MP3 mono 64 kbps 22050 Hz.
  return encodeMp3Mono(mono22k, 22050, 64);
}

// Conversor barato: downmix L+R/2 e decimate por inteiro mais próximo do
// ratio (44100→22050 = 2). Pra preview de 30 s vocal o aliasing de uma
// média móvel é praticamente imperceptível; troque por sinc se incomodar.
function downmixAndDecimate(left, right, srcRate, dstRate) {
  if (left.length !== right.length) {
    const n = Math.min(left.length, right.length);
    left = left.subarray(0, n);
    right = right.subarray(0, n);
  }
  const ratio = Math.max(1, Math.round(srcRate / dstRate));
  const outLen = Math.floor(left.length / ratio);
  const out = new Int16Array(outLen);
  const inv = 1 / ratio;
  for (let i = 0; i < outLen; i++) {
    const base = i * ratio;
    let sum = 0;
    for (let k = 0; k < ratio; k++) {
      sum += (left[base + k] + right[base + k]) * 0.5;
    }
    let v = (sum * inv) * 32767;
    if (v < -32768) v = -32768;
    else if (v > 32767) v = 32767;
    out[i] = v;
  }
  return out;
}

function encodeMp3Mono(samples, sampleRate, kbps) {
  const enc = new lamejs.Mp3Encoder(/*channels=*/1, sampleRate, kbps);
  const blockSize = 1152; // múltiplo do MP3 frame
  const chunks = [];
  let total = 0;
  for (let i = 0; i < samples.length; i += blockSize) {
    const slice = samples.subarray(i, Math.min(i + blockSize, samples.length));
    const buf = enc.encodeBuffer(slice);
    if (buf && buf.length > 0) {
      chunks.push(buf);
      total += buf.length;
    }
  }
  const tail = enc.flush();
  if (tail && tail.length > 0) {
    chunks.push(tail);
    total += tail.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
