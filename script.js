const isController = location.search.includes('room=');
const roomParam = isController ? new URLSearchParams(location.search).get('room') : null;

/* WAVEFORM ENGINE */
const waveConfigs = [
  {id:'ecgC', color:'#00ff41', sample: ecgSample, scale:.38},
  {id:'spo2C', color:'#00aaff', sample: spo2Sample, scale:.42},
  {id:'respC', color:'#ffaa00', sample: respSample, scale:.38},
];
const waveStates = waveConfigs.map(cfg => {
  const canvas = document.getElementById(cfg.id);
  const ctx = canvas ? canvas.getContext('2d') : null;
  return { ...cfg, canvas, ctx, width: 0, height: 0, buf: new Float32Array(1).fill(35), wp: 0 };
}).filter(state => state.ctx);
let lastT = null;
let acc = 0;
let ecgPhase = 0;
let respPhase = 0;
let vfPhase = 0;

// Visible time window for the trace. 6 s is the standard clinical strip duration —
// ~25 mm/sec equivalent on a typical screen — and shows more cycles per sweep.
const TARGET_SECONDS_VISIBLE = 6;
// Pulse transit time used to phase-lock the SpO2 pleth to the ECG R-wave.
const PTT_SEC = 0.25;
// Canvas bitmaps are rendered at a constant internal resolution and stretched by
// CSS — same behaviour as a fixed-size video frame. This makes the trace look
// identical at every container size; the monitor grid then scales as a whole
// via --monitor-scale on .monitor-grid.
const REF_WAVE_WIDTH = 2400;
const REF_WAVE_HEIGHT = 300;

const initialMonitorState = {
  hr:72, spo2:98, rr:16, temp:36.7, sbp:120, dbp:80, rhythm:'NSR'
};

let cur = {...initialMonitorState};
let tgt = {...initialMonitorState};
let rampEndTime = 0;
const RAMP_DURATION = 10;
const metricEnabled = {
  hr: true,
  spo2: true,
  sbp: true,
  dbp: true,
  rr: true,
  temp: true
};

function lerp(a, b, f){ return a + (b - a) * f; }
function clamp(v, min, max){ return Math.min(max, Math.max(min, v)); }
function smoothValue(current, target, speed, dt){
  const alpha = 1 - Math.exp(-speed * dt);
  return lerp(current, target, alpha);
}
function smoothStep(edge0, edge1, x){
  const n = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
  return n * n * (3 - 2 * n);
}

function getEffectivePulseRate(state){
  if(state.rhythm === 'VT') return clamp(state.hr || 180, 120, 250);
  if(state.rhythm === 'VF') return 0;
  return Math.max(state.hr, 0);
}

function getCurrentSweepRate(){
  // Canvas pixels per second. Derived from canvas width so the visible time window
  // stays at TARGET_SECONDS_VISIBLE regardless of canvas size (small vs fullscreen).
  const primary = waveStates[0];
  if(!primary || !primary.width) return 0;
  return primary.width / TARGET_SECONDS_VISIBLE;
}

function getEcgIntervals(hr){
  const rrSec = 60 / Math.max(hr, 1);
  // Bazett-style square-root shortening for PR/QT as HR rises.
  const sqrtRR = Math.sqrt(Math.min(rrSec, 1.5));
  let prInterval = 0.16 * sqrtRR;   // P start → QRS start
  let qtInterval = 0.40 * sqrtRR;   // QRS start → T end
  const qrsDur = 0.090;
  // Stop events from spilling into the TP segment at extreme rates.
  const totalEvents = prInterval + qtInterval;
  const maxWindow = 0.85 * rrSec;
  if(totalEvents > maxWindow){
    const scale = maxWindow / totalEvents;
    prInterval *= scale;
    qtInterval *= scale;
  }
  // Keep P inside the PR interval so it cannot bleed into the QRS.
  const pDur = Math.max(0.04, Math.min(0.085, prInterval * 0.85));
  return { rrSec, pDur, prInterval, qrsDur, qtInterval };
}

function getPlethPhase(){
  // Pleth foot aligns with R-peak + PTT, so the upstroke lags QRS by ~250 ms.
  const hr = Math.max(cur.hr, 1);
  const { rrSec, prInterval, qrsDur } = getEcgIntervals(hr);
  const rPeakTime = prInterval + qrsDur * 0.32;
  const offsetPhase = (rPeakTime + PTT_SEC) / rrSec;
  return ((ecgPhase - offsetPhase) % 1 + 1) % 1;
}

