import './style.css';
import { MODEL_ID } from '../shared/runtime-prompt.js';

// ---------- fixed things, in one place ----------

// Verify tolerance, the one constant. A value matches when it is within the larger of
// ABS units or REL of the record's value.
const VERIFY_TOLERANCE = { abs: 3, rel: 0.05 };
const TOLERANCE_TEXT = `within ${VERIFY_TOLERANCE.abs} units or ${VERIFY_TOLERANCE.rel * 100}%, whichever is larger`;

const CALL_TIMEOUT_MS = 100000; // the server gives the model up to 90 s
const MAX_EDGE = 2000;
const MAX_BASE64 = 4000000;

// Sound rules. One place for every number.
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

const LATE_MS = 30000;
const SERVER_MAX_BASE64 = 4200000; // the server's limit, about 3 MB of JPEG

// What the page says when a reading does not come back. Plain words; never the upstream error.
const CALL_TEXT = {
  late: 'Still reading; large or glare-heavy photos can take up to a minute.',
  timeout: 'The reading took too long and was stopped. Try a sharper or smaller photo.',
  tooLarge: 'That image is too large (limit about 3 MB).',
  notImage: 'That file could not be read as an image. Supply a photo or picture of a chart.',
  paused: 'Reading is paused until next month.',
  busy: 'Too many readings from this connection. Try again in a few minutes.',
  refused: 'The reading was refused. Reload the page and try again.',
  failed: 'The reading failed. Try again in a minute.',
};

const FIND_OUT = 'To find out: supply a sharper image of the same chart without glare, or ask the sender for the data behind it.';

// ---------- elements ----------

const $ = (id) => document.getElementById(id);
const el = {
  page: $('page'), statement: $('statement'), figure: $('figure'), img: $('chart-img'),
  video: $('camera-video'), caption: $('img-caption'), tableWrap: $('table-wrap'), tCaption: $('values-caption'),
  tHead: $('values-head'), tBody: $('values-body'), status: $('status'), statusVerify: $('status-verify'),
  live: $('live'), claim: $('claim'), file: $('file-input'), pick: $('btn-pick'),
  camera: $('btn-camera'), play: $('btn-play'), verify: $('btn-verify'), keys: $('keys'),
  dataBtn: $('btn-data'), dataFile: $('data-input'),
  spoken: $('spoken'), what: $('what'), facts: $('facts'), hear: $('hear'), plot: $('plot'), plotCaption: $('plot-caption'), unread: $('unread'),
};

const state = {
  runId: 0, seq: 0, image: null, label: '', table: null, seconds: 0, verify: null,
  muted: false, stream: null, timers: [], voices: [], playResolve: null, soundUntil: 0,
  data: null, insight: null, plot: null,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- speech and the live region ----------

function announce(text) {
  el.live.textContent = '';
  setTimeout(() => { el.live.textContent = text; }, 40);
}

// One owner for the voice. A sentence ends when the browser says it has ended: the utterance's end
// event, or, if that event never fires, the browser reporting that it is no longer speaking.
// Never a timer guessed from the length of the text.
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
const SPEECH_START_MS = 3000; // a sentence not started by then is skipped; the page never waits on a stuck voice
const SPEECH_CAP_MS = 20000;  // fixed cap for one started sentence
let speechRun = 0;      // changes whenever speech is cancelled or a new speech starts
let lastCancel = 0;
let liveUtterance = null; // kept in a variable so the browser cannot drop its end event
let voice = null;
function pickVoice() {
  if (!synth) return;
  const vs = synth.getVoices();
  voice = vs.find((v) => v.localService && /^en[-_]US/i.test(v.lang)) || vs.find((v) => v.localService && /^en/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
}
if (synth) {
  pickVoice();
  synth.addEventListener('voiceschanged', pickVoice);
}

function stopSpeech() {
  speechRun += 1;
  el.spoken.textContent = '';
  if (synth && (synth.speaking || synth.pending)) {
    synth.cancel();
    lastCancel = performance.now();
  }
}

function speakSentence(text, run) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    liveUtterance = u;
    el.spoken.textContent = text; // every sentence is also seen, large, while it is said
    if (voice) u.voice = voice;
    u.lang = voice ? voice.lang : 'en-US';
    u.rate = SOUND.speechRate;
    const t0 = performance.now();
    let started = false;
    let finished = false;
    let poll = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      if (liveUtterance === u) liveUtterance = null;
      resolve();
    };
    let startedAt = 0;
    u.onstart = () => { started = true; startedAt = performance.now(); };
    u.onend = finish;
    u.onerror = finish;
    // Fallbacks, none of them guessed from the text:
    // - a sentence that has not STARTED 3 s after it was sent is skipped (its text stays on screen);
    // - once started, its end event is awaited, or the browser reporting it stopped speaking, with a fixed 20 s cap.
    const skip = () => {
      synth.cancel();
      lastCancel = performance.now();
      finish();
    };
    poll = setInterval(() => {
      const now = performance.now();
      if (run !== speechRun) { finish(); return; }
      if (!started) { if (now - t0 > SPEECH_START_MS) skip(); return; }
      if (!synth.speaking && !synth.pending) { finish(); return; }
      if (now - startedAt > SPEECH_CAP_MS) skip();
    }, 120);
    synth.speak(u);
  });
}

