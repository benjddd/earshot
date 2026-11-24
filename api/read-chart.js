// One model call: the image and the fixed instructions in, nothing else.
// The key is read from the environment on the server side only. It is never logged or returned.
// The uploaded image is held in memory for the call only: it is not logged, written to disk or stored.
import Anthropic from '@anthropic-ai/sdk';
import { RUNTIME_PROMPT, MODEL_ID, EFFORT } from '../shared/runtime-prompt.js';

const MAX_BASE64 = 4_200_000; // about 3 MB of JPEG
const LIMIT_MB = 3;

// Per-IP rate limit, a simple in-memory sliding window.
// This is per function instance only: each instance keeps its own counts, and they are lost when it
// is recycled. It does not cover distributed abuse; a Vercel Firewall rule covers that separately.
const RATE = [
  { windowMs: 10 * 60 * 1000, max: 6 },
  { windowMs: 24 * 60 * 60 * 1000, max: 30 },
];
const hits = new Map(); // ip -> timestamps of accepted reads, newest last

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimited(ip, now = Date.now()) {
  const longest = Math.max(...RATE.map((r) => r.windowMs));
  const list = (hits.get(ip) || []).filter((t) => now - t < longest);
  const over = RATE.some((r) => list.filter((t) => now - t < r.windowMs).length >= r.max);
  if (!over) list.push(now);
  if (list.length) hits.set(ip, list); else hits.delete(ip);
  if (hits.size > 10_000) { // keep memory bounded
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= longest) hits.delete(k);
  }
  return over;
}

// Same origin only: the Origin header's host must equal the host this request was sent to.
// No domain is written here, so preview deployments work as well as the production one.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let originHost;
  try { originHost = new URL(origin).host.toLowerCase(); } catch { return false; }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  return Boolean(host) && originHost === host;
}

function isJpegBase64(image) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image)) return false;
  const head = Buffer.from(image.slice(0, 16), 'base64');
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

function isSpendLimit(err) {
  return err instanceof Anthropic.APIError && err.status === 429
    && (err.error?.error?.details?.error_code === 'enforced_spend_limit_reached' || err.errorCode === 'enforced_spend_limit_reached');
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method' });
    return;
  }
  if (!sameOrigin(req)) {
    res.status(403).json({ ok: false, error: 'origin' });
    return;
  }
  let body;
  try {
    body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
  } catch {
    body = null;
  }
  const image = body && typeof body.image === 'string' ? body.image : '';
  if (image.length > MAX_BASE64) {
    res.status(413).json({ ok: false, error: 'too_large', limit_mb: LIMIT_MB });
    return;
  }
  if (!image || !isJpegBase64(image)) {
    res.status(415).json({ ok: false, error: 'not_image' });
    return;
  }
  if (rateLimited(clientIp(req))) {
    res.status(429).json({ ok: false, error: 'rate_limited' });
    return;
  }

  const started = Date.now();
  try {
    const client = new Anthropic({ maxRetries: 0, timeout: 90_000 });
    const message = await client.messages
      .stream({
        model: MODEL_ID,
        max_tokens: 16000,
        output_config: { effort: EFFORT },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
              { type: 'text', text: RUNTIME_PROMPT },
            ],
          },
        ],
      })
      .finalMessage();

    const seconds = (Date.now() - started) / 1000;
    if (message.stop_reason !== 'end_turn') {
      res.status(502).json({ ok: false, error: 'failed', seconds });
      return;
    }
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const reading = extractJson(text);
    if (!reading || typeof reading !== 'object') {
      res.status(502).json({ ok: false, error: 'failed', seconds });
      return;
    }
    res.status(200).json({ ok: true, model: message.model, effort: EFFORT, seconds, reading });
  } catch (err) {
    // Nothing from the upstream error (status, message, stack) is returned or logged.
    if (isSpendLimit(err)) {
      res.status(503).json({ ok: false, error: 'paused' });
      return;
    }
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      res.status(504).json({ ok: false, error: 'timeout' });
      return;
    }
    res.status(502).json({ ok: false, error: 'failed' });
  }
}