function ecgSample(phase, s){
  if(!metricEnabled.hr) return 0;
  if(s.rhythm === 'VF'){
    // Coarse-to-fine VF with a slow amplitude envelope to break up the uniform-noise look.
    const envelope = 0.65 + 0.22 * Math.sin(vfPhase * 0.3);
    return envelope * ((Math.random() - .5) * .65
                      + .22 * Math.sin(vfPhase)
                      + .12 * Math.sin(vfPhase * 1.9));
  }
  if(s.rhythm === 'VT'){
    const theta = 2 * Math.PI * phase;
    const tri = (2 / Math.PI) * Math.asin(Math.sin(theta));
    const shape =
      0.9 * tri +
      0.22 * Math.sin(2 * theta - 0.5) +
      0.10 * Math.sin(3 * theta + 0.9);
    return 1.08 * shape;
  }
  if(s.hr <= 0) return 0;

  const { rrSec, pDur, prInterval, qrsDur, qtInterval } = getEcgIntervals(s.hr);
  const t = phase * rrSec;
  const qrsStart = prInterval;
  const qrsEnd = qrsStart + qrsDur;
  const tEnd = qrsStart + qtInterval;
  const tDur = Math.max(qtInterval * 0.45, 0.08);
  const tStart = tEnd - tDur;

  const perfusion = clamp((s.sbp + s.dbp) / 210, 0.35, 1.15);
  const tempGain = clamp(1 + (s.temp - 36.7) * 0.03, 0.9, 1.08);
  const qrsGain = perfusion * tempGain;

  let y = 0;

  // P wave (rounded positive deflection, ~85 ms).
  if(t >= 0 && t < pDur){
    y += 0.10 * Math.sin(Math.PI * (t / pDur));
  }

  // QRS complex — Q dip, R peak, S dip, with a brief return to baseline.
  if(t >= qrsStart && t < qrsEnd){
    const u = (t - qrsStart) / qrsDur;
    if(u < 0.15) y -= 0.08 * (u / 0.15) * qrsGain;
    else if(u < 0.50) y += 0.98 * Math.sin(Math.PI * (u - 0.15) / 0.35) * qrsGain;
    else if(u < 0.85) y -= 0.22 * Math.sin(Math.PI * (u - 0.50) / 0.35) * qrsGain;
  }

  // T wave (broad positive after the ST segment).
  if(t >= tStart && t < tEnd){
    const u = (t - tStart) / tDur;
    const oxyGain = clamp((s.spo2 / 98) * 0.7 + 0.3, 0.15, 1.1);
    y += 0.20 * Math.sin(Math.PI * u) * oxyGain;
  }

  return y + (Math.random() - .5) * 0.01;
}

function spo2Sample(phase, s){
  if(!metricEnabled.spo2) return 0;
  if(s.spo2 <= 0 || s.hr <= 0) return (Math.random() - .5) * .05;
  const perfusion = clamp((s.sbp + 2 * s.dbp) / 280, 0.12, 1.1);
  const oxyGain = clamp(s.spo2 / 98, 0.08, 1.02);
  const rise = Math.pow(Math.sin(Math.PI * smoothStep(0, .32, phase)), 1.55);
  const decay = Math.exp(-Math.max(0, phase - .16) * 4.8);
  const notch = .12 * Math.exp(-Math.pow((phase - .46) / .055, 2));
  const baseline = .02 * Math.sin(Math.PI * phase * 2);
  const y = rise * decay + notch + baseline;
  return y * perfusion * oxyGain + (Math.random() - .5) * .012;
}

function respSample(phase, s){
  if(!metricEnabled.rr) return 0;
  if(s.rr <= 0) return (Math.random() - .5) * .03;
  const amp = clamp(0.32 + (s.temp - 35) * 0.025 + (s.spo2 / 100) * 0.1, 0.22, 0.62);
  // I:E ~ 1:2 — steeper rise during inspiration, slower fall during expiration.
  const iFrac = 0.34;
  let wave;
  if(phase < iFrac){
    const u = phase / iFrac;
    wave = -Math.cos(Math.PI * u);
  } else {
    const u = (phase - iFrac) / (1 - iFrac);
    wave = Math.cos(Math.PI * u);
  }
  return amp * wave + (Math.random() - .5) * .02;
}

function getPhaseForState(state){
  if(state.id === 'ecgC') return ecgPhase;
  if(state.id === 'spo2C') return getPlethPhase();
  return respPhase;
}

