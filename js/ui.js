/*
 * ui.js — builds the 244 front panel (meters, channel strips, transport)
 * and wires pointer interaction to the TapeStudio audio engine.
 */
import { TapeStudio } from './audio.js';

const studio = new TapeStudio();
const $ = (s) => document.querySelector(s);

let powered = false;
let paused = false;
let cueOn = false;
let masterBeforeCue = 0.85;

/* Fit-to-viewport scale. The deck is designed at a fixed size; we zoom it
   down so it always fits the available screen height. Drag math below
   compensates for this factor (pointer coords are in screen space, while
   clientWidth/Height report un-zoomed CSS px). */
let FIT = 1;
function fitDeck() {
  const deck = document.getElementById('deck');
  const avail = window.innerHeight - 24; // body padding
  deck.style.zoom = 1;                   // measure un-zoomed layout height
  const natural = deck.offsetHeight;
  FIT = Math.min(1, avail / natural);
  deck.style.zoom = FIT;
}

/* ---------------- knob ---------------- */

function makeKnob({ label, min, max, value, format, onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap';
  const lab = document.createElement('div');
  lab.className = 'knob-label';
  lab.textContent = label;
  const knob = document.createElement('div');
  knob.className = 'knob';
  const dial = document.createElement('div');
  dial.className = 'dial';
  const pointer = document.createElement('div');
  pointer.className = 'pointer';
  dial.appendChild(pointer);
  knob.appendChild(dial);
  const val = document.createElement('div');
  val.className = 'knob-value';
  wrap.append(lab, knob, val);

  let v = value;
  const render = () => {
    const t = (v - min) / (max - min);
    dial.style.transform = `rotate(${-135 + t * 270}deg)`;
    val.textContent = format ? format(v) : v.toFixed(1);
  };
  const set = (nv, emit = true) => {
    v = Math.min(max, Math.max(min, nv));
    render();
    if (emit) onChange(v);
  };

  let dragging = false, startY = 0, startV = 0;
  knob.addEventListener('pointerdown', (e) => {
    dragging = true; startY = e.clientY; startV = v;
    knob.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  knob.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    set(startV + ((startY - e.clientY) / (150 * FIT)) * (max - min));
  });
  const end = () => { dragging = false; };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(v + (e.deltaY < 0 ? 1 : -1) * ((max - min) / 50));
  }, { passive: false });

  render();
  return { el: wrap, set: (nv) => set(nv, false), get: () => v };
}

/* ---------------- fader / slider ---------------- */

function makeFader({ min = 0, max = 1, value = 0.8, horizontal = false, onChange }) {
  const wrap = document.createElement('div');
  wrap.className = horizontal ? 'pitch' : 'fader';
  const slot = document.createElement('div');
  slot.className = 'slot';
  const cap = document.createElement('div');
  cap.className = 'cap';
  wrap.append(slot, cap);

  let v = value;
  const render = () => {
    const t = (v - min) / (max - min);
    if (horizontal) {
      const w = wrap.clientWidth - cap.clientWidth - 4;
      cap.style.left = (2 + t * Math.max(0, w)) + 'px';
    } else {
      const h = wrap.clientHeight - cap.clientHeight - 4;
      cap.style.bottom = (2 + t * Math.max(0, h)) + 'px';
    }
  };
  const set = (nv, emit = true) => {
    v = Math.min(max, Math.max(min, nv));
    render();
    if (emit) onChange(v);
  };

  let dragging = false, startP = 0, startV = 0;
  cap.addEventListener('pointerdown', (e) => {
    dragging = true;
    startP = horizontal ? e.clientX : e.clientY;
    startV = v;
    cap.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  cap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const size = horizontal ? wrap.clientWidth - cap.clientWidth : wrap.clientHeight - cap.clientHeight;
    const p = horizontal ? e.clientX : e.clientY;
    const t = Math.min(1, Math.max(0, (startV - min) / (max - min) + ((p - startP) / (size * FIT)) * (horizontal ? 1 : -1)));
    set(min + t * (max - min));
  });
  const end = () => { dragging = false; };
  cap.addEventListener('pointerup', end);
  cap.addEventListener('pointercancel', end);
  cap.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(v + (e.deltaY < 0 ? 1 : -1) * ((max - min) / 50));
  }, { passive: false });

  requestAnimationFrame(render);
  window.addEventListener('resize', render);
  render();
  return { el: wrap, set: (nv) => set(nv, false), get: () => v };
}

