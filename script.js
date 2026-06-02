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
let plethPhase = 0;
let respPhase = 0;
let vfPhase = 0;

const TRACE_SWEEP_RATE = 82.5;
const HORIZONTAL_WAVE_COMPRESSION = 1.92;

const initialMonitorState = {
  hr:72, spo2:98, rr:16, temp:36.7, sbp:120, dbp:80, rhythm:'NSR'
};

let cur = {...initialMonitorState};
let tgt = {...initialMonitorState};
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
  if(state.rhythm === 'VT') return Math.max(state.hr, 0);
  return Math.max(state.hr, 0);
}

function ecgSample(phase, s){
  if(!metricEnabled.hr) return 0;
  if(s.rhythm === 'VF') return (Math.random() - .5) * .65 + .22 * Math.sin(vfPhase) + .12 * Math.sin(vfPhase * 1.9);
  if(s.rhythm === 'VT'){
    // Fixed monomorphic VT model with a sharper (less rounded) apex.
    const theta = 2 * Math.PI * phase;
    const tri = (2 / Math.PI) * Math.asin(Math.sin(theta));
    const shape =
      0.9 * tri +
      0.22 * Math.sin(2 * theta - 0.5) +
      0.1 * Math.sin(3 * theta + 0.9);
    return 1.08 * shape;
  }
  if(s.hr <= 0) return 0;
  const p = phase;
  const perfusion = clamp((s.sbp + s.dbp) / 210, 0.35, 1.15);
  const tempGain = clamp(1 + (s.temp - 36.7) * 0.03, 0.9, 1.08);
  const qrsGain = perfusion * tempGain;
  let y = 0;
  if(p < .1) y += .1 * Math.sin(Math.PI * p / .1);
  const q = (p - .14) / .05;
  if(q >= 0 && q <= 1){
    if(q < .1) y -= .08 * (q / .1) * qrsGain;
    else if(q < .3) y += .95 * Math.sin(Math.PI * (q - .1) / .2) * qrsGain;
    else if(q < .5) y -= .25 * Math.sin(Math.PI * (q - .3) / .2) * qrsGain;
  }
  const tp = (p - .25) / .12;
  if(tp >= 0 && tp <= 1) y += .18 * Math.sin(Math.PI * tp) * clamp((s.spo2 / 98) * 0.7 + 0.3, 0.15, 1.1);
  return y + (Math.random() - .5) * 0.01;
}

function spo2Sample(phase, s){
  if(!metricEnabled.spo2) return 0;
  if(s.spo2 <= 0 || s.hr <= 0) return (Math.random() - .5) * .05;
  const p = phase;
  const perfusion = clamp((s.sbp + 2 * s.dbp) / 280, 0.12, 1.1);
  const oxyGain = clamp(s.spo2 / 98, 0.08, 1.02);
  const rise = Math.pow(Math.sin(Math.PI * smoothStep(0, .32, p)), 1.55);
  const decay = Math.exp(-Math.max(0, p - .16) * 4.8);
  const notch = .12 * Math.exp(-Math.pow((p - .46) / .055, 2));
  const baseline = .02 * Math.sin(Math.PI * p * 2);
  const y = rise * decay + notch + baseline;
  return y * perfusion * oxyGain + (Math.random() - .5) * .012;
}

function respSample(phase, s){
  if(!metricEnabled.rr) return 0;
  if(s.rr <= 0) return (Math.random() - .5) * .03;
  const amp = clamp(0.32 + (s.temp - 35) * 0.025 + (s.spo2 / 100) * 0.1, 0.22, 0.62);
  const wave = Math.sin(2 * Math.PI * phase);
  const bias = 0.08 * Math.sin(4 * Math.PI * phase);
  return amp * wave + bias + (Math.random() - .5) * .02;
}

function resizeWaveDisplays(){
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  waveStates.forEach(state => {
    const rect = state.canvas.getBoundingClientRect();
    const width = Math.max(2, Math.round(rect.width * dpr));
    const height = Math.max(2, Math.round(rect.height * dpr));
    if(state.canvas.width !== width || state.canvas.height !== height){
      state.canvas.width = width;
      state.canvas.height = height;
      state.width = width;
      state.height = height;
      state.buf = new Float32Array(width).fill(height / 2);
      state.wp = 0;
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
  ctx.lineWidth = .5;
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
  ctx.lineWidth = 1.5;
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
  cur.hr = smoothValue(cur.hr, tgt.hr, 3.8, dt);
  cur.spo2 = smoothValue(cur.spo2, tgt.spo2, 2.2, dt);
  cur.rr = smoothValue(cur.rr, tgt.rr, 3.2, dt);
  cur.sbp = smoothValue(cur.sbp, tgt.sbp, 2.4, dt);
  cur.dbp = smoothValue(cur.dbp, tgt.dbp, 2.4, dt);
  cur.temp = smoothValue(cur.temp, tgt.temp, 0.8, dt);
  cur.rhythm = tgt.rhythm;
  updateNumerics();

  acc += dt * TRACE_SWEEP_RATE;
  const steps = Math.floor(acc);
  acc -= steps;
  for(let s = 0; s < steps; s++){
    const sampleDt = dt / Math.max(steps, 1);
    if(cur.rhythm === 'VF') vfPhase += sampleDt * 24;
    const pulseRate = getEffectivePulseRate(cur);
    const pulsePhaseStep = sampleDt * pulseRate * HORIZONTAL_WAVE_COMPRESSION / 60;
    ecgPhase = (ecgPhase + pulsePhaseStep) % 1;
    plethPhase = (plethPhase + pulsePhaseStep) % 1;
    respPhase = (respPhase + sampleDt * Math.max(cur.rr, 0) * HORIZONTAL_WAVE_COMPRESSION / 60) % 1;
    waveStates.forEach(state => {
      const phase = state.id === 'ecgC' ? ecgPhase : state.id === 'spo2C' ? plethPhase : respPhase;
      const centerY = state.height / 2;
      state.buf[state.wp] = centerY - state.sample(phase, cur) * (state.height * state.scale);
      state.wp = (state.wp + 1) % state.width;
    });
  }
  waveStates.forEach(drawWave);
  requestAnimationFrame(monitorFrame);
}

function applyState(newState){
  Object.assign(tgt, newState);
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
        tgt[msg.key] = clampObsValue(msg.key, (tgt[msg.key] || 0) + msg.delta);
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
let wakeLockSentinel = null;

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

async function requestWakeLock(){
  if(!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
    }, { once: true });
  } catch (err) {
    console.warn('Wake lock request failed', err);
  }
}

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
  const appliedDelta = nextValue - ctrlState[key];
  ctrlState[key] = nextValue;
  syncControllerField(key);
  if(ctrlConn && appliedDelta) ctrlConn.send({type:'obs', key, delta: appliedDelta});
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
  const appliedDelta = nextValue - ctrlState[key];
  ctrlState[key] = nextValue;
  syncControllerField(key);
  if(ctrlConn && appliedDelta) ctrlConn.send({type:'obs', key, delta: appliedDelta});
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

window.addEventListener('resize', resizeWaveDisplays);
document.addEventListener('fullscreenchange', resizeWaveDisplays);
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && !wakeLockSentinel){
    requestWakeLock();
  }
});
requestWakeLock();
