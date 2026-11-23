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
  seriesSlot: 0.3,           // one series alone: seconds per point, within the limits below
  seriesMin: 1.2,            // 6. one series lasts at most chartSeconds and never under 1.2 s
};

// Prepared inputs. The Sample is one record: the image, the stored reading by this model and the stored
// reading by the previous model. Swapping in a phone photo and its captures is a change to that file only.
// sample: read live. broken: shown from its cached reading, Run again reads it live.
// both: the one photographed chart the two-model comparison is keyed to; both readings cached.
const PREPARED = {
  samples: ['/prepared/photo2.json', '/prepared/photo1.json'], // tonight's phone photos, read live; Sample alternates
  sample: '/prepared/photo2.json',
  broken: '/prepared/photo5.json',
  both: '/prepared/photo3.json',
};
const LATE_MS = 30000;

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
  what: $('what'), facts: $('facts'), hear: $('hear'), plot: $('plot'), plotCaption: $('plot-caption'), unread: $('unread'),
};

const state = {
  runId: 0, seq: 0, image: null, label: '', preparedId: null, table: null, seconds: 0, verify: null,
  muted: false, stream: null, timers: [], voices: [], playResolve: null, soundUntil: 0,
  record: null, old: null, showOld: false, cachedAt: null, sampleTurn: 0, insight: null, plot: null,
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
function glide(parts, slot, old = false, scale = scaleNow()) {
  stopSound();
  const ctx = audio();
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
          moveMarker(part.si, pi, old); // the marker on the redrawn chart moves as the melody plays
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

// One series: at most 3.6 s, shorter for few points, never under 1.2 s.
function playSeries(si, values = null, old = false, scale = scaleNow(), label = '') {
  const s = state.table.series[si];
  const vals = values || s.points.map((p) => p.value);
  if (!state.plot || state.plot.active !== si) drawPlot(si);
  const seconds = Math.min(SOUND.chartSeconds, Math.max(SOUND.seriesMin, vals.length * SOUND.seriesSlot));
  return glide([{ si, values: vals, label: label || `Playing ${s.name}.` }], seconds / vals.length, old, scale);
}

// The series in focus: the one holding the table's tab stop; the first by default.
function currentSeries() {
  const c = el.tBody.querySelector('.cell[tabindex="0"]');
  return c ? Number(c.dataset.s) : 0;
}

function seriesWord(n) {
  const panel = /panel/i.test(state.table.kind);
  return panel ? (n === 1 ? 'panel' : 'panels') : 'series';
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

const PREPARED_FAIL = ['Not read: the prepared image did not load. Nothing is shown. Press the button again.', 'Not read: the prepared image did not load. Press the button again.'];

// Sample: the prepared photo goes through the live path, like any other image.
async function supplySample() {
  try {
    const url = PREPARED.samples[state.sampleTurn % PREPARED.samples.length];
    state.sampleTurn += 1;
    const rec = await (await fetch(url)).json();
    const blob = await (await fetch(rec.image)).blob();
    state.record = null; // no cached reading stands in for a Sample
    await supply(blob, `${rec.label} Read live.`, rec.id);
  } catch {
    fail(...PREPARED_FAIL);
  }
}

// Break it: shown from its cached reading, labelled; Run again reads it live.
async function supplyBroken() {
  try {
    const rec = await (await fetch(PREPARED.broken)).json();
    await showCached(rec);
  } catch {
    fail(...PREPARED_FAIL);
  }
}

// A stored reading of a prepared photo, captured earlier tonight and labelled so. No model call.
async function showCached(rec, quiet = false) {
  state.runId += 1; // abandons a live call still running
  stopCamera();
  resetResult();
  state.record = rec;
  state.preparedId = rec.id;
  state.cachedAt = rec.current.captured;
  state.seconds = 0;
  state.image = null;
  state.label = `${rec.label} Read live.`;
  el.again.disabled = true;
  el.img.src = rec.image;
  el.img.hidden = false;
  el.img.alt = 'The chart photo. Its values are in the table.';
  el.caption.textContent = `${rec.label} Reading cached ${rec.current.captured} tonight. Run again reads it live.`;
  el.figure.hidden = false;
  const id = rec.id;
  fetch(rec.image).then((r) => r.blob()).then(toJpegBase64).then((dataUrl) => {
    if (state.preparedId === id && state.cachedAt) { state.image = dataUrl; el.again.disabled = false; }
  }).catch(() => {});
  renderReading(rec.current.reading);
  if (!quiet) await announceReading();
}

function cachedFor() {
  return Boolean(state.record && state.preparedId === state.record.id && state.record.current);
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
  el.verify.disabled = true;
  el.statement.className = 'statement';
  el.statement2.hidden = true;
  el.statement2.textContent = '';
  el.tableWrap.classList.remove('comparing');
  el.what.hidden = true;
  el.facts.hidden = true;
  el.facts.textContent = '';
  el.hear.hidden = true;
  el.unread.hidden = true;
  el.unread.textContent = '';
  state.insight = null;
  state.plot = null;
}

function fail(shown, spoken) {
  resetResult();
  el.statement.textContent = 'Not read';
  el.status.textContent = shown;
  el.again.disabled = !state.image;
  say(spoken);
}

async function run() {
  if (!state.image) return;
  const runId = ++state.runId;
  resetResult();
  state.cachedAt = null;
  el.caption.textContent = state.label;
  el.again.disabled = true;
  el.statement.textContent = 'Reading';
  const started = performance.now();
  let lateText = '';
  const tick = () => { el.status.textContent = `Reading the chart. ${Math.round((performance.now() - started) / 1000)} s so far.${lateText ? ` ${lateText}` : ''}`; };
  tick();
  const ticker = setInterval(tick, 1000);
  announce('Reading the chart.');
  sign('start');
  // A live call past 30 s says so in one sentence, and offers the cached reading where one exists.
  const late = setTimeout(() => {
    if (runId !== state.runId) return;
    lateText = cachedFor()
      ? `This live reading has passed 30 seconds; press C for the cached reading from ${state.record.current.captured} tonight.`
      : 'This live reading has passed 30 seconds.';
    tick();
    say(lateText);
  }, LATE_MS);

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
  clearTimeout(late);
  clearInterval(ticker);
  if (runId !== state.runId) return;

  if (!payload || !payload.ok || !payload.reading) {
    fail('Not read: the call failed. Nothing is shown. Press Run again.', 'Not read: the call failed. Press Run again.');
    return;
  }
  state.seconds = (performance.now() - started) / 1000;
  el.again.disabled = false;
  renderReading(payload.reading);
  await announceReading();
}

// A reading (live or cached) onto the sheet: the table, the headline, the status line. No sound here.
function renderReading(reading) {
  const table = normalise(reading);
  state.table = table;
  if (!table.count) return;
  renderTable(table);
  el.play.disabled = false;
  el.verify.disabled = false;

  // What the chart says, by plain code from the table: one line, one headline, three key facts.
  const insight = { what: whatText(table), finding: finding(table), facts: keyFacts(table), unread: unreadText(table) };
  state.insight = insight;
  el.what.textContent = insight.what;
  el.what.hidden = false;
  el.statement.textContent = insight.finding.text;
  el.statement.className = 'statement headline';
  el.facts.textContent = '';
  for (const f of insight.facts) {
    const li = document.createElement('li');
    li.textContent = f;
    el.facts.append(li);
  }
  el.facts.hidden = false;
  if (insight.unread) {
    el.unread.textContent = insight.unread;
    el.unread.hidden = false;
  }
  // The headline's series is the one in focus: Play starts there; Up and Down choose another.
  const start = cellAt(insight.finding.si, 0) || el.tBody.querySelector('.cell');
  if (start) {
    el.tBody.querySelectorAll('.cell[tabindex="0"]').forEach((c) => { c.tabIndex = -1; });
    start.tabIndex = 0;
  }
  el.hear.hidden = false;
  drawPlot(insight.finding.si);
  showStatus();
}

// Spoken, in this order and nothing more unless asked: line 1, the headline, a pause, the melody.
// Each step waits for the one before: never speech over a tone. Unread values are then named once.
async function announceReading() {
  const t = state.table;
  const seq = act();
  await sign('ready');
  if (!alive(seq)) return;
  if (!t.count) {
    showNotKnown(t.unreadable || 'no value could be read from this image');
    return;
  }
  const i = state.insight;
  await say(`${state.cachedAt ? 'Cached reading. ' : ''}${i.what} ${i.finding.text}`);
  if (!alive(seq)) return;
  await wait(SOUND.headlineGap * 1000);
  if (!alive(seq)) return;
  await playSeries(i.finding.si);
  if (!alive(seq)) return; // the user took over
  showStatus();
  if (i.unread) say(i.unread);
}

// ---------- what the chart says: plain code on the table the call returned ----------

const known = (s) => s.points.filter((p) => p.value !== null);
const shortUnit = (t) => (t.unit && t.unit.length <= 8 ? ` ${t.unit}` : '');

function whatText(t) {
  const n = t.series.length;
  const xr = t.xs.length > 1 ? `${t.xs[0]} to ${t.xs[t.xs.length - 1]}` : (t.xs[0] || '');
  return `${cap(t.kind)}${t.title ? `: ${t.title}` : ''}. ${n} ${seriesWord(n)}, ${xr}${t.unit ? `, in ${t.unit}` : ''}.`;
}

// The single most notable finding, in this order: an overtake; the fastest growth; the largest value.
function finding(t) {
  const kind = t.kind.toLowerCase();
  const ordered = !/heat/.test(kind); // a heatmap row is not a course over time
  const lineLike = ordered && !/panel|bar/.test(kind);
  const tol = (v) => Math.max(VERIFY_TOLERANCE.abs, VERIFY_TOLERANCE.rel * Math.abs(v));
  if (lineLike && t.series.length > 1) {
    let best = null;
    t.series.forEach((A, a) => t.series.forEach((B, b) => {
      if (a === b) return;
      for (let i = 1; i < Math.min(A.points.length, B.points.length); i += 1) {
        const a0 = A.points[i - 1].value, a1 = A.points[i].value, b0 = B.points[i - 1].value, b1 = B.points[i].value;
        if ([a0, a1, b0, b1].some((v) => v === null)) continue;
        if (b0 - a0 > tol(b0) && a1 - b1 > tol(b1) && (!best || i > best.i || (i === best.i && a1 - b1 > best.gap))) {
          best = { i, gap: a1 - b1, a, text: `${A.name} overtakes ${B.name} in ${A.points[i].x}.` };
        }
      }
    }));
    if (best) return { text: best.text, si: best.a };
  }
  if (ordered) {
    let best = null;
    t.series.forEach((s, si) => {
      const k = known(s);
      if (k.length < 2 || k[0].value <= 0) return;
      const mult = k[k.length - 1].value / k[0].value;
      if (!best || mult > best.mult) best = { mult, si, s, first: k[0], last: k[k.length - 1] };
    });
    if (best && best.mult >= 1.5) {
      const by = best.mult >= 2 ? `${fmt(Math.round(best.mult * 10) / 10)} times` : `up ${Math.round((best.mult - 1) * 100)}%`;
      return { si: best.si, text: `${best.s.name} grew fastest: ${by}, from ${fmt(best.first.value)} in ${best.first.x} to ${fmt(best.last.value)} in ${best.last.x}.` };
    }
  }
  let hi = null;
  t.series.forEach((s, si) => s.points.forEach((p) => {
    if (p.value !== null && (!hi || p.value > hi.p.value)) hi = { p, s, si };
  }));
  return { si: hi.si, text: `Highest value: ${fmt(hi.p.value)}${shortUnit(t)}, ${hi.s.name} at ${hi.p.x}.` };
}

// The trend of one series in two or three words.
function trendWord(s) {
  const k = known(s);
  if (k.length < 2) return 'not read';
  const first = k[0].value, last = k[k.length - 1].value;
  const hi = k.reduce((a, p) => (p.value > a.value ? p : a));
  const lo = k.reduce((a, p) => (p.value < a.value ? p : a));
  const range = hi.value - lo.value;
  if (range <= Math.max(VERIFY_TOLERANCE.abs, VERIFY_TOLERANCE.rel * Math.abs(hi.value))) return 'flat';
  if (hi !== k[0] && hi !== k[k.length - 1] && hi.value - Math.max(first, last) > 0.25 * range) return `peak in ${hi.x}`;
  if (lo !== k[0] && lo !== k[k.length - 1] && Math.min(first, last) - lo.value > 0.25 * range) return `dip in ${lo.x}`;
  return last > first ? 'rising' : last < first ? 'falling' : 'flat';
}

// Three key facts: highest and lowest with place; the biggest change between neighbours; each trend.
function keyFacts(t) {
  let hi = null, lo = null, step = null;
  t.series.forEach((s) => {
    s.points.forEach((p, i) => {
      if (p.value === null) return;
      if (!hi || p.value > hi.p.value) hi = { p, s };
      if (!lo || p.value < lo.p.value) lo = { p, s };
      const q = s.points[i + 1];
      if (q && q.value !== null && (!step || Math.abs(q.value - p.value) > Math.abs(step.d))) step = { d: q.value - p.value, s, p, q };
    });
  });
  const groups = new Map();
  t.series.forEach((s) => {
    const w = trendWord(s);
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w).push(s.name);
  });
  const facts = [`Highest ${fmt(hi.p.value)} at ${hi.s.name}, ${hi.p.x}; lowest ${fmt(lo.p.value)} at ${lo.s.name}, ${lo.p.x}.`];
  if (step) facts.push(`Biggest step: ${step.s.name}, ${step.p.x} to ${step.q.x}, ${step.d >= 0 ? 'up' : 'down'} ${fmt(Math.abs(step.d))}.`);
  facts.push(`${[...groups].map(([w, names]) => `${cap(w)}: ${names.join(', ')}`).join('. ')}.`);
  return facts;
}

// Unread values as one plain sentence saying which. Empty when everything was read.
function unreadText(t) {
  if (!t.missing) return '';
  const parts = [];
  t.series.forEach((s) => {
    let i = 0;
    while (i < s.points.length) {
      if (s.points[i].value !== null) { i += 1; continue; }
      let j = i;
      while (j + 1 < s.points.length && s.points[j + 1].value === null) j += 1;
      parts.push(j > i ? `${s.name} ${s.points[i].x} to ${s.points[j].x}` : `${s.name} ${s.points[i].x}`);
      i = j + 1;
    }
  });
  const which = parts.length > 4 ? `${parts.slice(0, 4).join('; ')}; and ${parts.length - 4} more` : parts.join('; ');
  const reason = tidy(t.reason);
  return `Not read: ${which}, ${reason.charAt(0).toLowerCase()}${reason.slice(1)}. Not guessed.`;
}

// ---------- hear it: the chart redrawn from the values read, with a marker that moves with the melody ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, text) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

function drawPlot(active) {
  const t = state.table;
  if (!t || !t.count) return;
  const olds = state.showOld && state.old ? state.old : null;
  // With both readings showing, the plot zooms to this series across both readings, like the pitch map.
  const vals = (olds
    ? t.series[active].points.map((p) => p.value).concat(olds[active])
    : t.series.flatMap((s) => s.points.map((p) => p.value))).filter((v) => v !== null);
  const min = Math.min(...vals), max = Math.max(...vals);
  const log = t.log && min > 0;
  const W = 720, H = 340, L = 84, R = 34, T = 16, B = 40;
  const x = (i) => (t.xs.length > 1 ? L + ((W - L - R) * i) / (t.xs.length - 1) : (L + W - R) / 2);
  const frac = (v) => (max > min ? (log ? (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (v - min) / (max - min)) : 0.5);
  const y = (v) => H - B - frac(v) * (H - T - B);
  const xi = (p) => t.xs.indexOf(p.x);
  const path = (points) => {
    let d = '', pen = false;
    for (const [px, v] of points) {
      if (v === null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(px).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    }
    return d.trim();
  };
  const g = el.plot;
  g.textContent = '';
  const mid = log ? Math.sqrt(min * max) : (min + max) / 2;
  for (const v of max > min ? [min, mid, max] : [min]) {
    g.append(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'plot-grid' }));
    g.append(svgEl('text', { x: L - 8, y: y(v) + 7, 'text-anchor': 'end', class: 'plot-tick' }, fmt(Math.round(v * 10) / 10)));
  }
  const every = t.xs.length > 9 ? Math.ceil(t.xs.length / 6) : 1;
  t.xs.forEach((label, i) => {
    if (i % every === 0 || i === t.xs.length - 1) g.append(svgEl('text', { x: x(i), y: H - 10, 'text-anchor': 'middle', class: 'plot-tick' }, label));
  });
  if (!olds) {
    t.series.forEach((s, si) => {
      if (si !== active) g.append(svgEl('path', { d: path(s.points.map((p) => [xi(p), p.value])), class: 'plot-other' }));
    });
  }
  const s = t.series[active];
  if (olds) g.append(svgEl('path', { d: path(s.points.map((p, pi) => [xi(p), olds[active][pi]])), class: 'plot-old' }));
  g.append(svgEl('path', { d: path(s.points.map((p) => [xi(p), p.value])), class: 'plot-active' }));
  s.points.forEach((p) => {
    if (p.value !== null) g.append(svgEl('circle', { cx: x(xi(p)), cy: y(p.value), r: 5, class: 'plot-dot' }));
  });
  g.append(svgEl('circle', { id: 'plot-marker', cx: 0, cy: 0, r: 12, class: 'plot-marker', visibility: 'hidden' }));
  state.plot = { active, x, y, xi };
  const prev = olds && state.record ? state.record.previous : null;
  el.plotCaption.textContent = `Redrawn from the values read${log ? ', log scale' : ''}. Bold line: ${s.name}.${prev ? ` Solid: ${MODEL_ID}. Dashed: ${prev.model}, captured ${prev.captured} tonight.` : ''} The ring moves with the melody.`;
}

function moveMarker(si, pi, old) {
  const m = document.getElementById('plot-marker');
  if (!m || !state.plot || state.plot.active !== si) return;
  const p = state.table.series[si].points[pi];
  const v = old && state.old ? state.old[si][pi] : p.value;
  if (v === null) { m.setAttribute('visibility', 'hidden'); return; }
  m.setAttribute('cx', state.plot.x(state.plot.xi(p)));
  m.setAttribute('cy', state.plot.y(v));
  m.setAttribute('visibility', 'visible');
}

// K: the key facts, spoken on request. They are on screen all along.
function speakFacts() {
  if (!state.insight) return;
  act();
  say(state.insight.facts.join(' '));
}

function statusText() {
  const t = state.table;
  const base = state.cachedAt
    ? `${MODEL_ID} read ${t.count} values. Cached ${state.cachedAt} tonight, not live.`
    : `${MODEL_ID} read ${t.count} values in ${state.seconds.toFixed(1)} s.`;
  return t.missing ? `${base} ${t.missing} not read.` : base;
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
  el.status.textContent = state.cachedAt
    ? `${MODEL_ID} read 0 values. Cached ${state.cachedAt} tonight, not live.`
    : `${MODEL_ID} read 0 values in ${state.seconds.toFixed(1)} s.`;
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
  el.tableWrap.classList.toggle('wide', table.xs.length > 4);
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
  else if (oo && oo.kind === 'match') { line.classList.add('old-match'); line.append(span('val', fmt(ov)), span('sr-only', ' Match')); }
  else if (oo && oo.kind === 'mismatch') { line.classList.add('old-mismatch'); line.append(span('val struck', fmt(ov)), span('sr-only', ' Mismatch')); }
  else line.append(span('val', fmt(ov)));
  b.append(line);
  if (differs(p.value, ov)) {
    b.classList.add('differs');
    b.append(span('sr-only', ' The two readings differ here.'));
  }
}

function paintMain(b, p, outcome) {
  if (p.value === null) {
    b.append(span('unknown-word', 'not read'), span('sr-only', `. ${pointNotKnown(p)}`));
    return;
  }
  if (!outcome) {
    b.append(span('val', fmt(p.value)));
    return;
  }
  if (outcome.kind === 'match') {
    b.classList.add('is-match'); // calm: the value turns ink navy; the word is in the check line and for screen readers
    b.append(span('val', fmt(p.value)), span('sr-only', ' Match'));
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
  if (ns !== si) chooseSeries(ns, np); else stepTo(ns, np, false);
});

// Up and Down choose another series or panel and play it: its name, then its glide.
async function chooseSeries(si, pi) {
  const seq = act();
  const s = state.table.series[si];
  select(si, pi);
  showClaim(para('claim-head', s.name), para('', `${s.points.map((p) => `${p.x}: ${fmtOrNot(p.value)}`).join(', ')}.`));
  await say(`${s.name}.`);
  if (!alive(seq)) return;
  await playSeries(si);
  if (alive(seq)) showStatus();
}

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
  await playSeries(si);
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

// P and the Play button: the series in focus, as one glide.
async function replay() {
  if (!state.table || !state.table.count) return;
  const seq = act();
  const s = state.table.series[currentSeries()];
  announce(`Playing ${s.name} as pitch. Higher value, higher note.`);
  await playSeries(currentSeries());
  if (alive(seq)) showStatus();
}

// A: all series in turn, each name spoken first, 600 ms between them. Escape or Space stops it.
async function playAll() {
  const t = state.table;
  if (!t || !t.count) return;
  const seq = act();
  for (let si = 0; si < t.series.length; si += 1) {
    await say(`${t.series[si].name}.`);
    if (!alive(seq)) return;
    await playSeries(si);
    if (!alive(seq)) return;
    await wait(SOUND.seriesGap * 1000);
    if (!alive(seq)) return;
  }
  showStatus();
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

// The comparison is keyed to one prepared photo, never to a title: Play both loads that photo itself.
// Both readings are cached captures of the same photo with the same settings; nothing here is live.
async function playBoth() {
  let rec;
  try {
    rec = await (await fetch(PREPARED.both)).json();
  } catch {
    fail(...PREPARED_FAIL);
    return;
  }
  const fresh = state.preparedId !== rec.id || !state.table || !state.cachedAt;
  if (fresh) await showCached(rec, true);
  const seq = act();
  const t = state.table;
  const prev = rec.previous;
  const prevLabel = `${prev.model}, captured ${prev.captured} tonight`;
  el.caption.textContent = `${rec.label} Both readings are cached: ${MODEL_ID} captured ${rec.current.captured}, ${prev.model} captured ${prev.captured} tonight, same photo, same settings.`;
  state.old = alignOld();
  state.showOld = true;
  if (state.verify) { // a Verify done before the comparison covered one reading only: clear it
    state.verify = null;
    el.statusVerify.hidden = true;
    el.statement.className = 'statement headline';
  }
  repaintAll();
  el.tableWrap.classList.add('comparing');

  // Which series: the one in focus when the photo was already showing; else the record's first series.
  let si = fresh ? -1 : currentSeries();
  if (si < 0) si = t.series.findIndex((s) => key(s.name) === key(rec.first_series || ''));
  if (si < 0) si = 0;
  const first = cellAt(si, 0);
  if (first && currentSeries() !== si) {
    el.tBody.querySelectorAll('.cell[tabindex="0"]').forEach((c) => { c.tabIndex = -1; });
    first.tabIndex = 0;
  }
  const s = t.series[si];
  drawPlot(si);
  const news = s.points.map((p) => p.value);
  const olds = state.old[si];
  let total = 0;
  t.series.forEach((ser, i) => ser.points.forEach((p, pi) => { if (differs(p.value, state.old[i][pi])) total += 1; }));
  const at = s.points.filter((p, pi) => differs(p.value, olds[pi]));
  const closing = at.length === 0 ? `In ${s.name} the two readings do not differ by more than the tolerance.`
    : at.length <= 3 ? `In ${s.name} the two readings differ at ${at.map((p) => p.x).join(' and ')}.`
      : `In ${s.name} the two readings differ at ${at.length} of ${s.points.length} points.`;
  const list = (vals) => vals.map(fmtOrNot).join(', ');

  // The pitch map for this series: its range across BOTH readings, onto 220 to 880 Hz. Printed.
  const both = [...news, ...olds].filter((v) => v !== null);
  const scale = { min: Math.min(...both), max: Math.max(...both), log: t.log };

  showClaim(
    para('claim-head', `Both readings, ${s.name}`),
    para('', `${MODEL_ID}, cached ${rec.current.captured} tonight: ${list(news)}.`),
    para('', `${prevLabel}, same photo, same settings: ${list(olds)}.`),
    para('claim-diff', `${closing} ${total} of ${t.count + t.missing} points differ in the whole chart, marked in the table.`),
    para('mark-line', `Pitch scale: ${fmt(scale.min)} to ${fmt(scale.max)}${t.unit ? ` ${t.unit}` : ''}, one map for both readings. A point is marked when the readings are more than ${VERIFY_TOLERANCE.abs} units or ${VERIFY_TOLERANCE.rel * 100}% apart. Verify shows which reading matches the record.`),
  );

  // One headline, 400 ms, two glides 600 ms apart on one pitch map, then one closing sentence.
  await say(`${s.name}: ${MODEL_ID} first, then ${prev.model}.`);
  if (!alive(seq)) return;
  await wait(SOUND.headlineGap * 1000);
  if (!alive(seq)) return;
  await playSeries(si, news, false, scale, `Playing ${s.name} as read by ${MODEL_ID}, cached ${rec.current.captured} tonight.`);
  if (!alive(seq)) return;
  await wait(SOUND.seriesGap * 1000);
  if (!alive(seq)) return;
  await playSeries(si, olds, true, scale, `Playing ${s.name} as read by ${prevLabel}.`);
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
    el.statusVerify.className = 'check check-bad';
    el.statusVerify.textContent = text;
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
  // The check line: small and quiet. One sentence, a green mark and the word when everything matches.
  const short = (c) => `${c.match} of ${all} match${c.mismatch ? `, ${c.mismatch} mismatch` : ''}${c.unknown ? `, ${c.unknown} not read` : ''}`;
  const checkLine = (text, c) => {
    const good = !c.mismatch;
    const row = span(`check-row ${good ? 'check-good' : 'check-bad'}`, '');
    if (good) row.append(span('tri', ''));
    row.append(document.createTextNode(text));
    return row;
  };
  el.statusVerify.hidden = false;
  el.statusVerify.className = 'check';
  el.statusVerify.textContent = '';
  if (!counts.mismatch) el.statement.className = 'statement headline statement-match'; // the finding has joined the record
  const small = span('check-small', `Record: ${recordName}. Tolerance: ${TOLERANCE_TEXT}.`);
  if (!old) {
    el.statusVerify.append(checkLine(`Verified: ${short(counts)}.`, counts), small);
    say(`Verified: ${short(counts)}.`);
    return;
  }
  // Both readings against the same record: which one matches. Side by side, one line each.
  const prev = state.record.previous;
  const oc = old.counts;
  el.statusVerify.append(
    checkLine(`${MODEL_ID}, cached ${state.record.current.captured} tonight: ${counts.match} of ${all} match.`, counts),
    checkLine(`${prev.model}, captured ${prev.captured} tonight: ${oc.match} of ${all} match.`, oc),
    small,
  );
  drawPlot(state.plot ? state.plot.active : 0);
  const some = (m) => `${m.slice(0, 2).join('; ')}${m.length > 2 ? `; and ${m.length - 2} more, marked in the table` : ''}`;
  const nodes = [para('claim-head', 'Verify, both readings')];
  if (mine.misses.length) nodes.push(para('claim-diff', `${MODEL_ID} mismatch at ${some(mine.misses)}.`));
  if (old.misses.length) nodes.push(para('claim-diff', `${prev.model} mismatch at ${some(old.misses)}.`));
  if (!mine.misses.length && !old.misses.length) nodes.push(para('', 'No mismatch in either reading.'));
  showClaim(...nodes);
  say(`Verified: ${MODEL_ID}, ${counts.match} of ${all} match; ${prev.model}, ${oc.match} of ${all} match.`);
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
el.sample.addEventListener('click', supplySample);
el.brk.addEventListener('click', supplyBroken);
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
  if (k === 'a' && !el.play.disabled) { e.preventDefault(); playAll(); }
  if (k === 'c' && cachedFor() && !state.cachedAt) { e.preventDefault(); showCached(state.record); }
  if (k === 'k' && state.insight) { e.preventDefault(); speakFacts(); }
  if (k === 'm') {
    e.preventDefault();
    state.muted = !state.muted;
    if (state.muted) stopSpeech();
    el.keys.textContent = `Keys: P plays the series in focus. A plays all series in turn. K speaks the key facts. M turns the built-in voice ${state.muted ? 'on' : 'off'}. Esc or Space stops all sound. The built-in voice is ${state.muted ? 'off' : 'on'}.`;
    announce(`Built-in voice ${state.muted ? 'off' : 'on'}.`);
  }
});