/* ---------------- VU meter ---------------- */

function makeVU(label) {
  const el = document.createElement('div');
  el.className = 'vu';
  const title = document.createElement('div');
  title.className = 'vu-title';
  title.textContent = label;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 70');

  for (const db of [-20, -10, -7, -5, -3, -2, -1, 0, 3]) {
    const a = ((-50 + ((db + 20) / 23) * 100) * Math.PI) / 180;
    const r1 = 40, r2 = db === 0 || db === 3 ? 31 : 35;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', (60 + r1 * Math.sin(a)).toFixed(2));
    line.setAttribute('y1', (58 - r1 * Math.cos(a)).toFixed(2));
    line.setAttribute('x2', (60 + r2 * Math.sin(a)).toFixed(2));
    line.setAttribute('y2', (58 - r2 * Math.cos(a)).toFixed(2));
    line.setAttribute('stroke', '#4a4636');
    line.setAttribute('stroke-width', db === 0 ? 1.5 : 1);
    svg.appendChild(line);
  }
  const arc = document.createElementNS(NS, 'path');
  arc.setAttribute('d', 'M 86.5 22.9 A 44 44 0 0 1 93.7 29.7');
  arc.setAttribute('stroke', 'rgba(200,30,20,0.85)');
  arc.setAttribute('stroke-width', '4');
  arc.setAttribute('fill', 'none');
  svg.appendChild(arc);

  const needle = document.createElementNS(NS, 'line');
  needle.setAttribute('x1', 60); needle.setAttribute('y1', 58);
  needle.setAttribute('x2', 60); needle.setAttribute('y2', 14);
  needle.setAttribute('stroke', '#c0201a');
  needle.setAttribute('stroke-width', '1.5');
  svg.appendChild(needle);
  const hub = document.createElementNS(NS, 'circle');
  hub.setAttribute('cx', 60); hub.setAttribute('cy', 58); hub.setAttribute('r', 4);
  hub.setAttribute('fill', '#2a2a28');
  svg.appendChild(hub);

  el.append(title, svg);
  return {
    el,
    set(rms) {
      const db = Math.max(-20, Math.min(3, 20 * Math.log10(rms + 1e-6)));
      const angle = -50 + ((db + 20) / 23) * 100;
      needle.setAttribute('transform', `rotate(${angle.toFixed(2)} 60 58)`);
    },
  };
}

/* ---------------- channel strips ---------------- */

const dbFmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);
const hzFmt = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + '');
const panFmt = (v) => (v === 0 ? 'C' : v < 0 ? 'L' + Math.round(-v * 10) : 'R' + Math.round(v * 10));

const meters = [];
const leds = [];
const trackInds = [];
const channelsEl = $('#channels');
const metersEl = $('#meters');