// Resolves when nothing is being spoken (used before a sound that no key press asked for).
async function untilSilent() {
  const t0 = performance.now();
  while (synth && (synth.speaking || synth.pending) && performance.now() - t0 < 30000) await wait(100);
}

// The built-in voice, sentence by sentence; resolves when the last sentence has actually ended.
// With the voice muted (a screen reader is reading the live region) it waits a reading time instead.
async function speakOnly(text) {
  if (!synth) return;
  if (state.muted) {
    el.spoken.textContent = text;
    const run = speechRun;
    const until = performance.now() + Math.min(12000, 600 + text.length * 65);
    while (performance.now() < until && run === speechRun) await wait(100);
    return;
  }
  if (synth.speaking || synth.pending) {
    synth.cancel();
    lastCancel = performance.now();
  }
  speechRun += 1;
  const run = speechRun;
  const since = performance.now() - lastCancel;
  if (since < 150) await wait(150 - since); // a cancel needs a moment, or the next sentence is clipped
  for (const part of text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)) {
    if (run !== speechRun) return;
    await speakSentence(part, run);
  }
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
  return state.table;
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
  document.querySelectorAll('.cell.sounding').forEach((c) => c.classList.remove('sounding'));
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
function glide(parts, slot, scale = scaleNow()) {
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
          if (c) c.classList.add('sounding');
          moveMarker(part.si, pi); // the marker on the redrawn chart moves as the melody plays
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
function playSeries(si) {
  const s = state.table.series[si];
  const vals = s.points.map((p) => p.value);
  if (!state.plot || state.plot.active !== si) drawPlot(si);
  const seconds = Math.min(SOUND.chartSeconds, Math.max(SOUND.seriesMin, vals.length * SOUND.seriesSlot));
  return glide([{ si, values: vals, label: `Playing ${s.name}.` }], seconds / vals.length);
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

async function supply(source, label) {
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
  el.img.src = dataUrl;
  el.img.hidden = false;
  el.img.alt = 'The chart image supplied. Its values are in the table.';
  el.caption.textContent = label;
  el.figure.hidden = false;
  run();
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
  el.tableWrap.hidden = true;
  el.tHead.textContent = '';
  el.tBody.textContent = '';
  el.claim.hidden = true;
  el.claim.textContent = '';
  el.statusVerify.hidden = true;
  el.statusVerify.textContent = '';
  el.play.disabled = true;
  el.verify.disabled = true;
  el.dataBtn.disabled = true;
  el.statement.className = 'statement';
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
  say(spoken);
}

async function run() {
  if (!state.image) return;
  const runId = ++state.runId;
  resetResult();
  el.caption.textContent = state.label;
  el.statement.textContent = 'Reading';
  const started = performance.now();
  let lateText = '';
  const tick = () => { el.status.textContent = `Reading the chart. ${Math.round((performance.now() - started) / 1000)} s so far.${lateText ? ` ${lateText}` : ''}`; };
  tick();
  const ticker = setInterval(tick, 1000);
  announce('Reading the chart.');
  sign('start');
  // A reading past 30 s says so in one sentence.
  const late = setTimeout(() => {
    if (runId !== state.runId) return;
    lateText = CALL_TEXT.late;
    tick();
    say(lateText);
  }, LATE_MS);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  const image = state.image.slice(state.image.indexOf(',') + 1);
  let payload = null;
  let problem = '';
  if (image.length > SERVER_MAX_BASE64) problem = CALL_TEXT.tooLarge;
  else {
    try {
      const res = await fetch('/api/read-chart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image }),
        signal: controller.signal,
      });
      // The status decides first: a platform error page is not JSON.
      if (res.status === 413) problem = CALL_TEXT.tooLarge;
      else if (res.status === 415) problem = CALL_TEXT.notImage;
      else if (res.status === 429) problem = CALL_TEXT.busy;
      else if (res.status === 403) problem = CALL_TEXT.refused;
      else if (res.status === 504) problem = CALL_TEXT.timeout;
      else if (res.status === 503) {
        const body = await res.json().catch(() => null);
        problem = body && body.error === 'paused' ? CALL_TEXT.paused : CALL_TEXT.failed;
      } else if (!res.ok) problem = CALL_TEXT.failed;
      else payload = await res.json();
    } catch (err) {
      problem = err && err.name === 'AbortError' ? CALL_TEXT.timeout : CALL_TEXT.failed;
    }
  }
  clearTimeout(timeout);
  clearTimeout(late);
  clearInterval(ticker);
  if (runId !== state.runId) return;

  if (problem || !payload || !payload.ok || !payload.reading) {
    const text = problem || CALL_TEXT.failed;
    fail(text, text);
    return;
  }
  state.seconds = (performance.now() - started) / 1000;
  renderReading(payload.reading);
  await untilSilent(); // the result arrived without a key press: a sentence still being spoken finishes first
  if (runId !== state.runId) return;
  await announceReading();
}

// A reading onto the sheet: the table, the headline, the status line. No sound here.
function renderReading(reading) {
  const table = normalise(reading);
  state.table = table;
  if (!table.count) return;
  renderTable(table);
  el.play.disabled = false;
  el.verify.disabled = false;
  el.dataBtn.disabled = false;

  // What the chart says, by plain code from the table: one line, one headline, three key facts.
  const insight = { what: whatText(table), finding: finding(table), facts: keyFacts(table), unread: unreadText(table) };
  // With values unread, the headline says what it is drawn from: it is not as sure as a clean read.
  if (table.missing) insight.finding.text = `From the ${table.count} values read, with ${table.missing} not read: ${insight.finding.text}`;
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
  await say(`${i.what} ${i.finding.text}`);
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
  const vals = t.series.flatMap((s) => s.points.map((p) => p.value)).filter((v) => v !== null);
  const dataMin = Math.min(...vals), dataMax = Math.max(...vals);
  // Axis ticks are round numbers: powers of ten on a log axis spanning a decade or more, else steps of 1, 2 or 5.
  const log = t.log && dataMin > 0 && dataMax / dataMin >= 10;
  let ticks = [];
  if (log) {
    for (let k = Math.floor(Math.log10(dataMin)); k <= Math.ceil(Math.log10(dataMax)); k += 1) ticks.push(10 ** k);
  } else if (dataMax > dataMin) {
    const raw = (dataMax - dataMin) / 3;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    for (let v = Math.floor(dataMin / step) * step; v < dataMax + step; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  } else ticks = [dataMin];
  const min = ticks[0], max = ticks[ticks.length - 1];
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
  for (const v of ticks) {
    g.append(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'plot-grid' }));
    g.append(svgEl('text', { x: L - 8, y: y(v) + 7, 'text-anchor': 'end', class: 'plot-tick' }, fmt(v)));
  }
  const every = t.xs.length > 9 ? Math.ceil(t.xs.length / 6) : 1;
  t.xs.forEach((label, i) => {
    if (i % every === 0 || i === t.xs.length - 1) g.append(svgEl('text', { x: x(i), y: H - 10, 'text-anchor': 'middle', class: 'plot-tick' }, label));
  });
  t.series.forEach((s, si) => {
    if (si !== active) g.append(svgEl('path', { d: path(s.points.map((p) => [xi(p), p.value])), class: 'plot-other' }));
  });
  const s = t.series[active];
  g.append(svgEl('path', { d: path(s.points.map((p) => [xi(p), p.value])), class: 'plot-active' }));
  s.points.forEach((p) => {
    if (p.value !== null) g.append(svgEl('circle', { cx: x(xi(p)), cy: y(p.value), r: 5, class: 'plot-dot' }));
  });
  g.append(svgEl('circle', { id: 'plot-marker', cx: 0, cy: 0, r: 12, class: 'plot-marker', visibility: 'hidden' }));
  state.plot = { active, x, y, xi };
  el.plotCaption.textContent = `Redrawn from the values read${log ? ', log scale' : ''}. Bold line: ${s.name}. The ring moves with the melody.`;
}

