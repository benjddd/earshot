import './style.css';
import { RUNTIME_PROMPT, MODEL_ID, EFFORT } from '../shared/runtime-prompt.js';

// ---------- fixed things, in one place ----------

// Verify tolerance, the one constant. A value matches when it is within the larger of
// ABS units or REL of the record's value. Measured by the scout's proof (BOARD/DATA.md, 18:29).
const VERIFY_TOLERANCE = { abs: 3, rel: 0.05 };
const TOLERANCE_TEXT = `within ${VERIFY_TOLERANCE.abs} units or ${VERIFY_TOLERANCE.rel * 100}%, whichever is larger`;

const WITHHELD_URL = '/withheld/earshot-data.json';
const WITHHELD_NAME = 'earshot-data.json';
const CALL_TIMEOUT_MS = 45000;
const MAX_EDGE = 2000;
const MAX_BASE64 = 4000000;

// Sound rules (BOARD/reports/conductor-fix-sound.md). One place for every number.
const SOUND = {
  low: 220, high: 880,       // 2. pitch between 220 and 880 Hz, logarithmic map
  lowpass: 2000,             // 1. sine through a low-pass near 2 kHz
  master: 0.2,               // 3. master gain at most 0.2, compressor last
  fadeIn: 0.03,              // 4. fade in at least 25 ms
  fadeOut: 0.12,             // 4. fade out at least 120 ms
  chartSeconds: 3.6,         // 6. the whole chart in 3 to 4 s of tone, whatever the number of points
  seriesGap: 0.6,            // 8. 600 ms of silence between two series
  stepNote: 0.2,             // 9. one soft note of about 200 ms
  stepGap: 0.15,             // 9. then a 150 ms gap, then the value spoken
  headlineGap: 0.4,          // 12. headline, 400 ms of silence, then the melody
  speechRate: 1.0,           // 17. speech rate 0.95 to 1.0
  seriesSlot: 0.3,           // one series alone (trend, both readings): seconds per point
};

// Prepared inputs. The Sample is one record: the image, the stored reading by this model and the stored
// reading by the previous model. Swapping in a phone photo and its captures is a change to that file only.
const PREPARED = {
  sample: { record: '/prepared/sample.json' },
  broken: { id: 'chart3-patched', src: '/samples/chart3-patched.png', label: 'Built to fail: Earshot chart 3 with a patch drawn over the series. Clean image, not a photo.' },
};

const FIND_OUT = 'To find out: supply a sharper image of the same chart without glare, or ask the sender for the data behind it.';

// ---------- elements ----------

const $ = (id) => document.getElementById(id);
const el = {
  page: $('page'), statement: $('statement'), statement2: $('statement2'), figure: $('figure'), img: $('chart-img'),
  video: $('camera-video'), caption: $('img-caption'), tableWrap: $('table-wrap'), tCaption: $('values-caption'),
  tHead: $('values-head'), tBody: $('values-body'), status: $('status'), statusVerify: $('status-verify'),
  live: $('live'), claim: $('claim'), file: $('file-input'), pick: $('btn-pick'), sample: $('btn-sample'),
  brk: $('btn-break'), camera: $('btn-camera'), play: $('btn-play'), both: $('btn-both'), verify: $('btn-verify'),
  again: $('btn-again'), prompt: $('btn-prompt'), sheet: $('prompt-sheet'), sheetClose: $('btn-prompt-close'),
  sheetTitle: $('prompt-sheet-title'), sheetText: $('prompt-sheet-text'), keys: $('keys'),
};

const state = {
  runId: 0, seq: 0, image: null, label: '', preparedId: null, table: null, seconds: 0, verify: null,
  muted: false, stream: null, timers: [], voices: [], playResolve: null, soundUntil: 0,
  record: null, old: null, showOld: false,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- speech and the live region ----------

function announce(text) {
  el.live.textContent = '';
  setTimeout(() => { el.live.textContent = text; }, 40);
}

function stopSpeech() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

// The built-in voice (unless muted). Any speech still running is cancelled first: nothing queues.
function speakOnly(text) {
  return new Promise((resolve) => {
    if (state.muted || !('speechSynthesis' in window)) { resolve(); return; }
    stopSpeech();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = SOUND.speechRate;
    const guard = setTimeout(resolve, 2500 + text.length * 90);
    const done = () => { clearTimeout(guard); resolve(); };
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  });
}

// Speaks and writes the same text to the live region. At most two short sentences per action.
function say(text) {
  announce(text);
  return speakOnly(text);
}

// ---------- sound: one soft voice ----------

let audioCtx = null;
let bus = null;
function audio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    const lowpass = audioCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = SOUND.lowpass;
    const master = audioCtx.createGain();
    master.gain.value = SOUND.master;
    const compressor = audioCtx.createDynamicsCompressor();
    lowpass.connect(master).connect(compressor).connect(audioCtx.destination); // compressor last
    bus = lowpass;
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// Unlock audio on the first key or click, so sound can start when the reading returns.
window.addEventListener('keydown', audio, { capture: true });
window.addEventListener('pointerdown', audio, { capture: true });

function newVoice(ctx) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  gain.gain.value = 0;
  osc.connect(gain).connect(bus);
  const v = { osc, gain };
  state.voices.push(v);
  return v;
}

// A tone never starts or stops at full volume: up over fadeIn, down over fadeOut.
function envelope(gain, from, to, peak = 1) {
  const end = Math.max(to, from + SOUND.fadeIn + SOUND.fadeOut + 0.02);
  gain.setValueAtTime(0, from);
  gain.linearRampToValueAtTime(peak, from + SOUND.fadeIn);
  gain.setValueAtTime(peak, end - SOUND.fadeOut);
  gain.linearRampToValueAtTime(0, end);
  return end;
}