for (let i = 0; i < 4; i++) {
  const vu = makeVU('CH ' + (i + 1));
  metersEl.appendChild(vu.el);
  meters.push(vu);

  const ch = document.createElement('div');
  ch.className = 'ch';

  const num = document.createElement('div');
  num.className = 'ch-num';
  num.textContent = 'CH ' + (i + 1);
  ch.appendChild(num);

  // 3-way input selector
  const inp = document.createElement('div');
  inp.className = 'inp';
  for (const [mode, text] of [['mic', 'MIC/LINE'], ['off', 'OFF'], ['tape', 'TAPE']]) {
    const b = document.createElement('button');
    b.textContent = text;
    b.dataset.mode = mode;
    if (mode === 'mic') b.classList.add('active');
    b.addEventListener('click', () => {
      inp.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      studio.setInputMode(i, mode);
    });
    inp.appendChild(b);
  }
  ch.appendChild(inp);

  // record-arm: this channel is included in the next REC
  const arm = document.createElement('button');
  arm.className = 'arm-btn' + (studio.uiState.channels[i].armed ? ' active' : '');
  arm.innerHTML = '<span class="arm-led"></span>REC';
  arm.title = 'Record arm this channel';
  arm.addEventListener('click', () => {
    const on = !arm.classList.contains('active');
    arm.classList.toggle('active', on);
    studio.setArm(i, on);
  });
  ch.appendChild(arm);

  // overload LED
  const ledRow = document.createElement('div');
  ledRow.className = 'led-row';
  const led = document.createElement('div');
  led.className = 'led';
  ledRow.append(led, document.createTextNode('PEAK'));
  ch.appendChild(ledRow);
  leds.push(led);

  // TRIM
  ch.appendChild(makeKnob({
    label: 'TRIM', min: -12, max: 12, value: 0, format: dbFmt,
    onChange: (db) => studio.setTrim(i, db),
  }).el);

  // 2-band EQ
  const eq = document.createElement('div');
  eq.className = 'eq-pair';
  eq.append(
    makeKnob({ label: 'LO FREQ', min: 100, max: 500, value: 250, format: hzFmt,
      onChange: (hz) => studio.setLoFreq(i, hz) }).el,
    makeKnob({ label: 'LO GAIN', min: -12, max: 12, value: 0, format: dbFmt,
      onChange: (db) => studio.setLoGain(i, db) }).el,
    makeKnob({ label: 'HI FREQ', min: 2000, max: 8000, value: 4000, format: hzFmt,
      onChange: (hz) => studio.setHiFreq(i, hz) }).el,
    makeKnob({ label: 'HI GAIN', min: -12, max: 12, value: 0, format: dbFmt,
      onChange: (db) => studio.setHiGain(i, db) }).el,
  );
  ch.appendChild(eq);

  // PAN
  ch.appendChild(makeKnob({
    label: 'PAN', min: -1, max: 1, value: 0, format: panFmt,
    onChange: (v) => studio.setPan(i, v),
  }).el);

  // fader + scale
  const faderCol = document.createElement('div');
  faderCol.className = 'fader-col';
  const scale = document.createElement('div');
  scale.className = 'fader-scale';
  for (const t of ['+4', '0', '-10', '-20', '-40']) scale.appendChild(document.createTextNode(t));
  const fader = makeFader({
    min: 0, max: 1, value: 0.8,
    onChange: (v) => studio.setFader(i, v),
  });
  faderCol.append(fader.el, scale);
  ch.appendChild(faderCol);

  // track indicator + save
  const ind = document.createElement('div');
  ind.className = 'track-ind';
  ind.textContent = 'TRACK ' + (i + 1);
  ch.appendChild(ind);
  trackInds.push(ind);

  const save = document.createElement('button');
  save.className = 'aux-btn';
  save.style.padding = '3px 10px';
  save.style.fontSize = '8px';
  save.textContent = 'SAVE WAV';
  save.style.display = 'none';
  save.addEventListener('click', () => saveTrack(i));
  ch.appendChild(save);
  ch._saveBtn = save;

  channelsEl.appendChild(ch);
}

/* ---------------- transport ---------------- */

const statusEl = $('#status');
const counterEl = $('#counter');
const powerBtn = $('#power');
const cueBtn = $('#cue');
const dbxBtn = $('#dbx');
const keyEls = {};
document.querySelectorAll('#piano .key').forEach((k) => {
  keyEls[k.dataset.key] = k;
});

function setStateText(state) {
  statusEl.classList.remove('rec', 'play');
  if (state === 'recording') { statusEl.textContent = 'RECORDING'; statusEl.classList.add('rec'); }
  else if (state === 'playing') { statusEl.textContent = 'PLAYING'; statusEl.classList.add('play'); }
  else if (paused) statusEl.textContent = 'PAUSED';
  else statusEl.textContent = 'STANDBY';
  keyEls.rec.classList.toggle('active', state === 'recording');
  keyEls.play.classList.toggle('active', state === 'playing');
}

studio.onStateChange = setStateText;
studio.onTrackRecorded = (i, has) => {
  trackInds[i].classList.toggle('has', has);
  trackInds[i].textContent = has ? 'TRACK ' + (i + 1) + ' ●' : 'TRACK ' + (i + 1);
  channelsEl.children[i]._saveBtn.style.display = has ? '' : 'none';
  mixBtn.style.display = studio.tracks.some(Boolean) ? '' : 'none';
};

const mixBtn = document.createElement('button');
mixBtn.className = 'aux-btn';
mixBtn.textContent = 'SAVE MIX';
mixBtn.title = 'Save all recorded tracks mixed to one stereo WAV';
mixBtn.style.display = 'none';
mixBtn.addEventListener('click', saveMix);
cueBtn.parentElement.appendChild(mixBtn);

const clearBtn = document.createElement('button');
clearBtn.className = 'aux-btn';
clearBtn.textContent = 'CLEAR ALL';
clearBtn.title = 'Erase all recorded tracks and start over';
clearBtn.addEventListener('click', async () => {
  if (!window.confirm('Radera alla inspelningar och börja om?')) return;
  await studio.clearAll();
  setStateText('stopped');
});
cueBtn.parentElement.appendChild(clearBtn);

