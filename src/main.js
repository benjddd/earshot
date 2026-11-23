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

// Prepared inputs. Swap src and label here when the phone photos land.
const PREPARED = {
  sample: { id: 'chart2-clean', src: '/samples/chart2-clean.png', label: 'Sample: Earshot chart 2, clean image, not a photo.' },
  broken: { id: 'chart3-patched', src: '/samples/chart3-patched.png', label: 'Built to fail: Earshot chart 3 with a patch drawn over the series. Clean image, not a photo.' },
};

const FIND_OUT = 'To find out: supply a sharper image of the same chart without glare, or ask the sender for the data behind it.';

// ---------- elements ----------

const $ = (id) => document.getElementById(id);
const el = {
  page: $('page'), statement: $('statement'), figure: $('figure'), img: $('chart-img'), video: $('camera-video'),
  caption: $('img-caption'), tableWrap: $('table-wrap'), tCaption: $('values-caption'), tHead: $('values-head'),
  tBody: $('values-body'), status: $('status'), statusVerify: $('status-verify'), live: $('live'), claim: $('claim'),
  file: $('file-input'), pick: $('btn-pick'), sample: $('btn-sample'), brk: $('btn-break'), camera: $('btn-camera'),
  play: $('btn-play'), verify: $('btn-verify'), again: $('btn-again'), prompt: $('btn-prompt'),
  sheet: $('prompt-sheet'), sheetClose: $('btn-prompt-close'), sheetTitle: $('prompt-sheet-title'),
  sheetMeta: $('prompt-sheet-meta'), sheetText: $('prompt-sheet-text'), keys: $('keys'),
};

const state = {
  runId: 0, image: null, label: '', preparedId: null, table: null, seconds: 0, verify: null,
  muted: false, stream: null, timers: [], nodes: [], playResolve: null,
};

// ---------- speech and the live region ----------

function announce(text) {
  el.live.textContent = '';
  setTimeout(() => { el.live.textContent = text; }, 40);
}

function stopSpeech() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

// Speaks with the built-in voice (unless muted) and writes the same text to the live region.
function say(text) {
  announce(text);
  return speakOnly(text);
}

function speakOnly(text) {
  return new Promise((resolve) => {
    if (state.muted || !('speechSynthesis' in window)) { resolve(); return; }
    stopSpeech();
    const parts = text.match(/[^.!?]+[.!?]*/g) || [text];
    let left = parts.length;
    const guard = setTimeout(resolve, 3000 + text.length * 90);
    const done = () => { left -= 1; if (left <= 0) { clearTimeout(guard); resolve(); } };
    for (const part of parts) {
      const u = new SpeechSynthesisUtterance(part.trim());
      u.lang = 'en-US';
      u.rate = 1.05;
      u.onend = done;
      u.onerror = done;
      window.speechSynthesis.speak(u);
    }
  });
}

// ---------- sound ----------

let audioCtx = null;
function audio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// Unlock audio on the first key or click, so sound can start when the reading returns.
window.addEventListener('keydown', audio, { capture: true });
window.addEventListener('pointerdown', audio, { capture: true });