function scaleNow() {
  const t = state.table;
  if (!state.showOld || !state.old) return t;
  const olds = state.old.flat().filter((v) => v !== null);
  return { min: Math.min(t.min, ...olds), max: Math.max(t.max, ...olds), log: t.log }; // one pitch map for both readings
}

function pitchFor(value, scale) {
  const { min, max, log } = scale;
  let f = 0.5;
  if (max > min) {
    f = log && min > 0 ? (Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (value - min) / (max - min);
  }
  return SOUND.low * Math.pow(SOUND.high / SOUND.low, Math.min(1, Math.max(0, f)));
}

function clearSounding() {
  document.querySelectorAll('.cell.sounding').forEach((c) => c.classList.remove('sounding', 'sounding-old'));
}

// Stops every tone at once, with a short fade so that stopping does not click.
function stopSound() {
  for (const t of state.timers) clearTimeout(t);
  state.timers = [];
  if (audioCtx) {
    const now = audioCtx.currentTime;
    for (const v of state.voices) {
      try {
        if (v.gain.gain.cancelAndHoldAtTime) v.gain.gain.cancelAndHoldAtTime(now); else v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0, now, 0.02);
        v.osc.stop(now + 0.15);
      } catch { /* already stopped */ }
    }
  }
  state.voices = [];
  state.soundUntil = 0;
  clearSounding();
  if (state.playResolve) { const r = state.playResolve; state.playResolve = null; r(); }
}

// Every action by the user starts here: whatever is sounding or speaking stops, and any sequence
// still running (headline, melody, summary) is abandoned. Nothing stacks.
function act() {
  state.seq += 1;
  stopSound();
  stopSpeech();
  return state.seq;
}
const alive = (seq) => seq === state.seq;

// One continuous voice that glides from point to point. parts: [{ si, values }], one per series.
// A missing value is a short silence. 600 ms of silence between two series.
function glide(parts, slot, old = false) {
  stopSound();
  const ctx = audio();
  const scale = scaleNow();
  return new Promise((resolve) => {
    state.playResolve = resolve;
    const start = ctx ? ctx.currentTime + 0.05 : 0;
    const v = ctx ? newVoice(ctx) : null;
    let t = 0;
    let busy = 0;
    parts.forEach((part, k) => {
      if (k > 0) t = Math.max(t, busy) + SOUND.seriesGap;
      const base = t;
      part.values.forEach((val, pi) => {
        state.timers.push(setTimeout(() => {
          clearSounding();
          const c = cellAt(part.si, pi);
          if (c) c.classList.add('sounding', ...(old ? ['sounding-old'] : []));
          if (pi === 0 && part.label) el.status.textContent = part.label;
        }, (base + pi * slot) * 1000 + 50));
      });
      if (v) {
        let i = 0;
        while (i < part.values.length) {
          if (part.values[i] === null) { i += 1; continue; }
          let j = i;
          while (j + 1 < part.values.length && part.values[j + 1] !== null) j += 1;
          const a = Math.max(base + i * slot, busy + 0.02);
          for (let n = i; n <= j; n += 1) {
            const f = pitchFor(part.values[n], scale);
            const at = Math.max(a, base + n * slot);
            if (n === i) v.osc.frequency.setValueAtTime(f, start + at);
            else v.osc.frequency.exponentialRampToValueAtTime(f, start + at);
            if (n < j) v.osc.frequency.setValueAtTime(f, start + at + slot * 0.4); // hold, then glide to the next point
          }
          busy = envelope(v.gain.gain, start + a, start + base + (j + 1) * slot) - start;
          i = j + 1;
        }
      }
      t = base + part.values.length * slot;
    });
    const total = Math.max(t, busy) + 0.05;
    if (v) v.osc.start(start);
    if (v) v.osc.stop(start + total + 0.1);
    state.soundUntil = performance.now() + total * 1000;
    state.timers.push(setTimeout(() => {
      clearSounding();
      state.voices = state.voices.filter((x) => x !== v);
      state.playResolve = null;
      resolve();
    }, total * 1000 + 80));
  });
}

// The whole chart, in 3 to 4 seconds of tone whatever the number of points.
function playChart() {
  const t = state.table;
  if (!t || !t.count) return Promise.resolve();
  const points = t.count + t.missing;
  const slot = SOUND.chartSeconds / points;
  const parts = t.series.map((s, si) => ({
    si, values: s.points.map((p) => p.value), label: `Playing series ${si + 1} of ${t.series.length}: ${s.name}.`,
  }));
  return glide(parts, slot);
}

// Stepping: one soft note of about 200 ms.
function softNote(value) {
  const ctx = audio();
  if (!ctx || value === null) return;
  const v = newVoice(ctx);
  const at = ctx.currentTime + 0.01;
  v.osc.frequency.value = pitchFor(value, scaleNow());
  envelope(v.gain.gain, at, at + SOUND.stepNote, 0.8);
  v.osc.start(at);
  v.osc.stop(at + SOUND.stepNote + 0.1);
  state.soundUntil = performance.now() + SOUND.stepNote * 1000;
}

// One soft two-note sign: when a reading starts (rising from low) and when it is ready (rising, higher).
function sign(kind) {
  const ctx = audio();
  if (!ctx) return Promise.resolve();
  const notes = kind === 'ready' ? [523.25, 659.25] : [329.63, 392.0];
  const v = newVoice(ctx);
  const at = ctx.currentTime + 0.01;
  const len = 0.19;
  v.osc.frequency.setValueAtTime(notes[0], at);
  v.osc.frequency.setValueAtTime(notes[1], at + len + 0.01);
  envelope(v.gain.gain, at, at + len, 0.5);
  envelope(v.gain.gain, at + len + 0.02, at + 2 * len + 0.02, 0.5);
  v.osc.start(at);
  v.osc.stop(at + 2 * len + 0.15);
  const total = 2 * len + 0.1;
  state.soundUntil = performance.now() + total * 1000;
  return wait(total * 1000);
}