function getPhaseStepForState(state, currentState){
  const rate = getCurrentSweepRate();
  if(!rate) return 0;
  const sweepDt = 1 / rate;
  if(state.id === 'ecgC' || state.id === 'spo2C'){
    return sweepDt * getEffectivePulseRate(currentState) / 60;
  }
  return sweepDt * Math.max(currentState.rr, 0) / 60;
}

function rebuildWaveBuffer(state, currentState){
  const centerY = state.height / 2;
  const phaseNow = getPhaseForState(state);
  const phaseStep = getPhaseStepForState(state, currentState);
  const newBuf = new Float32Array(state.width);

  for(let x = 0; x < state.width; x++){
    const raw = phaseNow - (state.width - 1 - x) * phaseStep;
    const phase = ((raw % 1) + 1) % 1;
    newBuf[x] = centerY - state.sample(phase, currentState) * (state.height * state.scale);
  }

  state.buf = newBuf;
  state.wp = state.width - 1;
}

function resizeWaveDisplays(){
  waveStates.forEach(state => {
    if(state.canvas.width !== REF_WAVE_WIDTH || state.canvas.height !== REF_WAVE_HEIGHT){
      state.canvas.width = REF_WAVE_WIDTH;
      state.canvas.height = REF_WAVE_HEIGHT;
      state.width = REF_WAVE_WIDTH;
      state.height = REF_WAVE_HEIGHT;
      rebuildWaveBuffer(state, cur);
    }
  });
}