function pitchFor(value, table) {
  const { min, max, log } = table;
  let f = 0.5;
  if (max > min) {
    f = log && min > 0 ? (Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (value - min) / (max - min);
  }
  return 220 * Math.pow(4, Math.min(1, Math.max(0, f))); // 220 Hz to 880 Hz
}

function stopSound() {
  for (const t of state.timers) clearTimeout(t);
  state.timers = [];
  for (const n of state.nodes) { try { n.stop(); } catch { /* already stopped */ } }
  state.nodes = [];
  document.querySelectorAll('.cell.sounding').forEach((c) => c.classList.remove('sounding'));
  if (state.playResolve) { const r = state.playResolve; state.playResolve = null; r(); }
}

// Plays every value in reading order. A missing value is a rest: no note is played for it.
function playChart() {
  stopSound();
  const table = state.table;
  const ctx = audio();
  if (!table || !table.count) return Promise.resolve();
  const NOTE = 0.15, GAP = 0.15;
  return new Promise((resolve) => {
    state.playResolve = resolve;
    let t = 0.08;
    const t0 = ctx ? ctx.currentTime : 0;
    table.series.forEach((s, si) => {
      state.timers.push(setTimeout(() => {
        el.status.textContent = `Playing series ${si + 1} of ${table.series.length}: ${s.name}.`;
      }, t * 1000));
      s.points.forEach((p, pi) => {
        const at = t;
        state.timers.push(setTimeout(() => {
          document.querySelectorAll('.cell.sounding').forEach((c) => c.classList.remove('sounding'));
          const c = cellAt(si, pi);
          if (c) c.classList.add('sounding');
        }, at * 1000));
        if (ctx && p.value !== null) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.value = pitchFor(p.value, table);
          gain.gain.setValueAtTime(0, t0 + at);
          gain.gain.linearRampToValueAtTime(0.3, t0 + at + 0.015);
          gain.gain.setValueAtTime(0.3, t0 + at + NOTE - 0.03);
          gain.gain.linearRampToValueAtTime(0, t0 + at + NOTE);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t0 + at);
          osc.stop(t0 + at + NOTE + 0.02);
          state.nodes.push(osc);
        }
        t += NOTE;
      });
      t += GAP;
    });
    state.timers.push(setTimeout(() => {
      document.querySelectorAll('.cell.sounding').forEach((c) => c.classList.remove('sounding'));
      state.playResolve = null;
      showStatus();
      resolve();
    }, t * 1000 + 60));
  });
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
    fail('Not read: that file is not an image. Nothing is shown. Supply a chart image.');
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

async function supplyPrepared(key) {
  const p = PREPARED[key];
  try {
    const blob = await (await fetch(p.src)).blob();
    await supply(blob, p.label, p.id);
  } catch {
    fail('Not read: the prepared image did not load. Nothing is shown. Press the button again.');
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
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } } });
  } catch {
    say('Camera not available. Nothing changed. Paste, choose or drop an image.');
    el.status.textContent = 'Camera not available. Nothing changed. Paste, choose or drop an image.';
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
  stopSound();
  stopSpeech();
  state.table = null;
  state.verify = null;
  el.tableWrap.hidden = true;
  el.tHead.textContent = '';
  el.tBody.textContent = '';
  el.claim.hidden = true;
  el.claim.textContent = '';
  el.statusVerify.hidden = true;
  el.statusVerify.textContent = '';
  el.play.disabled = true;
  el.verify.disabled = true;
  el.statement.className = 'statement';
}

function fail(text) {
  resetResult();
  el.statement.textContent = 'Not read';
  el.status.textContent = text;
  el.again.disabled = !state.image;
  say(text);
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
  say('Reading the chart.');

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
    fail('Not read: the call failed. Nothing is shown. Press Run again.');
    return;
  }
  state.seconds = (performance.now() - started) / 1000;
  const table = normalise(payload.reading);
  state.table = table;
  el.again.disabled = false;

  if (!table.count) {
    showNotKnown(table.unreadable || 'no value could be read from this image');
    return;
  }

  renderTable(table);
  el.play.disabled = false;
  el.verify.disabled = false;
  el.statement.textContent = table.missing ? `${table.missing} not known` : `${table.count} values`;
  if (table.missing) el.statement.className = 'statement statement-unknown';
  showStatus();
  await say(statusText());
  if (runId !== state.runId) return;
  if (table.missing) {
    el.claim.hidden = false;
    el.claim.textContent = '';
    el.claim.append(partialNotKnown());
    await say(partialText());
    if (runId !== state.runId) return;
  }
  state.auto = runId;
  announce('Playing the chart as pitch. Higher value, higher note.');
  await playChart();
  if (runId !== state.runId || state.auto !== runId) return; // the user took over
  showSummary();
}

