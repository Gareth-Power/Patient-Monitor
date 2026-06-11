// A session is identified by a room id carried in the URL. The `role` param
// distinguishes a controller from a monitor so that the same room can be opened
// on multiple monitors (just copy the monitor URL) while a single controller
// drives them all.
const params = new URLSearchParams(location.search);
const isController = params.get('role') === 'controller';
// Reuse the room from the URL if present (e.g. a copied monitor URL); otherwise
// mint a fresh one for a brand new monitor session.
const roomId = params.get('room') || ('pm-' + Math.random().toString(36).slice(2, 8));

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
// Tracks the NIBP target last applied so a change can be detected and the reading
// snapped + flashed (NIBP is a discrete cuff measurement, not a trended value).
const lastNibpTarget = { sbp: initialMonitorState.sbp, dbp: initialMonitorState.dbp };
const metricEnabled = {
  hr: true,
  spo2: true,
  sbp: true,
  dbp: true,
  rr: true,
  temp: true
};

// Manually-triggered alarms, one flag per alarmable metric. When any is active
// the monitor flashes that numeric and plays the Dräger-style alarm tone. Alarms
// are never auto-set from values — they are toggled only from the controller.
const ALARM_KEYS = ['hr', 'spo2', 'rr'];
const alarmActive = { hr: false, spo2: false, rr: false };

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

  // An alarming metric flashes its numeric card (only while its metric is on).
  ALARM_KEYS.forEach(key => {
    const valueEl = document.getElementById(key);
    const card = valueEl ? valueEl.closest('.num-card') : null;
    if(card) card.classList.toggle('num-alarm', alarmActive[key] && metricEnabled[key]);
  });
}

// Blink the NIBP numeric three times to acknowledge a fresh cuff reading.
function flashNibpReading(){
  const el = document.getElementById('nibp');
  if(!el) return;
  el.classList.remove('nibp-reading');
  void el.offsetWidth; // restart the animation if it is already running
  el.classList.add('nibp-reading');
  el.addEventListener('animationend', () => el.classList.remove('nibp-reading'), { once: true });
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
  // NIBP is a discrete cuff reading, not a continuously trended value: it snaps
  // straight to the new target instead of easing like the others, and the
  // numeric flashes to acknowledge the fresh reading.
  if(tgt.sbp !== lastNibpTarget.sbp || tgt.dbp !== lastNibpTarget.dbp){
    cur.sbp = tgt.sbp;
    cur.dbp = tgt.dbp;
    lastNibpTarget.sbp = tgt.sbp;
    lastNibpTarget.dbp = tgt.dbp;
    flashNibpReading();
  }
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

/* AUDIO / BEEP ENGINE
   Real bedside monitors emit one short "QRS beep" per heartbeat, fired at the
   R-wave, and lower the beep's pitch as SpO2 falls — an audible desaturation
   cue clinicians rely on without looking at the screen. We reproduce both:
   the beep is triggered when the ECG sweep phase crosses the R-peak, and its
   frequency is mapped from the current SpO2. */
let audioCtx = null;
// Sound is off until the user explicitly turns it on via the Beep button. That
// press also serves as the user gesture browsers require to unlock audio.
let beepOn = false;

function ensureAudio(){
  if(audioCtx) return audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if(!AC) return null;
  audioCtx = new AC();
  return audioCtx;
}

// SpO2 -> beep frequency. Healthy sats sit near 880 Hz; the tone drops roughly a
// semitone per percentage point below ~96% so a desaturation is clearly audible.
function beepFrequency(spo2){
  if(spo2 >= 96) return 880;
  const drop = clamp(96 - spo2, 0, 40);
  return clamp(880 * Math.pow(2, -drop / 12), 180, 880);
}

function playBeep(){
  if(!beepOn) return;
  const ctx = ensureAudio();
  if(!ctx || ctx.state === 'suspended') return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  // Square-ish tone via a triangle wave gives the brighter, harder edge of a real
  // monitor beep rather than the soft "bop" of a pure sine.
  osc.type = 'triangle';
  osc.frequency.value = beepFrequency(cur.spo2);
  // Crisp beep: near-instant attack, a short sustained body, then a quick release.
  // The flat top (vs. an immediate decay) is what reads as a "beep" not a "bop".
  const peak = 0.16;
  const dur = 0.12;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.002);
  gain.gain.setValueAtTime(peak, now + dur - 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.01);
}