function moveMarker(si, pi) {
  const m = document.getElementById('plot-marker');
  if (!m || !state.plot || state.plot.active !== si) return;
  const p = state.table.series[si].points[pi];
  const v = p.value;
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
  const base = `${MODEL_ID} read ${t.count} values in ${state.seconds.toFixed(1)} s.`;
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
  el.tableWrap.classList.toggle('wide', table.xs.length > 4);
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
  paintMain(b, p, outcome);
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
  const text = nameSeries ? `${s.name}, ${p.x}: ${fmtOrNot(p.value)}.` : `${p.x}: ${fmtOrNot(p.value)}.`;
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

// ---------- Verify: plain code against data the user supplies ----------

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
  const rec = state.data && state.data.rec;
  if (!rec) {
    state.verify = null;
    const text = 'Verify needs the data behind this chart: choose a CSV or JSON file with Verify against data.';
    el.statusVerify.hidden = false;
    el.statusVerify.className = 'check check-bad';
    el.statusVerify.textContent = text;
    say(text);
    return;
  }
  const rs = recordSeries(rec);
  const recordName = state.data.name;

  // The same plain check for any reading: each value against the record, within the tolerance.
  const check = (valueAt) => {
    const outcomes = [];
    const counts = { match: 0, mismatch: 0, unknown: 0 };
    t.series.forEach((s, si) => {
      const sk = key(s.name);
      const r = rs.find((q) => key(q.name) === sk) || rs.find((q) => key(q.name) && (sk.startsWith(key(q.name)) || sk.includes(key(q.name))))
        || (rs.length === 1 && t.series.length === 1 ? rs[0] : null); // one series each: they pair up whatever their names
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
          else o = { kind: 'mismatch', record, diff: value - record };
        }
        counts[o.kind] += 1;
        return o;
      });
    });
    return { outcomes, counts };
  };
  const mine = check((si, pi) => t.series[si].points[pi].value);
  const { outcomes, counts } = mine;
  state.verify = { outcomes, counts, recordName };

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
  el.statusVerify.append(checkLine(`Verified: ${short(counts)}.`, counts), small);
  say(`Verified against ${recordName}: ${short(counts)}.`);
}