// ---------- image in ----------

async function toJpegBase64(source) {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let dataUrl = '';
  for (const q of [0.9, 0.8, 0.65, 0.5, 0.35]) {
    dataUrl = canvas.toDataURL('image/jpeg', q);
    if (dataUrl.length - 23 < MAX_BASE64) break;
  }
  return dataUrl;
}

async function supply(source, label, preparedId = null) {
  stopCamera();
  let dataUrl;
  try {
    dataUrl = await toJpegBase64(source);
  } catch {
    fail('Not read: that file is not an image. Nothing is shown. Supply a chart image.', 'Not read: that file is not an image. Supply a chart image.');
    return;
  }
  state.image = dataUrl;
  state.label = label;
  state.preparedId = preparedId;
  el.img.src = dataUrl;
  el.img.hidden = false;
  el.img.alt = 'The chart image supplied. Its values are in the table.';
  el.caption.textContent = label;
  el.figure.hidden = false;
  run();
}

async function supplyPrepared(name) {
  let p = PREPARED[name];
  try {
    if (p.record) {
      const rec = await (await fetch(p.record)).json();
      state.record = rec;
      p = { id: rec.id, src: rec.image, label: rec.label };
    }
    const blob = await (await fetch(p.src)).blob();
    await supply(blob, p.label, p.id);
  } catch {
    fail('Not read: the prepared image did not load. Nothing is shown. Press the button again.', 'Not read: the prepared image did not load. Press the button again.');
  }
}

function firstImage(list) {
  for (const f of list || []) if (f && f.type && f.type.startsWith('image/')) return f;
  return null;
}

// ---------- camera ----------

async function toggleCamera() {
  if (state.stream) {
    const v = el.video;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    stopCamera();
    if (blob) supply(blob, 'Photo taken with the camera.');
    return;
  }
  act();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } } });
  } catch {
    el.status.textContent = 'Camera not available. Nothing changed. Paste, choose or drop an image.';
    say('Camera not available. Paste, choose or drop an image.');
    return;
  }
  el.figure.hidden = false;
  el.img.hidden = true;
  el.video.hidden = false;
  el.video.srcObject = state.stream;
  await el.video.play().catch(() => {});
  el.caption.textContent = 'Camera preview. Point it at the chart.';
  el.camera.textContent = 'Take photo';
  say('Camera on. Point it at the chart and press Take photo.');
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  el.video.hidden = true;
  el.video.srcObject = null;
  el.camera.textContent = 'Use camera';
}

// ---------- the model call ----------

function resetResult() {
  act();
  state.table = null;
  state.verify = null;
  state.old = null;
  state.showOld = false;
  el.tableWrap.hidden = true;
  el.tHead.textContent = '';
  el.tBody.textContent = '';
  el.claim.hidden = true;
  el.claim.textContent = '';
  el.statusVerify.hidden = true;
  el.statusVerify.textContent = '';
  el.play.disabled = true;
  el.both.disabled = true;
  el.verify.disabled = true;
  el.statement.className = 'statement';
  el.statement2.hidden = true;
  el.statement2.textContent = '';
  el.tableWrap.parentElement.classList.remove('comparing');
}

function fail(shown, spoken) {
  resetResult();
  el.statement.textContent = 'Not read';
  el.status.textContent = shown;
  el.again.disabled = !state.image;
  say(spoken);
}

// The comparison exists only for the exact prepared input, never by title.
function canCompare() {
  return Boolean(state.record && state.preparedId === state.record.id && state.record.previous && state.table && state.table.count);
}

async function run() {
  if (!state.image) return;
  const runId = ++state.runId;
  resetResult();
  el.again.disabled = true;
  el.statement.textContent = 'Reading';
  const started = performance.now();
  const tick = () => { el.status.textContent = `Reading the chart. ${Math.round((performance.now() - started) / 1000)} s so far.`; };
  tick();
  const ticker = setInterval(tick, 1000);
  announce('Reading the chart.');
  sign('start');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let payload = null;
  try {
    const res = await fetch('/api/read-chart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: state.image.slice(state.image.indexOf(',') + 1) }),
      signal: controller.signal,
    });
    payload = await res.json();
  } catch {
    payload = null;
  }
  clearTimeout(timeout);
  clearInterval(ticker);
  if (runId !== state.runId) return;

  if (!payload || !payload.ok || !payload.reading) {
    fail('Not read: the call failed. Nothing is shown. Press Run again.', 'Not read: the call failed. Press Run again.');
    return;
  }
  state.seconds = (performance.now() - started) / 1000;
  const table = normalise(payload.reading);
  state.table = table;
  el.again.disabled = false;
  const seq = act();

  if (!table.count) {
    await sign('ready');
    if (!alive(seq)) return;
    showNotKnown(table.unreadable || 'no value could be read from this image');
    return;
  }

  renderTable(table);
  el.play.disabled = false;
  el.verify.disabled = false;
  el.both.disabled = !canCompare();
  el.statement.textContent = table.missing ? `${table.missing} not known` : `${table.count} values`;
  if (table.missing) {
    el.statement.className = 'statement statement-unknown';
    el.claim.hidden = false;
    el.claim.textContent = '';
    el.claim.append(partialNotKnown());
  }
  showStatus();

  // Ready sign, one headline, 400 ms of silence, the melody, then one closing sentence. Never speech over a tone.
  await sign('ready');
  if (!alive(seq)) return;
  const secs = `${state.seconds.toFixed(1)} seconds`;
  await say(table.missing
    ? `${table.count} values read, ${table.missing} not known: ${table.reason}.`
    : `${MODEL_ID} read ${table.count} values in ${secs}.`);
  if (!alive(seq)) return;
  await wait(SOUND.headlineGap * 1000);
  if (!alive(seq)) return;
  await playChart();
  if (!alive(seq)) return; // the user took over
  showStatus();
  if (table.missing) say(FIND_OUT);
  else showSummary();
}