function drawWave(state){
  const {ctx, buf, color, width, height, wp} = state;
  if(!width || !height) return;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1.25;
  const xStep = Math.max(24, Math.round(width / 12));
  for(let x = 0; x < width; x += xStep){
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for(let y = 0; y < height; y += height / 4){
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Maintain a small blank gap at the sweep head so the trace never self-connects.
  const gapHalf = Math.max(6, Math.round(width / 90));
  let gapStart = wp - gapHalf;
  let gapEnd = wp + gapHalf;
  ctx.fillStyle = '#000000';
  if(gapStart >= 0 && gapEnd < width){
    ctx.fillRect(gapStart, 0, gapEnd - gapStart + 1, height);
  } else {
    if(gapStart < 0){
      ctx.fillRect(0, 0, gapEnd + 1, height);
      ctx.fillRect(width + gapStart, 0, -gapStart, height);
    }
    if(gapEnd >= width){
      ctx.fillRect(gapStart, 0, width - gapStart, height);
      ctx.fillRect(0, 0, gapEnd - width + 1, height);
    }
  }

  const inGap = (x) => {
    const d = (x - wp + width) % width;
    return d <= gapHalf || d >= width - gapHalf;
  };

  // Draw contiguous non-gap segments only.
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.75;
  let drawing = false;
  for(let x = 0; x < width; x++){
    if(inGap(x)){
      if(drawing){
        ctx.stroke();
        drawing = false;
      }
      continue;
    }
    if(!drawing){
      ctx.beginPath();
      ctx.moveTo(x, buf[x]);
      drawing = true;
    } else {
      ctx.lineTo(x, buf[x]);
    }
  }
  if(drawing){
    ctx.stroke();
  }
}

function updateNumerics(){
  const offValue = '- -';
  const el = (id, v) => {
    const e = document.getElementById(id);
    if(e) e.textContent = v;
  };
  el('hr', metricEnabled.hr ? (cur.hr > 0 ? Math.round(cur.hr) : '---') : offValue);
  el('spo2', metricEnabled.spo2 ? (cur.spo2 > 0 ? Math.round(cur.spo2) : '---') : offValue);
  el('rr', metricEnabled.rr ? (cur.rr > 0 ? Math.round(cur.rr) : '---') : offValue);
  el('temp', metricEnabled.temp ? cur.temp.toFixed(1) : offValue);
  const nibpEnabled = metricEnabled.sbp && metricEnabled.dbp;
  el('nibp', nibpEnabled ? (cur.sbp > 0 ? `${Math.round(cur.sbp)}/${Math.round(cur.dbp)}` : '---/---') : offValue);
  el('map', nibpEnabled && cur.sbp > 0 ? `MAP ${Math.round((cur.sbp + 2 * cur.dbp) / 3)}` : '');
  const rh = document.getElementById('rhythm');
  if(rh){
    rh.textContent = '';
  }
}

function monitorFrame(ts){
  if(!lastT) lastT = ts;
  const dt = Math.min((ts - lastT) / 1000, .05);
  lastT = ts;
  resizeWaveDisplays();
  const nowSec = ts / 1000;
  const rampActive = nowSec < rampEndTime;
  const rampSpeed = rampActive ? (1 / RAMP_DURATION) * 1.5 : null;
  cur.hr = smoothValue(cur.hr, tgt.hr, rampSpeed ?? 3.8, dt);
  cur.spo2 = smoothValue(cur.spo2, tgt.spo2, rampSpeed ?? 2.2, dt);
  cur.rr = smoothValue(cur.rr, tgt.rr, rampSpeed ?? 3.2, dt);
  cur.sbp = smoothValue(cur.sbp, tgt.sbp, rampSpeed ?? 2.4, dt);
  cur.dbp = smoothValue(cur.dbp, tgt.dbp, rampSpeed ?? 2.4, dt);
  cur.temp = smoothValue(cur.temp, tgt.temp, rampSpeed ?? 0.8, dt);
  cur.rhythm = tgt.rhythm;
  updateNumerics();

  acc += dt * getCurrentSweepRate();
  const steps = Math.floor(acc);
  acc -= steps;
  for(let s = 0; s < steps; s++){
    const sampleDt = dt / Math.max(steps, 1);
    if(cur.rhythm === 'VF') vfPhase += sampleDt * 24;
    const pulseRate = getEffectivePulseRate(cur);
    ecgPhase = (ecgPhase + sampleDt * pulseRate / 60) % 1;
    respPhase = (respPhase + sampleDt * Math.max(cur.rr, 0) / 60) % 1;
    waveStates.forEach(state => {
      const phase = getPhaseForState(state);
      const centerY = state.height / 2;
      state.buf[state.wp] = centerY - state.sample(phase, cur) * (state.height * state.scale);
      state.wp = (state.wp + 1) % state.width;
    });
  }
  waveStates.forEach(drawWave);
  requestAnimationFrame(monitorFrame);
}

/* MONITOR PEER SETUP */
function setupMonitor(){
  document.getElementById('monitorView').style.display = 'flex';
  resizeWaveDisplays();
  requestAnimationFrame(monitorFrame);

  const roomId = 'pm-' + Math.random().toString(36).slice(2, 8);
  document.getElementById('roomIdLabel').textContent = roomId;

  const peer = new Peer(roomId, {debug:0});
  peer.on('open', id => {
    const url = location.href.split('?')[0] + '?room=' + id;
    document.getElementById('roomIdLabel').textContent = url;
    const qrImage = document.getElementById('qrImage');
    qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
  });

  peer.on('connection', conn => {
    const peerStatus = document.getElementById('peerStatus');
    if(peerStatus){
      peerStatus.textContent = 'Controller connected';
      peerStatus.className = 'peer-status connected';
    }
    conn.on('data', msg => {
      if(msg.type === 'rhythm'){
        tgt.rhythm = msg.value;
      } else if(msg.type === 'obs'){
        tgt[msg.key] = clampObsValue(msg.key, msg.value);
      } else if(msg.type === 'ramp'){
        Object.keys(msg.values).forEach(k => {
          tgt[k] = clampObsValue(k, msg.values[k]);
        });
        rampEndTime = performance.now() / 1000 + RAMP_DURATION;
      } else if(msg.type === 'metric'){
        getMetricGroupKeys(msg.key).forEach(k => {
          metricEnabled[k] = !!msg.enabled;
        });
      }
    });
    conn.on('close', () => {
      if(peerStatus){
        peerStatus.textContent = 'Waiting for controller';
        peerStatus.className = 'peer-status';
      }
    });
  });
}

/* CONTROLLER SETUP */
let ctrlConn = null;
let ctrlState = {
  hr:72, spo2:98, rr:16, temp:36.7, sbp:120, dbp:80
};
let ctrlRhythm = 'NSR';
let holdActive = false;
let heldState = null;

const obsConfig = [
  {key:'hr',   label:'HR',   unit:'bpm', color:'#00ff41', step:1,  min:0,   max:300},
  {key:'spo2', label:'SpO₂', unit:'%',   color:'#00aaff', step:1,  min:0,   max:100},
  {key:'sbp',  label:'SBP',  unit:'mmHg',color:'#ff66aa', step:2,  min:0,   max:250},
  {key:'dbp',  label:'DBP',  unit:'mmHg',color:'#ff66aa', step:2,  min:0,   max:200},
  {key:'rr',   label:'RR',   unit:'br/m',color:'#ffaa00', step:1,  min:0,   max:60},
  {key:'temp', label:'Temp', unit:'°C',  color:'#ff8844', step:0.1,min:32,  max:42},
];

function getMetricGroupKeys(key){
  if(key === 'sbp' || key === 'dbp') return ['sbp', 'dbp'];
  return [key];
}

function getObsConfig(key){
  return obsConfig.find(o => o.key === key);
}

function clampObsValue(key, value){
  const cfg = getObsConfig(key);
  return cfg ? clamp(value, cfg.min, cfg.max) : Math.max(0, value);
}

const noSleep = new NoSleep();
function enableNoSleep(){
  noSleep.enable();
}
document.addEventListener('click', enableNoSleep, { once: true });
document.addEventListener('touchstart', enableNoSleep, { once: true });

function buildObsRows(){
  const container = document.getElementById('obsRows');
  container.innerHTML = '';
  obsConfig.forEach(o => {
    const row = document.createElement('div');
    row.className = 'obs-row';
    row.dataset.key = o.key;
    const val = formatVal(o.key, ctrlState[o.key]);
    row.innerHTML = `
      <div class="obs-head">
        <div class="obs-meta">
          <div class="obs-name">${o.label}</div>
          <div class="obs-unit">${o.unit}</div>
        </div>
        <button class="obs-toggle ${metricEnabled[o.key] ? 'on' : 'off'}" type="button" data-action="toggle" data-key="${o.key}">${metricEnabled[o.key] ? 'On' : 'Off'}</button>
      </div>
      <div class="obs-controls">
        <button class="obs-btn" type="button" data-action="decrease" data-key="${o.key}">-</button>
        <input class="obs-input" id="cv-${o.key}" type="number" inputmode="decimal" step="${o.step}" min="${o.min}" max="${o.max}" value="${val}" aria-label="${o.label}">
        <button class="obs-btn" type="button" data-action="increase" data-key="${o.key}">+</button>
      </div>`;
    row.querySelector('[data-action="decrease"]').addEventListener('click', () => nudge(o.key, -o.step));
    row.querySelector('[data-action="increase"]').addEventListener('click', () => nudge(o.key, o.step));
    row.querySelector('[data-action="toggle"]').addEventListener('click', () => toggleMetric(o.key));
    const input = row.querySelector('.obs-input');
    input.addEventListener('change', () => applyManualInput(o.key, input.value));
    input.addEventListener('blur', () => applyManualInput(o.key, input.value));
    container.appendChild(row);
    syncMetricControls(o.key);
  });
}

function formatVal(key, v){
  if(key === 'temp') return v.toFixed(1);
  return Math.round(v);
}

function nudge(key, delta){
  const nextValue = clampObsValue(key, ctrlState[key] + delta);
  ctrlState[key] = nextValue;
  syncControllerField(key);
  if(holdActive){
    heldState[key] = nextValue;
    syncHoldIndicators();
  } else {
    if(ctrlConn) ctrlConn.send({type:'obs', key, value: nextValue});
    flashInput(key);
  }
}

function syncControllerField(key){
  const el = document.getElementById('cv-' + key);
  if(!el) return;
  el.value = formatVal(key, ctrlState[key]);
}

function applyManualInput(key, rawValue){
  const cfg = getObsConfig(key);
  if(!cfg) return;
  const parsed = Number.parseFloat(rawValue);
  if(Number.isNaN(parsed)){
    syncControllerField(key);
    return;
  }
  const nextValue = clampObsValue(key, parsed);
  ctrlState[key] = nextValue;
  syncControllerField(key);
  if(holdActive){
    heldState[key] = nextValue;
    syncHoldIndicators();
  } else {
    if(ctrlConn) ctrlConn.send({type:'obs', key, value: nextValue});
    flashInput(key);
  }
}

function syncMetricControls(key){
  const enabled = !!metricEnabled[key];
  const input = document.getElementById('cv-' + key);
  if(input) syncControllerField(key);

  const row = document.querySelector(`.obs-row[data-key="${key}"]`);
  if(row) row.classList.toggle('obs-off', !enabled);

  const toggleBtn = document.querySelector(`.obs-toggle[data-key="${key}"]`);
  if(toggleBtn){
    toggleBtn.className = 'obs-toggle ' + (enabled ? 'on' : 'off');
    toggleBtn.textContent = enabled ? 'On' : 'Off';
    toggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  }
}

function toggleMetric(key){
  const keys = getMetricGroupKeys(key);
  const nextEnabled = !metricEnabled[keys[0]];
  keys.forEach(k => {
    metricEnabled[k] = nextEnabled;
    syncMetricControls(k);
    if(ctrlConn) ctrlConn.send({type:'metric', key: k, enabled: nextEnabled});
  });
}

function flashInput(key){
  const input = document.getElementById('cv-' + key);
  if(!input) return;
  input.classList.remove('obs-flash');
  void input.offsetWidth;
  input.classList.add('obs-flash');
  input.addEventListener('animationend', () => input.classList.remove('obs-flash'), { once: true });
}

function syncHoldIndicators(){
  obsConfig.forEach(o => {
    const input = document.getElementById('cv-' + o.key);
    if(!input) return;
    const staged = holdActive && heldState && heldState[o.key] !== undefined;
    input.classList.toggle('obs-staged', staged);
  });
}

function toggleHold(){
  holdActive = !holdActive;
  const btn = document.getElementById('holdBtn');
  if(holdActive){
    heldState = {};
    if(btn){
      btn.textContent = 'Release';
      btn.classList.add('hold-active');
    }
  } else {
    if(heldState && ctrlConn){
      const keys = Object.keys(heldState);
      ctrlConn.send({type:'ramp', values: {...heldState}});
      keys.forEach(flashInput);
    }
    heldState = null;
    syncHoldIndicators();
    if(btn){
      btn.textContent = 'Hold';
      btn.classList.remove('hold-active');
    }
  }
}

function setRhythm(rhythm){
  ctrlRhythm = rhythm;
  if(ctrlConn) ctrlConn.send({type:'rhythm', value: rhythm});
}

function lockControllerZoom(){
  let lastTouchEnd = 0;

  document.addEventListener('gesturestart', e => {
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('gesturechange', e => {
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('gestureend', e => {
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', e => {
    const now = Date.now();
    if(now - lastTouchEnd <= 300){
      e.preventDefault();
    }
    lastTouchEnd = now;
  }, { passive: false });
}

function setupController(){
  document.body.classList.add('controller-mode');
  document.getElementById('monitorView').style.display = 'none';
  document.getElementById('controllerView').className = 'ctrl-wrap show';
  lockControllerZoom();
  const rhythmSelect = document.getElementById('rhythmSelect');
  if(rhythmSelect){
    rhythmSelect.value = ctrlRhythm;
    rhythmSelect.addEventListener('change', () => setRhythm(rhythmSelect.value));
  }
  buildObsRows();

  const holdBtn = document.getElementById('holdBtn');
  if(holdBtn) holdBtn.addEventListener('click', toggleHold);

  const peer = new Peer({debug:0});
  peer.on('open', () => {
    const conn = peer.connect(roomParam, {reliable:true});
    ctrlConn = conn;
    conn.on('open', () => {
      conn.send({type:'rhythm', value: ctrlRhythm});
      obsConfig.forEach(o => {
        conn.send({type:'metric', key: o.key, enabled: metricEnabled[o.key]});
      });
    });
    conn.on('close', () => {
      ctrlConn = null;
    });
  });
  peer.on('error', () => {
    ctrlConn = null;
  });
}

if(isController){
  setupController();
} else {
  setupMonitor();
}

const fsBtn = document.getElementById('fsBtn');
const monitorStage = document.querySelector('.monitor-stage');

if(fsBtn && monitorStage){
  fsBtn.addEventListener('click', async () => {
    try {
      if(!document.fullscreenElement && monitorStage.requestFullscreen){
        await monitorStage.requestFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen toggle failed', err);
    }
  });
}

function fitMonitorGrid(){
  const wrap = document.querySelector('.monitor-grid-wrap');
  const grid = document.querySelector('.monitor-grid');
  if(!wrap || !grid) return;
  const scale = wrap.clientWidth / 800;
  if(scale > 0) grid.style.setProperty('--monitor-scale', scale);
}

if(!isController){
  fitMonitorGrid();
  window.addEventListener('resize', fitMonitorGrid);
  document.addEventListener('fullscreenchange', fitMonitorGrid);
  const gridWrap = document.querySelector('.monitor-grid-wrap');
  if(gridWrap && typeof ResizeObserver !== 'undefined'){
    new ResizeObserver(fitMonitorGrid).observe(gridWrap);
  }
}