// ---------- the user's data for Verify: parsed here, in the browser; the file never leaves the page ----------

const DATA_MAX_BYTES = 2_000_000;

// A small CSV reader: commas, double-quoted fields, "" inside quotes, CRLF or LF.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

// CSV to the record shape. Two layouts:
// - a table: header row = x labels (its first cell names the column of series names), one row per series;
// - two columns x,value: one series. A header row is optional.
function csvRecord(text) {
  const rows = parseCsv(text);
  if (!rows.length) return null;
  const twoCols = rows.every((r) => r.length === 2);
  if (twoCols) {
    const header = toNumber(rows[0][1]) === null ? rows[0] : null;
    const body = header ? rows.slice(1) : rows;
    if (!body.length) return null;
    return { cols: body.map((r) => r[0]), values: { [header && header[1] ? header[1] : 'Value']: body.map((r) => toNumber(r[1])) } };
  }
  const [header, ...body] = rows;
  if (header.length < 2 || !body.length) return null;
  const values = {};
  for (const r of body) values[r[0] || `Series ${Object.keys(values).length + 1}`] = header.slice(1).map((_, i) => toNumber(r[i + 1]));
  return { cols: header.slice(1), values };
}

// JSON in the record shape: { title?, cols or x, values or series or panels: { name: [numbers] } }.
// A file holding several such records picks the one whose title matches the chart read, else the first.
function jsonRecord(text) {
  const data = JSON.parse(text);
  const isRecord = (r) => r && typeof r === 'object' && !Array.isArray(r) && ['values', 'series', 'panels'].some((k) => r[k] && typeof r[k] === 'object');
  let rec = isRecord(data) ? data : null;
  if (!rec && data && typeof data === 'object') {
    const all = Object.values(data).filter(isRecord);
    const t = state.table;
    rec = (t && t.title && all.find((r) => r.title && key(t.title).includes(key(r.title)))) || all[0] || null;
  }
  if (!rec) return null;
  const map = rec.values || rec.panels || rec.series;
  const values = {};
  for (const [name, vals] of Object.entries(map)) values[name] = Array.isArray(vals) ? vals.map(toNumber) : [];
  return { title: rec.title, cols: (rec.cols || (Array.isArray(rec.x) ? rec.x : [])).map(String), values };
}