function statusText() {
  const t = state.table;
  const base = `${MODEL_ID} read ${t.count} values in ${state.seconds.toFixed(1)} s.`;
  return t.missing ? `${base} ${t.missing} not known.` : base;
}

function showStatus() {
  if (state.table && state.table.count) el.status.textContent = statusText();
}

function tidy(text) {
  return String(text || '').trim().replace(/[.\s]+$/, '');
}

function cap(text) {
  const s = tidy(text);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function notKnownText(what) {
  return `Not known: ${tidy(what)}. ${FIND_OUT}`;
}

function partialText() {
  const t = state.table;
  return notKnownText(`${t.missing} of ${t.count + t.missing} values. Reason given: ${cap(t.reason)}`);
}

function pointNotKnown(p) {
  return notKnownText(`this value. Reason given: ${cap(p.reason || state.table.reason)}`);
}

function para(cls, text) {
  const p = document.createElement('p');
  if (cls) p.className = cls;
  p.textContent = text;
  return p;
}

function partialNotKnown() {
  return para('claim-unknown', partialText());
}

function showNotKnown(reason) {
  const text = notKnownText(reason);
  el.statement.textContent = 'Not known';
  el.statement.className = 'statement statement-unknown';
  el.status.textContent = `${MODEL_ID} read 0 values in ${state.seconds.toFixed(1)} s.`;
  el.claim.hidden = false;
  el.claim.textContent = '';
  el.claim.append(para('claim-unknown', text));
  say(text);
}

// ---------- the reading as a table ----------

function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, '')))) return Number(v.replace(/,/g, ''));
  return null;
}

function normalise(reading) {
  const series = [];
  const reasons = [];
  for (const s of Array.isArray(reading.series) ? reading.series : []) {
    const points = [];
    for (const p of Array.isArray(s && s.points) ? s.points : []) {
      const value = toNumber(p && p.value);
      if (value === null && p && p.reason) reasons.push(String(p.reason));
      points.push({ x: String(p && p.x !== undefined && p.x !== null ? p.x : ''), value, reason: p && p.reason ? String(p.reason) : '' });
    }
    series.push({ name: String((s && s.name) || `Series ${series.length + 1}`), points });
  }
  const xs = [];
  for (const s of series) for (const p of s.points) if (!xs.includes(p.x)) xs.push(p.x);
  const values = series.flatMap((s) => s.points.map((p) => p.value)).filter((v) => v !== null);
  const total = series.reduce((n, s) => n + s.points.length, 0);
  const unreadable = reading.unreadable && String(reading.unreadable).toLowerCase() !== 'null' ? String(reading.unreadable) : '';
  return {
    title: reading.title ? String(reading.title) : '',
    kind: reading.kind ? String(reading.kind) : 'chart',
    unit: reading.unit ? String(reading.unit) : '',
    log: String(reading.y_scale || '').toLowerCase().includes('log'),
    series, xs, count: values.length, missing: total - values.length,
    min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 0,
    reason: tidy(reasons[0] || 'the model gave no reason'), unreadable,
  };
}

const fmt = (n) => n.toLocaleString('en-GB', { maximumFractionDigits: 2 });
const fmtOrNot = (v) => (v === null ? 'not known' : fmt(v));

function cellAt(si, pi) {
  return el.tBody.querySelector(`.cell[data-s="${si}"][data-p="${pi}"]`);
}

function renderTable(table) {
  el.tCaption.textContent = `${table.title || 'Untitled chart'}${table.unit ? `, in ${table.unit}` : ''}. Read by ${MODEL_ID}.`;
  el.tHead.textContent = '';
  el.tBody.textContent = '';
  const hr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.scope = 'col';
  corner.textContent = 'Series';
  hr.append(corner);
  for (const x of table.xs) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = x;
    hr.append(th);
  }
  el.tHead.append(hr);
  let first = true;
  table.series.forEach((s, si) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = s.name;
    tr.append(th);
    for (const x of table.xs) {
      const td = document.createElement('td');
      const pi = s.points.findIndex((p) => p.x === x);
      if (pi >= 0) {
        const p = s.points[pi];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = p.value === null ? 'cell cell-unknown' : 'cell';
        b.dataset.s = si;
        b.dataset.p = pi;
        b.tabIndex = first ? 0 : -1;
        first = false;
        paintCell(b, p, null);
        td.append(b);
      }
      tr.append(td);
    }
    el.tBody.append(tr);
  });
  el.tableWrap.hidden = false;
  el.tableWrap.parentElement.classList.toggle('wide', table.xs.length > 4);
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

// Two readings differ at a point when they are further apart than the Verify tolerance, or one is missing.
function differs(a, b) {
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) > Math.max(VERIFY_TOLERANCE.abs, VERIFY_TOLERANCE.rel * Math.max(Math.abs(a), Math.abs(b)));
}

// A cell shows the model's value; after Verify it also shows the outcome as colour, shape and word.
// With both readings showing, the previous model's value sits under it, and a differing point is outlined.
function paintCell(b, p, outcome) {
  b.textContent = '';
  b.classList.remove('is-match', 'is-mismatch', 'is-unknown', 'differs');
  paintMain(b, p, outcome);
  if (!state.showOld || !state.old) return;
  const si = Number(b.dataset.s), pi = Number(b.dataset.p);
  const ov = state.old[si][pi];
  const line = span('old', '');
  line.append(span('old-tag', '5.1'), span('sr-only', ` ${state.record.previous.model} read `));
  const oo = state.verify && state.verify.old && state.verify.old.outcomes[si][pi];
  if (ov === null) line.append(span('unknown-word', 'Not known'));
  else if (oo && oo.kind === 'match') { line.classList.add('old-match'); line.append(span('tri', ''), span('val', fmt(ov)), span('sr-only', ' Match')); }
  else if (oo && oo.kind === 'mismatch') { line.classList.add('old-mismatch'); line.append(span('val struck', fmt(ov)), span('block', 'Mismatch')); }
  else line.append(span('val', fmt(ov)));
  b.append(line);
  if (differs(p.value, ov)) {
    b.classList.add('differs');
    b.append(span('sr-only', ' The two readings differ here.'));
  }
}