// Any action by the user ends the automatic play-then-summary sequence.
function interrupt() {
  state.auto = 0;
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

function notKnownText(what) {
  return `Not known: ${tidy(what)}. ${FIND_OUT}`;
}

function partialText() {
  const t = state.table;
  return notKnownText(`${t.missing} of ${t.count + t.missing} values. Reason given: ${cap(t.reason)}`);
}

function cap(text) {
  const s = tidy(text);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pointNotKnown(p) {
  return notKnownText(`this value. Reason given: ${cap(p.reason || state.table.reason)}`);
}

function partialNotKnown() {
  const p = document.createElement('p');
  p.className = 'claim-unknown';
  p.textContent = partialText();
  return p;
}

function showNotKnown(reason) {
  const text = notKnownText(reason);
  el.statement.textContent = 'Not known';
  el.statement.className = 'statement statement-unknown';
  el.status.textContent = `${MODEL_ID} read 0 values in ${state.seconds.toFixed(1)} s.`;
  el.claim.hidden = false;
  el.claim.textContent = '';
  const p = document.createElement('p');
  p.className = 'claim-unknown';
  p.textContent = text;
  el.claim.append(p);
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

// A cell shows the model's value; after Verify it also shows the outcome as colour, shape and word.
function paintCell(b, p, outcome) {
  b.textContent = '';
  b.classList.remove('is-match', 'is-mismatch', 'is-unknown');
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

// Explore by keyboard. One tab stop for the table. Left and Right step through a series point by point,
// with pitch and the spoken value. Up and Down switch series (or panel, or row). Home and End jump
// to the ends of the series. T gives the trend of the series.
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
  if (ns < 0 || ns >= t.series.length) { say(ns < 0 ? 'First series.' : 'Last series.'); return; }
  if (ns !== si) {
    const same = t.series[ns].points.findIndex((p) => p.x === t.series[si].points[pi].x);
    np = same >= 0 ? same : Math.min(pi, t.series[ns].points.length - 1);
  }
  if (np < 0 || np >= t.series[ns].points.length) { say(np < 0 ? 'Start of the series.' : 'End of the series.'); return; }
  const next = cellAt(ns, np);
  if (!next) return;
  b.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
  stepTo(ns, np, ns !== si);
});

function playNote(value, when = 0, length = 0.22) {
  const ctx = audio();
  if (!ctx || value === null) return;
  const at = ctx.currentTime + 0.02 + when;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = pitchFor(value, state.table);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.3, at + 0.015);
  gain.gain.setValueAtTime(0.3, at + length - 0.04);
  gain.gain.linearRampToValueAtTime(0, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
  state.nodes.push(osc);
}

// One step: the note for the value, the value shown in the margin, and the value spoken.
function stepTo(si, pi, nameSeries) {
  interrupt();
  stopSound();
  const t = state.table;
  const s = t.series[si];
  const p = s.points[pi];
  playNote(p.value);
  document.querySelectorAll('.cell.selected').forEach((c) => c.classList.remove('selected'));
  const c = cellAt(si, pi);
  if (c) c.classList.add('selected');
  el.claim.hidden = false;
  el.claim.textContent = '';
  const head = document.createElement('p');
  head.className = 'claim-head';
  head.textContent = `${s.name}, ${p.x}`;
  const v = document.createElement('p');
  v.className = p.value === null ? 'claim-unknown' : 'claim-value';
  v.textContent = p.value === null ? 'Not known. No note is played. Enter gives the reason.' : fmt(p.value);
  if (p.value !== null && t.unit) v.append(span('claim-unit', ` ${t.unit}`));
  el.claim.append(head, v);
  const value = p.value === null ? 'not known' : fmt(p.value);
  say(nameSeries ? `${s.name}. ${p.x}: ${value}.` : `${p.x}: ${value}.`);
}

function trendText(si) {
  const s = state.table.series[si];
  const pts = s.points.filter((p) => p.value !== null);
  if (pts.length < 2) return `${s.name}: Not known: the trend, with fewer than 2 values read. ${FIND_OUT}`;
  const first = pts[0], last = pts[pts.length - 1];
  const hi = pts.reduce((a, p) => (p.value > a.value ? p : a));
  const lo = pts.reduce((a, p) => (p.value < a.value ? p : a));
  const d = last.value - first.value;
  const move = d > 0 ? `rises by ${fmt(d)}` : d < 0 ? `falls by ${fmt(-d)}` : 'ends level';
  const missing = s.points.length - pts.length;
  return `${s.name} ${move}, from ${fmt(first.value)} at ${first.x} to ${fmt(last.value)} at ${last.x}. Highest ${fmt(hi.value)} at ${hi.x}. Lowest ${fmt(lo.value)} at ${lo.x}.${missing ? ` ${missing} values not known.` : ''}`;
}

// T: the series as pitch, then its trend, by plain code from the table.
function trend(si) {
  interrupt();
  stopSound();
  stopSpeech();
  const s = state.table.series[si];
  let when = 0;
  s.points.forEach((p) => { playNote(p.value, when, 0.2); when += 0.2; });
  const text = trendText(si);
  el.claim.hidden = false;
  el.claim.textContent = '';
  const head = document.createElement('p');
  head.className = 'claim-head';
  head.textContent = `Trend, ${s.name}`;
  const body = document.createElement('p');
  body.textContent = text;
  const src = document.createElement('p');
  src.append(mark('derived', 'Derived by plain code from the table.'));
  el.claim.append(head, body, src);
  announce(text);
  state.timers.push(setTimeout(() => speakOnly(text), when * 1000 + 150));
}

el.tBody.addEventListener('click', (e) => {
  const b = e.target.closest('.cell');
  if (b) selectClaim(Number(b.dataset.s), Number(b.dataset.p));
});

function mark(kind, word) {
  const wrap = document.createElement('span');
  wrap.className = 'mark-line';
  wrap.append(span(`mark mark-${kind}`, ''), document.createTextNode(` ${word}`));
  return wrap;
}

// Enter on a value: its source, shown and spoken.
function selectClaim(si, pi) {
  interrupt();
  stopSound();
  const t = state.table;
  const s = t.series[si];
  const p = s.points[pi];
  document.querySelectorAll('.cell.selected').forEach((c) => c.classList.remove('selected'));
  const c = cellAt(si, pi);
  if (c) c.classList.add('selected');
  el.claim.hidden = false;
  el.claim.textContent = '';
  const head = document.createElement('p');
  head.className = 'claim-head';
  head.textContent = `${s.name}, ${p.x}`;
  el.claim.append(head);
  let text;
  if (p.value === null) {
    const u = document.createElement('p');
    u.className = 'claim-unknown';
    text = pointNotKnown(p);
    u.textContent = text;
    el.claim.append(u);
    text = `${s.name}, ${p.x}. ${text}`;
  } else {
    const v = document.createElement('p');
    v.className = 'claim-value';
    v.textContent = fmt(p.value);
    if (t.unit) v.append(span('claim-unit', ` ${t.unit}`));
    const src = document.createElement('p');
    src.append(mark('read', `Read from the image by ${MODEL_ID}, series ${s.name}, point ${p.x}.`));
    el.claim.append(v, src);
    text = `${s.name}, ${p.x}: ${fmt(p.value)}${t.unit ? ` ${t.unit}` : ''}. Read from the image by ${MODEL_ID}.`;
    const o = state.verify && state.verify.outcomes[si] && state.verify.outcomes[si][pi];
    if (o) {
      const vp = document.createElement('p');
      vp.className = `claim-verify claim-${o.kind}`;
      let vt;
      if (o.kind === 'match') vt = `Match: model ${fmt(p.value)}, record ${fmt(o.record)}. Record: ${state.verify.recordName}.`;
      else if (o.kind === 'mismatch') vt = `Mismatch: model ${fmt(p.value)}, record ${fmt(o.record)}, difference ${fmt(Math.abs(o.diff))}. Record: ${state.verify.recordName}.`;
      else vt = `Not known: no record of this value in ${state.verify.recordName}.`;
      vp.textContent = vt;
      el.claim.append(vp);
      text += ` ${vt}`;
    }
  }
  say(text);
}

// ---------- the summary, by plain code from the table ----------

function summaryText() {
  const t = state.table;
  let lo = null, hi = null;
  t.series.forEach((s) => s.points.forEach((p) => {
    if (p.value === null) return;
    if (!lo || p.value < lo.value) lo = { ...p, name: s.name };
    if (!hi || p.value > hi.value) hi = { ...p, name: s.name };
  }));
  const kind = t.kind.charAt(0).toUpperCase() + t.kind.slice(1);
  const parts = [
    `${kind}${t.title ? `, ${t.title}` : ''}: ${t.series.length} series, ${t.count} values${t.unit ? `, in ${t.unit}` : ''}.`,
    `Range ${fmt(lo.value)} to ${fmt(hi.value)}.`,
    `Highest ${fmt(hi.value)} at ${hi.name}, ${hi.x}.`,
    `Lowest ${fmt(lo.value)} at ${lo.name}, ${lo.x}.`,
  ];
  if (t.missing) parts.push(`${t.missing} values not known.`);
  return parts.join(' ');
}

function showSummary() {
  const text = summaryText();
  el.claim.hidden = false;
  el.claim.textContent = '';
  const head = document.createElement('p');
  head.className = 'claim-head';
  head.textContent = 'Summary';
  const body = document.createElement('p');
  body.textContent = text;
  const src = document.createElement('p');
  src.append(mark('derived', 'Derived by plain code from the table.'));
  el.claim.append(head, body, src);
  if (state.table.missing) el.claim.append(partialNotKnown());
  return say(text);
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
  interrupt();
  stopSound();
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
    el.statusVerify.textContent = text;
    el.statement.textContent = 'Not known';
    el.statement.className = 'statement statement-unknown';
    say(text);
    return;
  }
  const rs = recordSeries(rec);
  const recordName = `${WITHHELD_NAME}, ${rec.title}`;
  const outcomes = [];
  const counts = { match: 0, mismatch: 0, unknown: 0 };
  t.series.forEach((s, si) => {
    const sk = key(s.name);
    const r = rs.find((q) => key(q.name) === sk) || rs.find((q) => sk.startsWith(key(q.name)) || sk.includes(key(q.name)));
    outcomes[si] = s.points.map((p, pi) => {
      let o;
      if (p.value === null || !r) o = { kind: 'unknown' };
      else {
        let xi = r.xs.findIndex((x) => xKey(x) === xKey(p.x));
        if (xi < 0 && r.xs.length === s.points.length) xi = pi;
        const record = xi >= 0 ? r.vals[xi] : undefined;
        if (typeof record !== 'number') o = { kind: 'unknown' };
        else if (within(p.value, record)) o = { kind: 'match', record, diff: p.value - record };
        else o = { kind: 'mismatch', record, diff: p.value - record };
      }
      counts[o.kind] += 1;
      return o;
    });
  });
  state.verify = { outcomes, counts, recordName };

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let n = 0;
  t.series.forEach((s, si) => s.points.forEach((p, pi) => {
    const c = cellAt(si, pi);
    if (!c) return;
    const apply = () => paintCell(c, p, outcomes[si][pi]);
    if (reduce) apply(); else state.timers.push(setTimeout(apply, n * 30));
    n += 1;
  }));

  const line = `${counts.match} match, ${counts.mismatch} mismatch, ${counts.unknown} not known.`;
  el.statusVerify.hidden = false;
  el.statusVerify.className = `status status-verify ${counts.mismatch ? 'has-mismatch' : counts.unknown ? 'has-unknown' : 'all-match'}`;
  el.statusVerify.textContent = '';
  if (!counts.mismatch && !counts.unknown) el.statusVerify.append(span('tri', ''));
  el.statusVerify.append(document.createTextNode(`${line} Record: ${recordName}. Tolerance: ${TOLERANCE_TEXT}.`));
  el.statement.className = `statement ${counts.mismatch ? 'statement-mismatch' : counts.unknown ? 'statement-unknown' : 'statement-match'}`;
  el.statement.textContent = counts.mismatch ? `${counts.mismatch} mismatch` : counts.unknown ? `${counts.unknown} not known` : `${counts.match} match`;
  say(`Verify. ${line} Checked against the withheld record ${rec.title}, ${TOLERANCE_TEXT.replace('%', ' percent')}.`);
}

// ---------- Prompt sheet ----------

function openPrompt() {
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
el.prompt.addEventListener('click', openPrompt);
el.sheetClose.addEventListener('click', closePrompt);

async function replay() {
  if (!state.table || !state.table.count) return;
  const runId = state.runId;
  interrupt();
  stopSpeech();
  announce('Playing the chart as pitch. Higher value, higher note.');
  await playChart();
  if (runId === state.runId) showStatus();
}

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

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') {
    if (!el.sheet.hidden) { closePrompt(); return; }
    interrupt();
    stopSound();
    stopSpeech();
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
    el.keys.textContent = `Keys: P plays the chart again. M turns the built-in voice ${state.muted ? 'on' : 'off'}. Esc stops sound. The built-in voice is ${state.muted ? 'off' : 'on'}.`;
    announce(`Built-in voice ${state.muted ? 'off' : 'on'}.`);
  }
});
