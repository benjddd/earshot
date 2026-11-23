// One model call: the image and the fixed instructions in, nothing else.
// The key is read from the environment on the server side only. It is never logged or returned.
import Anthropic from '@anthropic-ai/sdk';
import { RUNTIME_PROMPT, MODEL_ID, EFFORT } from '../shared/runtime-prompt.js';

const MAX_BASE64 = 4_200_000;

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
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const image = body && typeof body.image === 'string' ? body.image : '';
  if (!image || image.length > MAX_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200))) {
    res.status(400).json({ ok: false, error: 'image' });
    return;
  }

  const started = Date.now();
  try {
    const client = new Anthropic({ maxRetries: 0, timeout: 60_000 });
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
      res.status(502).json({ ok: false, error: 'stopped', stop_reason: message.stop_reason, seconds });
      return;
    }
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const reading = extractJson(text);
    if (!reading || typeof reading !== 'object') {
      res.status(502).json({ ok: false, error: 'malformed', seconds });
      return;
    }
    res.status(200).json({ ok: true, model: message.model, effort: EFFORT, seconds, reading });
  } catch (err) {
    const seconds = (Date.now() - started) / 1000;
    const status = err instanceof Anthropic.APIError && err.status ? err.status : 0;
    res.status(502).json({ ok: false, error: 'call', upstream_status: status, seconds });
  }
}