function paintMain(b, p, outcome) {
  if (p.value === null) {
    b.append(span('unknown-word', 'Not known'), span('sr-only', `: ${pointNotKnown(p).slice(11)}`));
    return;
  }
  if (!outcome) {
    b.append(span('val', fmt(p.value)));
    return;
  }
  if (outcome.kind === 'match') {
    b.classList.add('is-match');
    b.append(span('tri', ''), span('val', fmt(p.value)), span('sr-only', ' Match'));
  } else if (outcome.kind === 'mismatch') {
    b.classList.add('is-mismatch');
    b.append(span('val struck', fmt(p.value)), span('rec', fmt(outcome.record)), span('block', `Mismatch ${fmt(Math.abs(outcome.diff))}`));
  } else {
    b.classList.add('is-unknown');
    b.append(span('val', fmt(p.value)), span('unknown-word', 'Not known'));
  }
}

function repaintAll() {
  const t = state.table;
  t.series.forEach((s, si) => s.points.forEach((p, pi) => {
    const c = cellAt(si, pi);
    if (c) paintCell(c, p, state.verify ? state.verify.outcomes[si][pi] : null);
  }));
}

function mark(kind, word) {
  const wrap = document.createElement('span');
  wrap.className = 'mark-line';
  wrap.append(span(`mark mark-${kind}`, ''), document.createTextNode(` ${word}`));
  return wrap;
}

function showClaim(...nodes) {
  el.claim.hidden = false;
  el.claim.textContent = '';
  el.claim.append(...nodes);
}

function select(si, pi) {
  document.querySelectorAll('.cell.selected').forEach((c) => c.classList.remove('selected'));
  const c = cellAt(si, pi);
  if (c) c.classList.add('selected');
}

// ---------- explore by keyboard ----------
// One tab stop for the table. Left and Right step through a series point by point, with a soft note and
// the spoken value. Up and Down switch series (or panel, or row). Home and End jump to the ends of the
// series. T gives the trend of the series. Enter names the source of a value.

el.tBody.addEventListener('keydown', (e) => {
  const b = e.target.closest('.cell');
  if (!b || e.altKey || e.metaKey) return;
  const t = state.table;
  const si = Number(b.dataset.s);
  const pi = Number(b.dataset.p);
  const k = e.key;
  if (k.toLowerCase() === 't' && !e.ctrlKey) { e.preventDefault(); trend(si); return; }
  if (e.ctrlKey) return;
  let ns = si, np = pi;
  if (k === 'ArrowRight') np = pi + 1;
  else if (k === 'ArrowLeft') np = pi - 1;
  else if (k === 'ArrowDown') ns = si + 1;
  else if (k === 'ArrowUp') ns = si - 1;
  else if (k === 'Home') np = 0;
  else if (k === 'End') np = t.series[si].points.length - 1;
  else return;
  e.preventDefault();
  if (ns < 0 || ns >= t.series.length) { act(); say(ns < 0 ? 'First series.' : 'Last series.'); return; }
  if (ns !== si) {
    const same = t.series[ns].points.findIndex((p) => p.x === t.series[si].points[pi].x);
    np = same >= 0 ? same : Math.min(pi, t.series[ns].points.length - 1);
  }
  if (np < 0 || np >= t.series[ns].points.length) { act(); say(np < 0 ? 'Start of the series.' : 'End of the series.'); return; }
  const next = cellAt(ns, np);
  if (!next) return;
  b.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
  stepTo(ns, np, ns !== si);
});

el.tBody.addEventListener('click', (e) => {
  const b = e.target.closest('.cell');
  if (b) selectClaim(Number(b.dataset.s), Number(b.dataset.p));
});

// One step: a soft note, a 150 ms gap, then the value spoken. A new key cancels the note and the speech.
function stepTo(si, pi, nameSeries) {
  const seq = act();
  const t = state.table;
  const s = t.series[si];
  const p = s.points[pi];
  softNote(p.value);
  select(si, pi);
  const v = para(p.value === null ? 'claim-unknown' : 'claim-value', p.value === null ? 'Not known. No note is played. Enter gives the reason.' : fmt(p.value));
  if (p.value !== null && t.unit) v.append(span('claim-unit', ` ${t.unit}`));
  const nodes = [para('claim-head', `${s.name}, ${p.x}`), v];
  let text = nameSeries ? `${s.name}, ${p.x}: ${fmtOrNot(p.value)}.` : `${p.x}: ${fmtOrNot(p.value)}.`;
  if (state.showOld && state.old) {
    const ov = state.old[si][pi];
    const prev = state.record.previous;
    const diff = differs(p.value, ov);
    nodes.push(para(diff ? 'claim-diff' : '', `${prev.model}, captured ${prev.captured} tonight: ${fmtOrNot(ov)}.${diff ? ' The two readings differ here.' : ''}`));
    if (diff) text = `${text.slice(0, -1)}, ${prev.model} ${fmtOrNot(ov)}.`;
  }
  showClaim(...nodes);
  announce(text);
  state.timers.push(setTimeout(() => { if (alive(seq)) speakOnly(text); }, (p.value === null ? 0 : SOUND.stepNote + SOUND.stepGap) * 1000));
}