powerBtn.addEventListener('click', async () => {
  if (!powered) {
    try {
      await studio.init();
      powered = true;
      powerBtn.classList.add('on');
      if (studio.micError) statusEl.textContent = 'NO MIC';
    } catch (e) {
      console.error(e);
      statusEl.textContent = 'MIC ERROR';
    }
  } else {
    powered = false;
    paused = false;
    powerBtn.classList.remove('on');
    if (studio.ctx) await studio.ctx.close();
    studio.ctx = null;
    setStateText('stopped');
  }
});

const doStop = async () => { paused = false; await studio.stop(); setStateText('stopped'); };
const doPlay = async () => {
  if (paused) { paused = false; await studio.resume(); setStateText('playing'); return; }
  await studio.play();
};
const doRec = async () => {
  if (paused) { paused = false; await studio.resume(); setStateText('recording'); return; }
  await studio.record();
};

keyEls.stop.addEventListener('click', doStop);
keyEls.play.addEventListener('click', doPlay);
keyEls.rec.addEventListener('click', doRec);
keyEls.rew.addEventListener('click', () => { studio._frozenElapsed = 0; studio._sessionStart = studio.ctx ? studio.ctx.currentTime : 0; });
keyEls.ff.addEventListener('click', () => { studio._frozenElapsed = 0; studio._sessionStart = studio.ctx ? studio.ctx.currentTime : 0; });
keyEls.pause.addEventListener('click', async () => {
  if (!studio.ctx) return;
  if (!paused) {
    await studio.ctx.suspend();
    paused = true;
  } else {
    await studio.ctx.resume();
    paused = false;
  }
  setStateText(studio.state);
});

cueBtn.addEventListener('click', () => {
  cueOn = !cueOn;
  cueBtn.classList.toggle('active', cueOn);
  if (cueOn) {
    masterBeforeCue = masterFader.get();
    masterFader.set(1);
  } else {
    masterFader.set(masterBeforeCue);
  }
});

dbxBtn.addEventListener('click', () => {
  const on = !dbxBtn.classList.contains('active');
  dbxBtn.classList.toggle('active', on);
  studio.setDbx(on);
});

/* ---------------- pitch & master ---------------- */

const pitchSlider = makeFader({
  min: 0.75, max: 1.25, value: 1.0, horizontal: true,
  onChange: (v) => studio.setPitch(v),
});
$('#pitch').replaceWith(pitchSlider.el);
pitchSlider.el.id = 'pitch';

const masterFader = makeFader({
  min: 0, max: 1, value: 0.85, horizontal: true,
  onChange: (v) => studio.setMaster(v),
});
$('#master-fader').replaceWith(masterFader.el);
masterFader.el.id = 'master-fader';

/* ---------------- fit to viewport ---------------- */

fitDeck();
window.addEventListener('resize', fitDeck);

/* ---------------- meter loop ---------------- */

function frame() {
  requestAnimationFrame(frame);
  if (!powered || !studio.ctx || studio.ctx.state !== 'running') return;
  const lv = studio.readLevels();
  lv.ch.forEach((rms, i) => meters[i].set(rms));
  lv.led.forEach((on, i) => leds[i].classList.toggle('on', on));
  studio.applyGate(lv.master);
  counterEl.textContent = String(Math.floor(studio.elapsed() * 30) % 10000).padStart(4, '0');
}
requestAnimationFrame(frame);

/* ---------------- WAV export ---------------- */

function audioBufferToWav(buffer) {
  const nCh = buffer.numberOfChannels;
  const len = buffer.length * nCh * 2;
  const ab = new ArrayBuffer(44 + len);
  const dv = new DataView(ab);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + len, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nCh, true);
  dv.setUint32(24, buffer.sampleRate, true);
  dv.setUint32(28, buffer.sampleRate * nCh * 2, true);
  dv.setUint16(32, nCh * 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, len, true);
  let off = 44;
  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function downloadWav(buffer, name) {
  const url = URL.createObjectURL(audioBufferToWav(buffer));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function saveTrack(i) {
  const buf = studio.tracks[i];
  if (!buf) return;
  downloadWav(buf, `portastudio-track-${i + 1}.wav`);
}

async function saveMix() {
  const buf = await studio.mixdown();
  if (buf) downloadWav(buf, 'portastudio-mix.wav');
}