// The QRS beep is driven by a self-rescheduling timer rather than the animation
// loop, because browsers suspend requestAnimationFrame in background tabs (which
// would silence the beep there). A timer keeps firing — throttled but alive — so
// the beep behaves like the alarm and continues off-tab. The interval is the
// current R-R period, recomputed each beat so it tracks live HR changes.
let beepTimer = null;

function beepCanSound(){
  return beepOn && metricEnabled.hr && cur.rhythm !== 'VF' && getEffectivePulseRate(cur) > 0;
}

function scheduleNextBeep(){
  const rate = getEffectivePulseRate(cur);
  // Guard against zero/unsound state; re-check shortly until a valid beat exists.
  const intervalMs = (beepCanSound() && rate > 0) ? (60000 / rate) : 250;
  beepTimer = setTimeout(() => {
    if(beepCanSound()) playBeep();
    if(beepOn) scheduleNextBeep();
    else beepTimer = null;
  }, intervalMs);
}

function setBeepOn(on){
  beepOn = on;
  const btn = document.getElementById('beepBtn');
  if(btn){
    btn.classList.toggle('beep-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'Turn beep off' : 'Turn beep on');
  }
  if(on){
    if(!beepTimer){
      if(beepCanSound()) playBeep();
      scheduleNextBeep();
    }
  } else if(beepTimer){
    clearTimeout(beepTimer);
    beepTimer = null;
  }
}

/* ALARM TONE
   Dräger monitors use the IEC 60601-1-8 medium-priority pattern: a burst of three
   short pulses, repeated on a cycle while the alarm condition stands. We schedule
   the pulses on the Web Audio clock for tight timing and loop the burst with a
   timer for as long as any metric alarm is active. */
let alarmTimer = null;
// Pulse onset times (s) within one burst and their pitches — the rising/falling
// melodic shape characteristic of the medium-priority alarm.
const ALARM_BURST = [
  { at: 0.00, freq: 988 },  // B5
  { at: 0.20, freq: 988 },
  { at: 0.40, freq: 988 },
];
const ALARM_PULSE_DUR = 0.15;
const ALARM_BURST_PERIOD = 1400; // ms between bursts

function playAlarmPulse(ctx, startAt, freq){
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  // A square wave gives the hard, attention-demanding timbre of a clinical alarm.
  osc.type = 'square';
  osc.frequency.value = freq;
  const peak = 0.14;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.008);
  gain.gain.setValueAtTime(peak, startAt + ALARM_PULSE_DUR - 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + ALARM_PULSE_DUR);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + ALARM_PULSE_DUR + 0.01);
}

function playAlarmBurst(){
  const ctx = ensureAudio();
  if(!ctx || ctx.state === 'suspended') return;
  const base = ctx.currentTime + 0.02;
  ALARM_BURST.forEach(p => playAlarmPulse(ctx, base + p.at, p.freq));
}

function anyAlarmActive(){
  // Only metrics that are switched on can alarm audibly/visually.
  return ALARM_KEYS.some(k => alarmActive[k] && metricEnabled[k]);
}

// Start/stop the looping alarm to match the current alarm state.
function refreshAlarmTone(){
  const shouldPlay = anyAlarmActive();
  if(shouldPlay && !alarmTimer){
    playAlarmBurst();
    alarmTimer = setInterval(playAlarmBurst, ALARM_BURST_PERIOD);
  } else if(!shouldPlay && alarmTimer){
    clearInterval(alarmTimer);
    alarmTimer = null;
  }
}