async function loadData(file) {
  act();
  let rec = null;
  try {
    if (file.size > DATA_MAX_BYTES) throw new Error('size');
    const text = await file.text();
    rec = /\.json$/i.test(file.name) || /^\s*[[{]/.test(text) ? jsonRecord(text) : csvRecord(text);
  } catch {
    rec = null;
  }
  if (!rec || !recordSeries(rec).length) {
    const text = 'That data file could not be read. Use a CSV with x labels in the header row, a two-column x,value CSV, or JSON.';
    el.statusVerify.hidden = false;
    el.statusVerify.className = 'check check-bad';
    el.statusVerify.textContent = text;
    say(text);
    return;
  }
  state.data = { rec, name: file.name };
  if (state.table && state.table.count) { verify(); return; }
  const text = `Data loaded: ${file.name}. Verify uses it once a chart is read.`;
  el.statusVerify.hidden = false;
  el.statusVerify.className = 'check';
  el.statusVerify.textContent = text;
  say(text);
}

function isDataFile(f) {
  return f && (/\.(csv|json)$/i.test(f.name) || /^(text\/csv|application\/json)$/.test(f.type));
}

// ---------- wiring ----------

el.pick.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => {
  const f = firstImage(el.file.files);
  if (f) supply(f, 'Image chosen from a file.');
  el.file.value = '';
});
el.camera.addEventListener('click', toggleCamera);
el.verify.addEventListener('click', verify);
el.dataBtn.addEventListener('click', () => el.dataFile.click());
el.dataFile.addEventListener('change', () => {
  const f = el.dataFile.files && el.dataFile.files[0];
  if (f) loadData(f);
  el.dataFile.value = '';
});
el.play.addEventListener('click', replay);

document.addEventListener('paste', (e) => {
  const f = firstImage(e.clipboardData && e.clipboardData.files);
  if (f) { e.preventDefault(); supply(f, 'Image pasted from the clipboard.'); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = e.dataTransfer && e.dataTransfer.files;
  const f = firstImage(files);
  if (f) { supply(f, 'Image dropped on the page.'); return; }
  const d = [...(files || [])].find(isDataFile);
  if (d) loadData(d);
});

function sounding() {
  return performance.now() < state.soundUntil || ('speechSynthesis' in window && window.speechSynthesis.speaking);
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') {
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
  const k = e.key.toLowerCase();
  if (k === 'p' && !el.play.disabled) { e.preventDefault(); replay(); }
  if (k === 'a' && !el.play.disabled) { e.preventDefault(); playAll(); }
  if (k === 'k' && state.insight) { e.preventDefault(); speakFacts(); }
  if (k === 'm') {
    e.preventDefault();
    state.muted = !state.muted;
    if (state.muted) stopSpeech();
    el.keys.textContent = `Keys: P play, A all, K facts, M voice, Esc stop. Voice ${state.muted ? 'off' : 'on'}.`;
    announce(`Built-in voice ${state.muted ? 'off' : 'on'}.`);
  }
});