// Enter on a value: its source, shown and spoken.
function selectClaim(si, pi) {
  act();
  const t = state.table;
  const s = t.series[si];
  const p = s.points[pi];
  select(si, pi);
  const nodes = [para('claim-head', `${s.name}, ${p.x}`)];
  let text;
  if (p.value === null) {
    text = pointNotKnown(p);
    nodes.push(para('claim-unknown', text));
  } else {
    const v = para('claim-value', fmt(p.value));
    if (t.unit) v.append(span('claim-unit', ` ${t.unit}`));
    const src = document.createElement('p');
    src.append(mark('read', `Read from the image by ${MODEL_ID}, series ${s.name}, point ${p.x}.`));
    nodes.push(v, src);
    text = `${s.name}, ${p.x}: ${fmt(p.value)}, read from the image.`;
    const o = state.verify && state.verify.outcomes[si] && state.verify.outcomes[si][pi];
    if (o) {
      let vt;
      if (o.kind === 'match') vt = `Match: model ${fmt(p.value)}, record ${fmt(o.record)}.`;
      else if (o.kind === 'mismatch') vt = `Mismatch: model ${fmt(p.value)}, record ${fmt(o.record)}, difference ${fmt(Math.abs(o.diff))}.`;
      else vt = 'Not known: no record of this value.';
      nodes.push(para(`claim-verify claim-${o.kind}`, `${vt} Record: ${state.verify.recordName}.`));
      text += ` ${vt}`;
    }
    if (state.showOld && state.old) {
      const ov = state.old[si][pi];
      const prev = state.record.previous;
      const oo = state.verify && state.verify.old && state.verify.old.outcomes[si][pi];
      let ot = `${prev.model}, captured ${prev.captured} tonight: ${fmtOrNot(ov)}.`;
      if (oo && oo.kind === 'match') ot += ` Match with record ${fmt(oo.record)}.`;
      if (oo && oo.kind === 'mismatch') ot += ` Mismatch with record ${fmt(oo.record)}, difference ${fmt(Math.abs(oo.diff))}.`;
      nodes.push(para(oo && oo.kind === 'match' ? 'claim-match' : 'claim-diff', ot));
    }
  }
  showClaim(...nodes);
  say(text);
}

function trendText(si) {
  const s = state.table.series[si];
  const pts = s.points.filter((p) => p.value !== null);
  if (pts.length < 2) return `Not known: the trend of ${s.name}, with fewer than 2 values read. ${FIND_OUT}`;
  const first = pts[0], last = pts[pts.length - 1];
  const hi = pts.reduce((a, p) => (p.value > a.value ? p : a));
  const lo = pts.reduce((a, p) => (p.value < a.value ? p : a));
  const d = last.value - first.value;
  const move = d > 0 ? `rises by ${fmt(d)}` : d < 0 ? `falls by ${fmt(-d)}` : 'ends level';
  return `${s.name} ${move}, from ${fmt(first.value)} at ${first.x} to ${fmt(last.value)} at ${last.x}. Highest ${fmt(hi.value)} at ${hi.x}, lowest ${fmt(lo.value)} at ${lo.x}.`;
}

// T: the series as one glide, then its trend in two sentences, by plain code from the table.
async function trend(si) {
  const seq = act();
  const s = state.table.series[si];
  const text = trendText(si);
  const src = document.createElement('p');
  src.append(mark('derived', 'Derived by plain code from the table.'));
  showClaim(para('claim-head', `Trend, ${s.name}`), para('', text), src);
  announce(text);
  await glide([{ si, values: s.points.map((p) => p.value), label: `Playing ${s.name}.` }], SOUND.seriesSlot);
  if (!alive(seq)) return;
  showStatus();
  speakOnly(text);
}

// ---------- the summary, by plain code from the table: one sentence ----------

function summaryText() {
  const t = state.table;
  let lo = null, hi = null;
  t.series.forEach((s) => s.points.forEach((p) => {
    if (p.value === null) return;
    if (!lo || p.value < lo.value) lo = { ...p, name: s.name };
    if (!hi || p.value > hi.value) hi = { ...p, name: s.name };
  }));
  const kind = t.kind.charAt(0).toUpperCase() + t.kind.slice(1);
  return `${kind}, ${t.series.length} series${t.unit ? `, in ${t.unit}` : ''}: lowest ${fmt(lo.value)} at ${lo.name}, ${lo.x}; highest ${fmt(hi.value)} at ${hi.name}, ${hi.x}.`;
}

function showSummary() {
  const text = summaryText();
  const src = document.createElement('p');
  src.append(mark('derived', 'Derived by plain code from the table.'));
  showClaim(para('claim-head', 'Summary'), para('', text), src);
  return say(text);
}

async function replay() {
  if (!state.table || !state.table.count) return;
  const seq = act();
  announce('Playing the chart as pitch. Higher value, higher note.');
  await playChart();
  if (alive(seq)) showStatus();
}

// ---------- both melodies: this model's reading and the previous model's, same input, one pitch map ----------

function alignOld() {
  const t = state.table;
  const o = normalise(state.record.previous.reading);
  return t.series.map((s, si) => {
    const os = o.series.find((q) => key(q.name) === key(s.name)) || o.series[si];
    return s.points.map((p, pi) => {
      if (!os) return null;
      const op = os.points.find((q) => xKey(q.x) === xKey(p.x)) || os.points[pi];
      return op ? op.value : null;
    });
  });
}