function setAlarm(key, active){
  if(!(key in alarmActive)) return;
  alarmActive[key] = !!active;
  refreshAlarmTone();
}

/* MONITOR PEER SETUP */
const NTFY_BASE = 'https://ntfy.sh';

function handleMonitorMessage(msg){
  if(msg.type === 'rhythm'){
    tgt.rhythm = msg.value;
  } else if(msg.type === 'obs'){
    tgt[msg.key] = clampObsValue(msg.key, msg.value);
  } else if(msg.type === 'ramp'){
    Object.keys(msg.values).forEach(k => {
      tgt[k] = clampObsValue(k, msg.values[k]);
    });
    rampEndTime = performance.now() / 1000 + RAMP_DURATION;
    // A rhythm change staged during Hold rides along in the ramp message; apply
    // it immediately (rhythm is a discrete switch, not a ramped value).
    if(msg.rhythm !== undefined) tgt.rhythm = msg.rhythm;
  } else if(msg.type === 'metric'){
    getMetricGroupKeys(msg.key).forEach(k => {
      metricEnabled[k] = !!msg.enabled;
    });
    refreshAlarmTone();
  } else if(msg.type === 'alarm'){
    setAlarm(msg.key, msg.active);
  } else if(msg.type === 'fullstate'){
    tgt.rhythm = msg.rhythm;
    Object.keys(msg.obs).forEach(k => { tgt[k] = clampObsValue(k, msg.obs[k]); });
    Object.keys(msg.metrics).forEach(k => { metricEnabled[k] = !!msg.metrics[k]; });
    if(msg.alarms){
      Object.keys(msg.alarms).forEach(k => {
        if(k in alarmActive) alarmActive[k] = !!msg.alarms[k];
      });
    }
    refreshAlarmTone();
  }
}

function setupBeepControls(){
  const btn = document.getElementById('beepBtn');
  if(btn){
    btn.addEventListener('click', () => {
      // The click is a user gesture, so use it to start the wake-lock too.
      enableNoSleep();
      // The same gesture lets us create/resume the AudioContext when turning on.
      if(!beepOn){
        const ctx = ensureAudio();
        if(ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      }
      setBeepOn(!beepOn);
    });
  }
  setBeepOn(beepOn);
}

function setupMonitor(){
  document.getElementById('monitorView').style.display = 'flex';
  resizeWaveDisplays();
  requestAnimationFrame(monitorFrame);
  enableNoSleep();
  setupBeepControls();

  const ntfyUrl = NTFY_BASE + '/patient-monitor-' + roomId;

  // Surface this monitor's room in the address bar so the URL can be copied and
  // opened on additional monitors that join the same session.
  const monitorUrl = location.href.split('?')[0] + '?room=' + roomId;
  history.replaceState(null, '', monitorUrl);

  // The QR code and the displayed URL both open the controller for this room.
  const ctrlUrl = monitorUrl + '&role=controller';
  document.getElementById('roomIdLabel').textContent = ctrlUrl;
  document.getElementById('qrImage').src =
    `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(ctrlUrl)}`;

  const es = new EventSource(ntfyUrl + '/sse');

  es.addEventListener('message', e => {
    try {
      const outer = JSON.parse(e.data);
      const msg = JSON.parse(outer.message);
      if(msg._src === 'ctrl' && msg.type !== 'connect' && msg.type !== 'disconnect'){
        handleMonitorMessage(msg);
      }
    } catch(e) {}
  });

  // Ask any already-connected controller to re-broadcast its state so a monitor
  // that joins late (e.g. a second screen) syncs to the current values.
  fetch(ntfyUrl, {
    method: 'POST',
    body: JSON.stringify({ type: 'request-state', _src: 'monitor' })
  }).catch(() => {});
}

/* CONTROLLER SETUP */
let ctrlConn = null;
let ctrlState = {
  hr:72, spo2:98, rr:16, temp:36.7, sbp:120, dbp:80
};
let ctrlRhythm = 'NSR';
// Controller-side mirror of the manual alarm flags.
const ctrlAlarm = { hr: false, spo2: false, rr: false };
let holdActive = false;
let heldState = null;
// Staged rhythm while Hold is active; null means no rhythm change is queued.
let heldRhythm = null;

const obsConfig = [
  {key:'hr',   label:'HR',   unit:'bpm', color:'#00ff41', step:1,  min:0,   max:300},
  {key:'spo2', label:'SpO₂', unit:'%',   color:'#00aaff', step:1,  min:0,   max:100},
  {key:'sbp',  label:'SBP',  unit:'mmHg',color:'#ff66aa', step:2,  min:0,   max:250},
  {key:'dbp',  label:'DBP',  unit:'mmHg',color:'#ff66aa', step:2,  min:0,   max:200},
  {key:'rr',   label:'RR',   unit:'br/m',color:'#ffaa00', step:1,  min:0,   max:60},
  {key:'temp', label:'Temp', unit:'°C',  color:'#ff8844', step:0.1,min:32,  max:42},
];

// Single combined row for SBP+DBP in the controller UI.
const nibpRowConfig = {
  sbp: obsConfig.find(o => o.key === 'sbp'),
  dbp: obsConfig.find(o => o.key === 'dbp'),
};

// obsConfig entries shown as individual rows (NIBP is handled separately).
const obsConfigRows = obsConfig.filter(o => o.key !== 'sbp' && o.key !== 'dbp');

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
let noSleepEnabled = false;
function enableNoSleep(){
  if(noSleepEnabled) return;
  noSleepEnabled = true;
  noSleep.enable().catch(() => {});
  if('mediaSession' in navigator){
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Patient Monitor'
    });
  }
}

function buildSingleObsRow(o, container){
  const row = document.createElement('div');
  row.className = 'obs-row';
  row.dataset.key = o.key;
  const val = formatVal(o.key, ctrlState[o.key]);
  const alarmable = ALARM_KEYS.includes(o.key);
  const alarmBtn = alarmable
    ? `<button class="obs-alarm ${ctrlAlarm[o.key] ? 'on' : ''}" type="button" data-action="alarm" data-key="${o.key}" aria-pressed="${ctrlAlarm[o.key] ? 'true' : 'false'}">Alarm</button>`
    : '';
  row.innerHTML = `
    <div class="obs-head">
      <div class="obs-meta">
        <div class="obs-name">${o.label}</div>
        <div class="obs-unit">${o.unit}</div>
      </div>
      <div class="obs-head-btns">
        ${alarmBtn}
        <button class="obs-toggle ${metricEnabled[o.key] ? 'on' : 'off'}" type="button" data-action="toggle" data-key="${o.key}">${metricEnabled[o.key] ? 'On' : 'Off'}</button>
      </div>
    </div>
    <div class="obs-controls">
      <button class="obs-btn" type="button" data-action="decrease" data-key="${o.key}">-</button>
      <input class="obs-input" id="cv-${o.key}" type="number" inputmode="decimal" step="${o.step}" min="${o.min}" max="${o.max}" value="${val}" aria-label="${o.label}">
      <button class="obs-btn" type="button" data-action="increase" data-key="${o.key}">+</button>
    </div>`;
  row.querySelector('[data-action="decrease"]').addEventListener('click', () => { enableNoSleep(); nudge(o.key, -o.step); });
  row.querySelector('[data-action="increase"]').addEventListener('click', () => { enableNoSleep(); nudge(o.key, o.step); });
  row.querySelector('[data-action="toggle"]').addEventListener('click', () => { enableNoSleep(); toggleMetric(o.key); });
  if(alarmable){
    row.querySelector('[data-action="alarm"]').addEventListener('click', () => { enableNoSleep(); toggleAlarm(o.key); });
  }
  const input = row.querySelector('.obs-input');
  input.addEventListener('change', () => applyManualInput(o.key, input.value));
  input.addEventListener('blur', () => applyManualInput(o.key, input.value));
  container.appendChild(row);
  syncMetricControls(o.key);
}