async function playBoth() {
  if (!canCompare()) return;
  const seq = act();
  const t = state.table;
  const prev = state.record.previous;
  const prevLabel = `${prev.model}, captured ${prev.captured} tonight`;
  state.old = alignOld();
  state.showOld = true;
  if (state.verify) { // a Verify done before the comparison covered one reading only: clear it
    state.verify = null;
    el.statusVerify.hidden = true;
    el.statement.className = 'statement';
    el.statement.textContent = `${t.count} values`;
  }
  repaintAll();
  el.tableWrap.parentElement.classList.add('comparing');

  // Which series: the one in focus, or else the one where the two readings are furthest apart.
  const focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.cell') : null;
  let si = focused ? Number(focused.dataset.s) : -1;
  if (si < 0) {
    let worst = -1;
    t.series.forEach((s, i) => s.points.forEach((p, pi) => {
      const ov = state.old[i][pi];
      const gap = p.value === null || ov === null ? 0 : Math.abs(p.value - ov);
      if (gap > worst) { worst = gap; si = i; }
    }));
  }
  const s = t.series[si];
  const news = s.points.map((p) => p.value);
  const olds = state.old[si];
  let total = 0;
  t.series.forEach((ser, i) => ser.points.forEach((p, pi) => { if (differs(p.value, state.old[i][pi])) total += 1; }));
  const at = s.points.filter((p, pi) => differs(p.value, olds[pi]));
  const detail = s.points.map((p, pi) => (differs(p.value, olds[pi]) ? `${p.x}: ${fmtOrNot(p.value)} against ${fmtOrNot(olds[pi])}` : null)).filter(Boolean);
  const closing = at.length
    ? `In ${s.name} the two readings differ at ${at.map((p) => p.x).join(' and ')}.`
    : `In ${s.name} the two readings do not differ by more than the tolerance.`;
  const list = (vals) => vals.map(fmtOrNot).join(', ');

  showClaim(
    para('claim-head', `Both readings, ${s.name}`),
    para('', `${MODEL_ID}, live: ${list(news)}.`),
    para('', `${prevLabel}, same image, same settings: ${list(olds)}.`),
    para('claim-diff', `${closing}${detail.length ? ` ${detail.join('; ')}.` : ''} ${total} of ${t.count + t.missing} points differ in the whole chart, marked in the table.`),
    para('mark-line', `One pitch map for both. A point is marked when the readings are more than ${VERIFY_TOLERANCE.abs} units or ${VERIFY_TOLERANCE.rel * 100}% apart. Verify shows which reading matches the record.`),
  );

  // One headline, 400 ms, two glides 600 ms apart on one pitch map, then one closing sentence.
  await say(`${s.name}: ${MODEL_ID} first, then ${prev.model}.`);
  if (!alive(seq)) return;
  await wait(SOUND.headlineGap * 1000);
  if (!alive(seq)) return;
  await glide([{ si, values: news, label: `Playing ${s.name} as read by ${MODEL_ID}.` }], SOUND.seriesSlot, false);
  if (!alive(seq)) return;
  await wait(SOUND.seriesGap * 1000);
  if (!alive(seq)) return;
  await glide([{ si, values: olds, label: `Playing ${s.name} as read by ${prevLabel}.` }], SOUND.seriesSlot, true);
  if (!alive(seq)) return;
  showStatus();
  say(closing);
}

// ---------- Verify: plain code against the withheld record ----------

const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const xKey = (s) => key(s).replace(/^0+(?=\d)/, '');

function recordSeries(rec) {
  const map = rec.values || rec.panels || rec.series || {};
  const xs = (rec.cols || (Array.isArray(rec.x) ? rec.x : [])).map(String);
  return Object.entries(map).map(([name, vals]) => ({ name, xs, vals }));
}

function within(model, record) {
  return Math.abs(model - record) <= Math.max(VERIFY_TOLERANCE.abs, VERIFY_TOLERANCE.rel * Math.abs(record));
}