function buildNibpRow(container){
  const { sbp, dbp } = nibpRowConfig;
  const nibpOn = metricEnabled.sbp;
  const row = document.createElement('div');
  row.className = 'obs-row obs-row-nibp';
  row.dataset.key = 'nibp';
  row.innerHTML = `
    <div class="obs-head">
      <div class="obs-meta">
        <div class="obs-name">NIBP</div>
        <div class="obs-unit">mmHg</div>
      </div>
      <button class="obs-toggle ${nibpOn ? 'on' : 'off'}" type="button" data-action="toggle" data-key="sbp">${nibpOn ? 'On' : 'Off'}</button>
    </div>
    <div class="obs-nibp-rows">
      <div class="obs-nibp-label">SYS</div>
      <div class="obs-controls">
        <button class="obs-btn" type="button" data-action="decrease" data-key="sbp">-</button>
        <input class="obs-input" id="cv-sbp" type="number" inputmode="decimal" step="${sbp.step}" min="${sbp.min}" max="${sbp.max}" value="${formatVal('sbp', ctrlState.sbp)}" aria-label="SBP">
        <button class="obs-btn" type="button" data-action="increase" data-key="sbp">+</button>
      </div>
      <div class="obs-nibp-label">DIA</div>
      <div class="obs-controls">
        <button class="obs-btn" type="button" data-action="decrease" data-key="dbp">-</button>
        <input class="obs-input" id="cv-dbp" type="number" inputmode="decimal" step="${dbp.step}" min="${dbp.min}" max="${dbp.max}" value="${formatVal('dbp', ctrlState.dbp)}" aria-label="DBP">
        <button class="obs-btn" type="button" data-action="increase" data-key="dbp">+</button>
      </div>
    </div>`;
  row.querySelectorAll('[data-action="decrease"]').forEach(btn =>
    btn.addEventListener('click', () => { enableNoSleep(); nudge(btn.dataset.key, btn.dataset.key === 'sbp' ? -sbp.step : -dbp.step); }));
  row.querySelectorAll('[data-action="increase"]').forEach(btn =>
    btn.addEventListener('click', () => { enableNoSleep(); nudge(btn.dataset.key, btn.dataset.key === 'sbp' ? sbp.step : dbp.step); }));
  row.querySelector('[data-action="toggle"]').addEventListener('click', () => { enableNoSleep(); toggleMetric('sbp'); });
  ['sbp','dbp'].forEach(k => {
    const input = document.getElementById ? row.querySelector(`#cv-${k}`) : null;
    if(input){
      input.addEventListener('change', () => applyManualInput(k, input.value));
      input.addEventListener('blur', () => applyManualInput(k, input.value));
    }
  });
  container.appendChild(row);
  syncMetricControls('sbp');
  syncMetricControls('dbp');
}

function buildObsRows(){
  const container = document.getElementById('obsRows');
  container.innerHTML = '';
  // HR, SpO2, RR, Temp
  obsConfigRows.forEach(o => buildSingleObsRow(o, container));
  // Combined NIBP row last, so its taller layout doesn't sit beside the
  // smaller boxes and affect their row height.
  buildNibpRow(container);
}

function formatVal(key, v){
  if(key === 'temp') return v.toFixed(1);
  return Math.round(v);
}

const nudgeTimers = {};

function nudge(key, delta){
  const nextValue = clampObsValue(key, ctrlState[key] + delta);
  ctrlState[key] = nextValue;
  syncControllerField(key);
  if(holdActive){
    heldState[key] = nextValue;
    syncHoldIndicators();
  } else {
    flashInput(key);
    clearTimeout(nudgeTimers[key]);
    nudgeTimers[key] = setTimeout(() => {
      if(ctrlConn) ctrlConn.send({type:'obs', key, value: ctrlState[key]});
    }, 300);
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

  // NIBP keys share a combined row keyed as 'nibp'.
  const rowKey = (key === 'sbp' || key === 'dbp') ? 'nibp' : key;
  const row = document.querySelector(`.obs-row[data-key="${rowKey}"]`);
  if(row) row.classList.toggle('obs-off', !enabled);

  const toggleBtn = document.querySelector(`.obs-toggle[data-key="${key}"]`);
  if(toggleBtn){
    toggleBtn.className = 'obs-toggle ' + (enabled ? 'on' : 'off');
    toggleBtn.textContent = enabled ? 'On' : 'Off';
    toggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  }

  // An alarm only makes sense while its observation is on. When the observation
  // is switched off, clear any active alarm and disable the button until it
  // comes back on.
  const alarmBtn = document.querySelector(`.obs-alarm[data-key="${key}"]`);
  if(alarmBtn){
    if(!enabled && ctrlAlarm[key]) toggleAlarm(key);
    alarmBtn.disabled = !enabled;
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

function toggleAlarm(key){
  if(!(key in ctrlAlarm)) return;
  const next = !ctrlAlarm[key];
  ctrlAlarm[key] = next;
  const btn = document.querySelector(`.obs-alarm[data-key="${key}"]`);
  if(btn){
    btn.classList.toggle('on', next);
    btn.setAttribute('aria-pressed', next ? 'true' : 'false');
  }
  if(ctrlConn) ctrlConn.send({type:'alarm', key, active: next});
}

function flashInput(key){
  const input = document.getElementById('cv-' + key);
  if(!input) return;
  input.classList.remove('obs-flash');
  void input.offsetWidth;
  input.classList.add('obs-flash');
  input.addEventListener('animationend', () => input.classList.remove('obs-flash'), { once: true });
}

function flashRhythm(){
  const sel = document.getElementById('rhythmSelect');
  if(!sel) return;
  sel.classList.remove('obs-flash');
  void sel.offsetWidth;
  sel.classList.add('obs-flash');
  sel.addEventListener('animationend', () => sel.classList.remove('obs-flash'), { once: true });
}

function syncHoldIndicators(){
  obsConfig.forEach(o => {
    const input = document.getElementById('cv-' + o.key);
    if(!input) return;
    const staged = holdActive && heldState && heldState[o.key] !== undefined;
    input.classList.toggle('obs-staged', staged);
  });
  const sel = document.getElementById('rhythmSelect');
  if(sel) sel.classList.toggle('obs-staged', holdActive && heldRhythm !== null);
}

function toggleHold(){
  holdActive = !holdActive;
  const btn = document.getElementById('holdBtn');
  if(holdActive){
    heldState = {};
    heldRhythm = null;
    if(btn){
      btn.textContent = 'Release';
      btn.classList.add('hold-active');
    }
  } else {
    if(ctrlConn){
      const keys = heldState ? Object.keys(heldState) : [];
      // Send the staged obs values and any staged rhythm together in one message
      // so the change lands on every monitor at the same moment.
      const msg = {type:'ramp', values: {...(heldState || {})}};
      if(heldRhythm !== null) msg.rhythm = heldRhythm;
      ctrlConn.send(msg);
      keys.forEach(flashInput);
      if(heldRhythm !== null) flashRhythm();
    }
    heldState = null;
    heldRhythm = null;
    syncHoldIndicators();
    if(btn){
      btn.textContent = 'Hold';
      btn.classList.remove('hold-active');
    }
  }
}

function setRhythm(rhythm){
  ctrlRhythm = rhythm;
  if(holdActive){
    heldRhythm = rhythm;
    syncHoldIndicators();
  } else {
    if(ctrlConn) ctrlConn.send({type:'rhythm', value: rhythm});
    flashRhythm();
  }
}

function lockControllerZoom(){
  document.addEventListener('gesturestart', e => { e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturechange', e => { e.preventDefault(); }, { passive: false });
  document.addEventListener('gestureend', e => { e.preventDefault(); }, { passive: false });
}

function setupController(){
  document.body.classList.add('controller-mode');
  document.getElementById('monitorView').style.display = 'none';
  document.getElementById('controllerView').className = 'ctrl-wrap show';
  lockControllerZoom();
  const rhythmSelect = document.getElementById('rhythmSelect');
  if(rhythmSelect){
    rhythmSelect.value = ctrlRhythm;
    rhythmSelect.addEventListener('change', () => { enableNoSleep(); setRhythm(rhythmSelect.value); });
  }
  buildObsRows();

  const holdBtn = document.getElementById('holdBtn');
  if(holdBtn) holdBtn.addEventListener('click', () => { enableNoSleep(); toggleHold(); });

  const ctrlStatusEl = document.getElementById('ctrlStatus');
  function setCtrlStatus(msg, ok){
    if(!ctrlStatusEl) return;
    ctrlStatusEl.textContent = msg;
    ctrlStatusEl.className = 'ctrl-status ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
  }

  const ntfyUrl = NTFY_BASE + '/patient-monitor-' + roomId;
  setCtrlStatus('Connecting…');

  ctrlConn = {
    send(msg){
      fetch(ntfyUrl, {
        method: 'POST',
        body: JSON.stringify({ ...msg, _src: 'ctrl' })
      }).then(r => {
        if(r.ok) setCtrlStatus('Connected', true);
        else setCtrlStatus('Send failed', false);
      }).catch(() => setCtrlStatus('Connection error', false));
    }
  };

  function publishFullState(){
    ctrlConn.send({
      type: 'fullstate',
      rhythm: ctrlRhythm,
      obs: Object.fromEntries(obsConfig.map(o => [o.key, ctrlState[o.key]])),
      metrics: Object.fromEntries(obsConfig.map(o => [o.key, metricEnabled[o.key]])),
      alarms: { ...ctrlAlarm }
    });
  }

  // Listen for monitors joining late and requesting the current state.
  const ctrlEs = new EventSource(ntfyUrl + '/sse');
  ctrlEs.addEventListener('message', e => {
    try {
      const outer = JSON.parse(e.data);
      const msg = JSON.parse(outer.message);
      if(msg._src === 'monitor' && msg.type === 'request-state'){
        publishFullState();
      }
    } catch(e) {}
  });

  publishFullState();

  // Announce disconnect on page unload.
  window.addEventListener('pagehide', () => {
    navigator.sendBeacon(ntfyUrl, JSON.stringify({ type: 'disconnect', _src: 'ctrl' }));
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
  // iPhone Safari has no element Fullscreen API (only <video> can go fullscreen),
  // so requestFullscreen is undefined there. Everywhere else (iPad, Android, desktop)
  // we use the real API exactly as before; iPhone falls back to a CSS pseudo-fullscreen.
  const realFullscreenSupported = typeof monitorStage.requestFullscreen === 'function';

  function exitFauxFullscreen(){
    monitorStage.classList.remove('faux-fullscreen');
    document.removeEventListener('keydown', onFauxKey);
    fsBtn.textContent = 'Fullscreen';
    fitMonitorGrid();
  }
  function onFauxKey(e){
    if(e.key === 'Escape') exitFauxFullscreen();
  }
  function enterFauxFullscreen(){
    monitorStage.classList.add('faux-fullscreen');
    document.addEventListener('keydown', onFauxKey);
    fsBtn.textContent = 'Exit';
    fitMonitorGrid();
  }

  fsBtn.addEventListener('click', async () => {
    enableNoSleep();
    if(realFullscreenSupported){
      try {
        if(!document.fullscreenElement){
          await monitorStage.requestFullscreen();
        }
      } catch (err) {
        console.warn('Fullscreen toggle failed', err);
      }
      return;
    }
    // Fallback path (iPhone Safari): toggle the CSS pseudo-fullscreen.
    if(monitorStage.classList.contains('faux-fullscreen')){
      exitFauxFullscreen();
    } else {
      enterFauxFullscreen();
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