async function verify() {
  const t = state.table;
  if (!t || !t.count) return;
  act();
  let data = null;
  try {
    data = await (await fetch(WITHHELD_URL, { cache: 'no-store' })).json(); // fetched only here
  } catch {
    data = null;
  }
  const rec = data && Object.values(data).find((r) => r && r.title && key(t.title).includes(key(r.title)));
  if (!rec) {
    state.verify = null;
    const text = 'Not known: no withheld data for this image.';
    el.statusVerify.hidden = false;
    el.statusVerify.className = 'status status-verify';
    el.statusVerify.textContent = text;
    el.statement.textContent = 'Not known';
    el.statement.className = 'statement statement-unknown';
    say(text);
    return;
  }
  const rs = recordSeries(rec);
  const recordName = `${WITHHELD_NAME}, ${rec.title}`;

  // The same plain check for any reading: each value against the record, within the tolerance.
  const check = (valueAt) => {
    const outcomes = [];
    const counts = { match: 0, mismatch: 0, unknown: 0 };
    const misses = [];
    t.series.forEach((s, si) => {
      const sk = key(s.name);
      const r = rs.find((q) => key(q.name) === sk) || rs.find((q) => sk.startsWith(key(q.name)) || sk.includes(key(q.name)));
      outcomes[si] = s.points.map((p, pi) => {
        const value = valueAt(si, pi);
        let o;
        if (value === null || !r) o = { kind: 'unknown' };
        else {
          let xi = r.xs.findIndex((x) => xKey(x) === xKey(p.x));
          if (xi < 0 && r.xs.length === s.points.length) xi = pi;
          const record = xi >= 0 ? r.vals[xi] : undefined;
          if (typeof record !== 'number') o = { kind: 'unknown' };
          else if (within(value, record)) o = { kind: 'match', record, diff: value - record };
          else {
            o = { kind: 'mismatch', record, diff: value - record };
            misses.push(`${s.name}, ${p.x}: model ${fmt(value)}, record ${fmt(record)}`);
          }
        }
        counts[o.kind] += 1;
        return o;
      });
    });
    return { outcomes, counts, misses };
  };
  const mine = check((si, pi) => t.series[si].points[pi].value);
  const { outcomes, counts } = mine;
  const old = state.showOld && state.old ? check((si, pi) => state.old[si][pi]) : null;
  state.verify = { outcomes, counts, recordName, old };

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let n = 0;
  t.series.forEach((s, si) => s.points.forEach((p, pi) => {
    const c = cellAt(si, pi);
    if (!c) return;
    const mineNow = state.verify;
    const apply = () => { if (state.verify === mineNow) paintCell(c, p, outcomes[si][pi]); };
    if (reduce) apply(); else setTimeout(apply, n * 30);
    n += 1;
  }));

  const all = t.count + t.missing;
  const line = (c) => `${c.match} match, ${c.mismatch} mismatch, ${c.unknown} not known.`;
  const headline = (c) => (c.mismatch ? `${c.mismatch} mismatch` : c.unknown ? `${c.unknown} not known` : `${c.match} match`);
  // One spoken sentence. "Verified" is Ben's wording for this sentence.
  const short = (c) => `${c.match} of ${all} match${c.mismatch ? `, ${c.mismatch} mismatch` : ''}${c.unknown ? `, ${c.unknown} not known` : ''}`;
  el.statusVerify.hidden = false;
  el.statusVerify.className = `status status-verify ${counts.mismatch ? 'has-mismatch' : counts.unknown ? 'has-unknown' : 'all-match'}`;
  el.statusVerify.textContent = '';
  if (!counts.mismatch && !counts.unknown) el.statusVerify.append(span('tri', ''));
  el.statement.className = `statement ${counts.mismatch ? 'statement-mismatch' : counts.unknown ? 'statement-unknown' : 'statement-match'}`;
  el.statement.textContent = headline(counts);
  if (!old) {
    el.statusVerify.append(document.createTextNode(`${line(counts)} Record: ${recordName}. Tolerance: ${TOLERANCE_TEXT}.`));
    say(`Verified: ${short(counts)}.`);
    return;
  }
  // Both readings against the same record: which one matches.
  const prev = state.record.previous;
  const oc = old.counts;
  el.statusVerify.append(document.createTextNode(`${MODEL_ID}: ${line(counts)} ${prev.model}, captured ${prev.captured} tonight: ${line(oc)} Record: ${recordName}. Tolerance: ${TOLERANCE_TEXT}.`));
  el.statement.textContent = `${headline(counts)}`;
  el.statement2.hidden = false;
  el.statement2.className = `statement2 ${oc.mismatch || oc.unknown ? '' : 'statement-match'}`;
  el.statement2.textContent = `${prev.model}: ${headline(oc)}`;
  const nodes = [para('claim-head', 'Verify, both readings')];
  if (mine.misses.length) nodes.push(para('claim-diff', `${MODEL_ID} mismatch at ${mine.misses.join('; ')}.`));
  if (old.misses.length) nodes.push(para('claim-diff', `${prev.model} mismatch at ${old.misses.join('; ')}.`));
  if (!mine.misses.length && !old.misses.length) nodes.push(para('', 'No mismatch in either reading.'));
  showClaim(...nodes);
  say(`Verified: ${MODEL_ID}, ${short(counts)}; ${prev.model}, ${short(oc)}.`);
}

// ---------- Prompt sheet ----------

function openPrompt() {
  act();
  el.sheetText.textContent = RUNTIME_PROMPT;
  $('prompt-sheet-meta').textContent = `Sent on every reading with one image and nothing else. Model ${MODEL_ID}, effort ${EFFORT}. The image is redrawn in the browser first: JPEG, long edge at most ${MAX_EDGE} px, no file name, no metadata.`;
  el.page.hidden = true;
  el.sheet.hidden = false;
  el.sheetTitle.focus();
}

function closePrompt() {
  el.sheet.hidden = true;
  el.page.hidden = false;
  el.prompt.focus();
}

// ---------- wiring ----------

el.pick.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => {
  const f = firstImage(el.file.files);
  if (f) supply(f, 'Image chosen from a file.');
  el.file.value = '';
});
el.sample.addEventListener('click', () => supplyPrepared('sample'));
el.brk.addEventListener('click', () => supplyPrepared('broken'));
el.camera.addEventListener('click', toggleCamera);
el.again.addEventListener('click', run);
el.verify.addEventListener('click', verify);
el.play.addEventListener('click', replay);
el.both.addEventListener('click', playBoth);
el.prompt.addEventListener('click', openPrompt);
el.sheetClose.addEventListener('click', closePrompt);

document.addEventListener('paste', (e) => {
  const f = firstImage(e.clipboardData && e.clipboardData.files);
  if (f) { e.preventDefault(); supply(f, 'Image pasted from the clipboard.'); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = firstImage(e.dataTransfer && e.dataTransfer.files);
  if (f) supply(f, 'Image dropped on the page.');
});

function sounding() {
  return performance.now() < state.soundUntil || ('speechSynthesis' in window && window.speechSynthesis.speaking);
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') {
    if (!el.sheet.hidden) { closePrompt(); return; }
    act(); // Escape stops all sound at once
    showStatus();
    return;
  }
  if (e.key === ' ' && sounding()) { // Space stops all sound at once; when nothing sounds it presses the button as usual
    e.preventDefault();
    act();
    showStatus();
    return;
  }
  if (!el.sheet.hidden) return;
  const k = e.key.toLowerCase();
  if (k === 'p' && !el.play.disabled) { e.preventDefault(); replay(); }
  if (k === 'm') {
    e.preventDefault();
    state.muted = !state.muted;
    if (state.muted) stopSpeech();
    el.keys.textContent = `Keys: P plays the chart again. M turns the built-in voice ${state.muted ? 'on' : 'off'}. Esc or Space stops all sound. The built-in voice is ${state.muted ? 'off' : 'on'}.`;
    announce(`Built-in voice ${state.muted ? 'off' : 'on'}.`);
  }
});
