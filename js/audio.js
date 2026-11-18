// Motor de audio de El Gran Millón.
// Todo se sintetiza en tiempo real con WebAudio (osciladores, búferes de ruido, filtros, envolventes y FM sencilla):
// no hay archivos ni muestras de audio. Melodías y progresiones originales.
//
// API (singleton):
//   audio.unlock()                    crea/reanuda el AudioContext; llamarlo en un gesto del usuario (se puede repetir)
//   audio.setVolumes({ music, sfx })  0..1 cada uno, con rampas suaves
//   audio.setMusic(mode, intensity)   'home' | 'lobby' | 'think' | 'tension' | 'win' | 'lose' | 'off'
//                                     fundido cruzado ≈0,8 s; mismo modo = solo actualiza la intensidad (0..1)
//   audio.sfx(name)                   efecto puntual; los nombres desconocidos se ignoran
//   audio.enabled                     true cuando el AudioContext está sonando
//
// Antes de unlock() nada suena ni falla: los volúmenes y el último modo de música pedido se recuerdan
// y la música arranca al desbloquear (salvo 'lose', que es un cierre puntual). Sin WebAudio todo es no-op.

const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext || null) : null;

const LOOKAHEAD = 0.12;   // s programados por delante
const TICK_MS = 25;       // periodo del planificador
const XFADE = 0.8;        // fundido cruzado entre modos
const MUSIC_SCALE = 0.35; // la música va a ≈0,35 del nivel de los efectos
const SFX_SCALE = 1;
const MAX_SFX = 12;       // efectos simultáneos como máximo
const MAX_PLAYERS = 4;    // reproductores de música vivos (actual + fundidos)
const NOISE_SEC = 2;

const FX_GAP = { hover: 0.05, click: 0.03, tick: 0.08, final: 0.15 }; // separación mínima entre repeticiones
const FX_SAME = { hover: 2, tick: 2, final: 2, win: 2, poll: 2, start: 2, lock: 2, react: 4, coin: 4, vote: 4 };

let ctx = null;
let musicBus = null;
let sfxBus = null;
let noiseBuf = null;
const vol = { music: 0.8, sfx: 0.8 };
let mode = 'off';
let intensity = 0;
let current = null;
const players = [];
let fxActive = [];
const fxLast = Object.create(null);
let warned = false;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const quiet = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); };

function holdParam(p, t) {
  if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
  else { const v = p.value; p.cancelScheduledValues(t); p.setValueAtTime(v, t); }
}

// Ataque lineal y caída exponencial. Devuelve el instante en que ya se puede parar la fuente.
function perc(p, t, peak, a, d) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.exponentialRampToValueAtTime(0.0001, t + a + d);
  p.linearRampToValueAtTime(0, t + a + d + 0.015);
  return t + a + d + 0.03;
}

// Ataque, meseta y relajación exponencial.
function env(p, t, peak, a, hold, r) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setValueAtTime(peak, t + a + hold);
  p.exponentialRampToValueAtTime(0.0001, t + a + hold + r);
  p.linearRampToValueAtTime(0, t + a + hold + r + 0.015);
  return t + a + hold + r + 0.03;
}

// Una voz: agrupa sus nodos y los desconecta todos cuando terminan todas sus fuentes.
class Voice {
  constructor() { this.nodes = []; this.srcs = []; }
  gain(to, v = 0) {
    const g = ctx.createGain(); g.gain.value = v; g.connect(to); this.nodes.push(g); return g;
  }
  filter(to, type, freq, q = 0.7) {
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    f.connect(to); this.nodes.push(f); return f;
  }
  osc(to, type, freq, t0, t1, detune = 0) {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (detune) o.detune.setValueAtTime(detune, t0);
    o.connect(to); o.start(t0); o.stop(t1); this.srcs.push(o); return o;
  }
  noise(to, t0, t1) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    s.connect(to); s.start(t0, Math.random() * NOISE_SEC * 0.9); s.stop(t1); this.srcs.push(s); return s;
  }
  done() {
    const all = this.srcs.concat(this.nodes);
    let left = this.srcs.length;
    const fin = () => {
      if (--left > 0) return;
      for (const n of all) { try { n.disconnect(); } catch (e) { /* ya desconectado */ } }
    };
    for (const s of this.srcs) s.onended = fin;
  }
}

function makeNoise() {
  const n = Math.floor(ctx.sampleRate * NOISE_SEC);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

// Respuesta al impulso sintética (ruido que decae y se oscurece) para una sala pequeña.
function makeIR(sec) {
  const sr = ctx.sampleRate, n = Math.floor(sr * sec), b = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let y = 0;
    for (let i = 0; i < n; i++) {
      const x = i / n;
      y += (0.5 - 0.42 * x) * (Math.random() * 2 - 1 - y);
      d[i] = y * Math.pow(1 - x, 2.2) * Math.min(1, i / (sr * 0.01));
    }
  }
  return b;
}

function pan(to, v) {
  if (typeof ctx.createStereoPanner !== 'function') return to;
  const p = ctx.createStereoPanner(); p.pan.value = v; p.connect(to); return p;
}

// ───────────────────────── instrumentos ─────────────────────────

function pluck(to, t, m, v, dur = 0.35, bright = 2600) {
  const V = new Voice(), f = mtof(m);
  const g = V.gain(to);
  const lp = V.filter(g, 'lowpass', bright, 2.5);
  lp.frequency.setValueAtTime(bright, t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(200, f * 1.3), t + dur * 0.8);
  const end = perc(g.gain, t, v, 0.004, dur);
  V.osc(lp, 'triangle', f, t, end);
  V.osc(V.gain(lp, 0.3), 'sawtooth', f, t, end, 6);
  V.done();
}

function pad(to, t, notes, dur, v = 0.03, cutoff = 1100, a = 0.35, r = 0.7) {
  const V = new Voice();
  const g = V.gain(to);
  const lp = V.filter(g, 'lowpass', cutoff, 0.5);
  const end = env(g.gain, t, v, a, Math.max(0, dur - a), r);
  for (const m of notes) {
    const f = mtof(m);
    V.osc(lp, 'sawtooth', f, t, end, -7);
    V.osc(lp, 'triangle', f, t, end, 7);
  }
  V.done();
}

function bass(to, t, m, dur, v = 0.18, cutoff = 600) {
  const V = new Voice(), f = mtof(m);
  const g = V.gain(to);
  const lp = V.filter(g, 'lowpass', cutoff, 0.9);
  const end = env(g.gain, t, v, 0.006, Math.max(0.01, dur - 0.05), 0.07);
  V.osc(lp, 'triangle', f, t, end);
  V.osc(V.gain(lp, 0.35), 'sawtooth', f, t, end, -4);
  V.done();
}

function kick(to, t, v = 0.4) {
  const V = new Voice(), g = V.gain(to);
  const end = perc(g.gain, t, v, 0.002, 0.26);
  const o = V.osc(g, 'sine', 150, t, end);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  V.done();
}

function snare(to, t, v = 0.1) {
  const V = new Voice();
  const g = V.gain(to), bp = V.filter(g, 'bandpass', 1800, 0.8);
  V.noise(bp, t, perc(g.gain, t, v, 0.002, 0.13));
  const g2 = V.gain(to), e2 = perc(g2.gain, t, v * 0.6, 0.002, 0.07);
  const o = V.osc(g2, 'triangle', 200, t, e2);
  o.frequency.exponentialRampToValueAtTime(150, t + 0.07);
  V.done();
}

function hat(to, t, v = 0.03, open = false) {
  const V = new Voice(), g = V.gain(to), hp = V.filter(g, 'highpass', 7500, 0.7);
  V.noise(hp, t, perc(g.gain, t, v, 0.001, open ? 0.18 : 0.035));
  V.done();
}

function rim(to, t, v = 0.04) {
  const V = new Voice(), g = V.gain(to), bp = V.filter(g, 'bandpass', 1800, 5);
  const end = perc(g.gain, t, v, 0.001, 0.05);
  V.noise(bp, t, end);
  V.osc(V.gain(g, 0.5), 'triangle', 900, t, end);
  V.done();
}

function shaker(to, t, v = 0.02) {
  const V = new Voice(), g = V.gain(to), hp = V.filter(g, 'highpass', 5200, 0.7), p = g.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(v, t + 0.015);
  p.exponentialRampToValueAtTime(0.0001, t + 0.07);
  p.linearRampToValueAtTime(0, t + 0.08);
  V.noise(hp, t, t + 0.09);
  V.done();
}

function clap(to, t, v = 0.1) {
  const V = new Voice(), g = V.gain(to), bp = V.filter(g, 'bandpass', 1300, 1.1), p = g.gain;
  p.setValueAtTime(0, t);
  for (let i = 0; i < 3; i++) {
    const ti = t + i * 0.011;
    p.linearRampToValueAtTime(v, ti + 0.001);
    p.exponentialRampToValueAtTime(v * 0.2, ti + 0.01);
  }
  const ts = t + 0.034;
  p.linearRampToValueAtTime(v, ts);
  p.exponentialRampToValueAtTime(0.0001, ts + 0.16);
  p.linearRampToValueAtTime(0, ts + 0.17);
  V.noise(bp, t, ts + 0.18);
  V.done();
}

function cymbal(to, t, v = 0.05, dur = 1.2) {
  const V = new Voice(), g = V.gain(to), hp = V.filter(g, 'highpass', 5500, 0.5);
  V.noise(hp, t, perc(g.gain, t, v, 0.003, dur));
  V.done();
}

function clock(to, t, v, hi) {
  const V = new Voice(), g = V.gain(to), bp = V.filter(g, 'bandpass', hi ? 3300 : 2400, 3);
  const end = perc(g.gain, t, v, 0.001, 0.03);
  V.noise(bp, t, end);
  V.osc(V.gain(g, 0.12), 'sine', hi ? 2200 : 1700, t, end);
  V.done();
}

function thump(to, t, v, f0) {
  const V = new Voice(), g = V.gain(to), lp = V.filter(g, 'lowpass', 260, 0.6);
  const end = perc(g.gain, t, v, 0.008, 0.22);
  const o = V.osc(lp, 'sine', f0 * 1.7, t, end);
  o.frequency.exponentialRampToValueAtTime(f0, t + 0.05);
  const o2 = V.osc(V.gain(lp, 0.5), 'triangle', f0 * 3.4, t, end);
  o2.frequency.exponentialRampToValueAtTime(f0 * 2, t + 0.05);
  V.done();
}

function heartbeat(to, t, v, f0, gap = 0.2) {
  thump(to, t, v, f0);
  thump(to, t + gap, v * 0.68, f0 * 0.92);
}

function boom(to, t, v = 0.3) {
  const V = new Voice(), g = V.gain(to);
  const end = perc(g.gain, t, v, 0.006, 1.3);
  const o = V.osc(g, 'sine', 75, t, end);
  o.frequency.exponentialRampToValueAtTime(34, t + 0.5);
  const g2 = V.gain(to), lp = V.filter(g2, 'lowpass', 400, 0.7);
  V.noise(lp, t, perc(g2.gain, t, v * 0.4, 0.004, 0.35));
  V.done();
}

function riser(to, t, dur, v) {
  const V = new Voice(), g = V.gain(to), bp = V.filter(g, 'bandpass', 500, 1.4), p = g.gain;
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(3500, t + dur);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(v * 0.12, t + dur * 0.5);
  p.linearRampToValueAtTime(v, t + dur - 0.03);
  p.linearRampToValueAtTime(0, t + dur);
  V.noise(bp, t, t + dur + 0.02);
  V.done();
}

// Campana FM (ratio inarmónico) o piano eléctrico (ratio 1).
function bell(to, t, m, v = 0.08, dur = 1, ratio = 3.5, index = 2) {
  const V = new Voice(), f = mtof(m), g = V.gain(to);
  const end = perc(g.gain, t, v, 0.003, dur);
  const car = V.osc(g, 'sine', f, t, end);
  const mg = V.gain(car.frequency, 0);
  mg.gain.setValueAtTime(f * index, t);
  mg.gain.exponentialRampToValueAtTime(Math.max(0.5, f * index * 0.04), t + dur * 0.7);
  V.osc(mg, 'sine', f * ratio, t, end);
  V.done();
}
const keys = (to, t, m, v, dur = 1.2) => bell(to, t, m, v, dur, 1, 1.3);

function brass(to, t, m, dur, v = 0.08) {
  const V = new Voice(), f = mtof(m), g = V.gain(to);
  const lp = V.filter(g, 'lowpass', f * 1.2, 1.2);
  const end = env(g.gain, t, v, 0.025, Math.max(0, dur - 0.025), 0.12);
  lp.frequency.setValueAtTime(f * 1.2, t);
  lp.frequency.linearRampToValueAtTime(Math.min(9000, f * 6), t + 0.05);
  lp.frequency.setTargetAtTime(f * 2.5, t + 0.06, 0.2);
  V.osc(lp, 'sawtooth', f, t, end, -5);
  V.osc(lp, 'sawtooth', f, t, end, 5);
  V.done();
}

// Tintineo metálico (parciales inarmónicos).
function clink(to, t, v, f) {
  const V = new Voice();
  for (const [r, a, d] of [[1, 1, 0.22], [2.76, 0.5, 0.12], [5.4, 0.3, 0.06]]) {
    const g = V.gain(to);
    V.osc(g, 'sine', f * r, t, perc(g.gain, t, v * a, 0.001, d));
  }
  V.done();
}

// ───────────────────────── canciones ─────────────────────────
// Cada canción programa notas por semicorcheas (step); bpm puede depender de la intensidad.

// Salón de concurso (Fa mayor): Fmaj7 · Am7 · Bbmaj7 · C7sus4→C7 · Fmaj9 · Dm7 · Gm7 · C7→C7(b9)
const LOUNGE = [
  { pad: [53, 57, 60, 64], bass: 41 },
  { pad: [52, 55, 57, 60], bass: 45 },
  { pad: [53, 57, 58, 62], bass: 46 },
  { pad: [53, 55, 58, 60], alt: [52, 55, 58, 60], bass: 48 },
  { pad: [55, 57, 60, 64], bass: 41 },
  { pad: [53, 57, 60, 62], bass: 38 },
  { pad: [53, 55, 58, 62], bass: 43 },
  { pad: [52, 55, 58, 60], alt: [52, 55, 58, 61], bass: 36 },
];
const ARP_HOME = [0, -1, 1, 2, -1, 3, -1, 2, 4, -1, 3, -1, 2, 1, -1, 3];
const ARP_LOBBY = [0, -1, 2, -1, 1, -1, 3, -1, 2, -1, 4, -1, 3, -1, 1, -1];
const BASS_HOME = { 0: [0, 3, 1], 3: [12, 1, 0.55], 6: [7, 2, 0.8], 8: [0, 3, 0.9], 11: [7, 1, 0.6], 14: ['app', 2, 0.75] };
const BASS_LOBBY = { 0: [0, 5, 0.9], 6: [7, 2, 0.7], 8: [0, 4, 0.8], 14: ['app', 2, 0.6] };
// Melodía original de piano eléctrico (paso dentro del ciclo de 8 compases, nota, duración en pasos).
const HOME_MELODY = [
  [0, 69, 4], [6, 72, 2], [8, 76, 6],
  [18, 74, 2], [20, 72, 4], [26, 67, 4],
  [32, 77, 4], [38, 74, 2], [40, 69, 6],
  [52, 67, 2], [54, 69, 2], [56, 70, 4], [60, 72, 4],
  [64, 72, 4], [68, 69, 2], [70, 72, 2], [72, 79, 6],
  [82, 77, 2], [84, 76, 2], [86, 74, 6],
  [96, 70, 4], [100, 74, 4], [104, 77, 4], [108, 76, 2],
  [112, 76, 6], [120, 72, 6],
];
const HOME_MEL = new Map(HOME_MELODY.map((e) => [e[0], e]));

function drumsHome(p, st, bar, t) {
  if (st === 0 || st === 8 || (st === 10 && (bar & 3) === 3)) kick(p.out, t, st === 10 ? 0.2 : 0.3);
  if (st === 4 || st === 12) snare(p.out, t, 0.065);
  if (bar === 7 && st >= 14) snare(p.out, t, 0.03);
  if (st % 2 === 0) hat(p.R, t, st % 4 === 2 ? 0.032 : 0.02, st === 14 && (bar & 3) === 3);
  else if (st === 7 || st === 15) hat(p.R, t, 0.011);
}

function drumsLobby(p, st, bar, t) {
  if (st === 0 || st === 8) kick(p.out, t, 0.22);
  if (st === 4 || st === 12) rim(p.R, t, 0.035);
  if (st % 4 === 2) shaker(p.R, t, 0.022);
  else if (st % 2 === 1) shaker(p.R, t, 0.009);
}

function lounge(o) {
  return {
    bpm: () => o.bpm,
    swing: o.swing,
    step(p, s, t) {
      const sd = p.stepDur(), st = s & 15, bar = (s >> 4) & 7, T = o.tr;
      const ch = LOUNGE[bar], nx = LOUNGE[(bar + 1) & 7];
      const chord = ch.alt && st >= 8 ? ch.alt : ch.pad;
      if (st === 0 || (st === 8 && ch.alt)) {
        pad(p.out, t, chord.map((n) => n + T), (ch.alt ? 8 : 16) * sd, o.padV, o.padCut);
      }
      const ai = o.arp[st];
      if (ai >= 0) {
        const arp = chord.map((n) => n + 12);
        arp.push(chord[0] + 24);
        pluck(p.L, t, arp[ai] + T, o.arpV * (st % 4 === 0 ? 1 : 0.7), 0.3, o.arpBright);
      }
      const b = o.bass[st];
      if (b) bass(p.out, t, (b[0] === 'app' ? nx.bass - 1 : ch.bass + b[0]) + T, b[1] * sd, o.bassV * b[2]);
      o.drums(p, st, bar, t);
      if (o.melody && ((s >> 7) & 1) === 1) {
        const e = HOME_MEL.get(s & 127);
        if (e) keys(p.out, t, e[1] + T, 0.05, e[2] * sd + 0.6);
      }
      if (o.comp && (st === 6 || st === 14)) for (const n of chord) keys(p.R, t, n + 12 + T, 0.012, 0.5);
    },
  };
}

// Pensar (re menor): Dm9 · Bbmaj7 · Gm(add9) · A7sus4
const THINK_PROG = [
  { pad: [50, 57, 60, 64], root: 38 },
  { pad: [46, 53, 57, 62], root: 34 },
  { pad: [43, 50, 57, 58], root: 31 },
  { pad: [45, 52, 55, 62], root: 33 },
];
const THINK_MOTIF = [{ 2: 69, 10: 72 }, { 2: 70, 10: 65 }, { 2: 67, 10: 70 }, { 2: 69, 6: 64, 10: 61 }];
const highNote = (x) => (x < 0.34 ? 62 : x < 0.67 ? 69 : 74);

const THINK = {
  bpm: (p) => 78 + 26 * p.intensity,
  init(p, t) {
    const x = p.intensity;
    p.dLP = p.F(p.out, 'lowpass', 200 + 700 * x, 0.9);
    const dg = p.G(p.dLP, 0);
    dg.gain.setTargetAtTime(0.08, t, 0.6);
    p.osc('sine', mtof(38), dg);
    p.osc('triangle', mtof(38), dg, 6);
    p.osc('sawtooth', mtof(38), p.G(dg, 0.25), -5);
    p.hG = p.G(p.F(p.out, 'lowpass', 2200, 0.7), 0);
    p.hG.gain.setTargetAtTime(0.005 + 0.02 * x, t, 0.8);
    p.hO = p.osc('triangle', mtof(highNote(x)), p.hG);
    p.hO2 = p.osc('sine', mtof(highNote(x) + 12), p.G(p.hG, 0.3), 4);
    p.osc('sine', 0.22, p.G(p.hG.gain, 0.003));
    p.aG = p.G(p.F(p.out, 'bandpass', 2600, 0.6), 0);
    p.aG.gain.setTargetAtTime(0.025 + 0.02 * x, t, 1);
    p.noise(p.aG);
  },
  update(p, now) {
    const x = p.intensity, h = highNote(x);
    p.dLP.frequency.setTargetAtTime(200 + 700 * x, now, 0.4);
    p.hG.gain.setTargetAtTime(0.005 + 0.02 * x, now, 0.6);
    p.hO.frequency.setTargetAtTime(mtof(h), now, 0.3);
    p.hO2.frequency.setTargetAtTime(mtof(h + 12), now, 0.3);
    p.aG.gain.setTargetAtTime(0.025 + 0.02 * x, now, 0.6);
  },
  step(p, s, t) {
    const x = p.intensity, sd = p.stepDur(), st = s & 15, bar = (s >> 4) & 3, ch = THINK_PROG[bar];
    if (st === 0) pad(p.out, t, ch.pad, 16 * sd, 0.022 + 0.012 * x, 450 + 1500 * x, 1.2, 1.4);
    if (st % (x < 0.4 ? 8 : 4) === 0) {
      heartbeat(p.out, t, (st === 0 ? 0.42 : 0.32) * (0.85 + 0.3 * x), mtof(ch.root), Math.min(0.22, sd * 1.3));
    }
    if (st % (x > 0.6 ? 1 : 2) === 0) clock(st & 2 ? p.L : p.R, t, (st % 4 === 0 ? 0.07 : 0.045) * (0.7 + 0.5 * x), st % 4 === 0);
    if (x > 0.5 && st % 2 === 0) bass(p.out, t, ch.root + 12, sd * 1.4, 0.05 + 0.1 * (x - 0.5), 250 + 900 * x);
    if (x > 0.25) {
      const m = THINK_MOTIF[bar][st];
      if (m) {
        const v = 0.035 + 0.04 * x;
        pluck(p.L, t, m, v, 0.6, 1000 + 2000 * x);
        pluck(p.R, t + 3 * sd, m, v * 0.4, 0.6, 900 + 1500 * x);
      }
    }
    if (x > 0.75 && st === 0 && (bar & 1) === 0) bell(p.R, t, ch.pad[3] + 24, 0.02, 2.2, 3.01, 0.8);
  },
};

// Suspense tras bloquear la respuesta: dron grave, latido, trémolo agudo (tritono) y golpes con subida de ruido.
const TENSION = {
  bpm: (p) => 68 + 16 * p.intensity,
  init(p, t) {
    const lp = p.F(p.out, 'lowpass', 160, 1.6);
    lp.frequency.setValueAtTime(160, t);
    lp.frequency.setTargetAtTime(1000, t + 0.3, 4);
    const g = p.G(lp, 0);
    g.gain.setTargetAtTime(0.07, t, 0.4);
    p.osc('sawtooth', mtof(26), g, -6);
    p.osc('sawtooth', mtof(38), g, 6);
    p.osc('sine', mtof(38), g);
    p.cG = p.G(p.F(p.out, 'lowpass', 2400, 0.7), 0);
    p.cG.gain.setTargetAtTime(0.016 + 0.012 * p.intensity, t, 2.5);
    const trem = p.G(p.cG, 0.6);
    p.osc('sine', 6.2, p.G(trem.gain, 0.35));
    p.osc('triangle', mtof(69), trem);
    p.osc('triangle', mtof(75), trem, -4);
  },
  update(p, now) { p.cG.gain.setTargetAtTime(0.016 + 0.012 * p.intensity, now, 0.8); },
  step(p, s, t) {
    const sd = p.stepDur(), st = s & 15, bar = (s >> 4) & 1;
    if (st % 4 === 0) heartbeat(p.out, t, st === 0 ? 0.5 : 0.4, 50, 0.2);
    if (st === 0 && bar === 0) boom(p.out, t, 0.28);
    if (st === 0 && bar === 1) riser(p.R, t, 16 * sd, 0.035);
    if (st === 6 || st === 14) pluck(p.L, t, st === 6 ? 50 : 51, 0.05, 0.5, 700);
  },
};

// Celebración (si bemol mayor): Bb · Gm7 · Ebmaj7 · F
const WIN_PROG = [
  { tri: [62, 65, 70], root: 34 },
  { tri: [62, 65, 67, 70], root: 43 },
  { tri: [62, 67, 70, 75], root: 39 },
  { tri: [60, 65, 69, 72], root: 41 },
];
const WIN_STAB = { 0: 2, 3: 1, 6: 2, 10: 3 };
const WIN_MEL = new Map([
  [0, 65, 2], [2, 70, 2], [4, 74, 4], [8, 77, 6], [14, 74, 2],
  [16, 74, 4], [20, 70, 2], [22, 72, 2], [24, 74, 8],
  [32, 79, 4], [36, 77, 2], [38, 75, 2], [40, 74, 4], [44, 70, 4],
  [48, 72, 4], [52, 74, 2], [54, 75, 2], [56, 77, 8],
].map((e) => [e[0], e]));

const WIN = {
  bpm: () => 124,
  step(p, s, t) {
    const sd = p.stepDur(), st = s & 15, bar = (s >> 4) & 3, ch = WIN_PROG[bar];
    if ((s & 63) === 0) cymbal(p.out, t, 0.045, 1.4);
    if (st % 4 === 0) kick(p.out, t, 0.34);
    if (st === 4 || st === 12) clap(p.out, t, 0.09);
    hat(p.R, t, st % 4 === 2 ? 0.03 : st % 2 ? 0.012 : 0.02, st % 4 === 2);
    if (st % 2 === 0) bass(p.out, t, ch.root + (st % 4 === 2 ? 12 : 0), sd * 1.6, 0.15, 800);
    const len = WIN_STAB[st];
    if (len) for (const m of ch.tri) brass(p.L, t, m, len * sd, 0.018);
    const e = WIN_MEL.get(s & 63);
    if (e) brass(p.out, t, e[1], e[2] * sd * 0.92, 0.045);
    if (bar === 3 && st % 2 === 0) bell(p.R, t, ch.tri[(st >> 1) % ch.tri.length] + 24, 0.016, 0.5, 3.01, 1.2);
  },
};

// Cierre triste y breve; después, silencio.
const LOSE_SEQ = {
  0: { pad: [50, 53, 57, 62], len: 6, key: 69 },
  3: { key: 67 },
  6: { pad: [46, 53, 57, 62], len: 6, key: 65 },
  9: { key: 64 },
  12: { pad: [43, 50, 58, 64], len: 3, key: 62 },
  15: { pad: [45, 52, 55, 61], len: 3, key: 61 },
  18: { pad: [50, 57, 62, 65], len: 6, rel: 2.5, key: 62, kd: 3, low: 50 },
};
const LOSE = {
  bpm: () => 76,
  length: 20,
  tail: 4.5,
  step(p, s, t) {
    const ev = LOSE_SEQ[s];
    if (!ev) return;
    const sd = p.stepDur();
    if (ev.pad) pad(p.out, t, ev.pad, ev.len * sd, 0.024, 900, 0.25, ev.rel || 0.8);
    if (ev.key) keys(p.out, t, ev.key, 0.06, ev.kd || 1.4);
    if (ev.low) bell(p.L, t, ev.low, 0.03, 3, 2, 0.6);
  },
};

const SONGS = {
  home: lounge({
    bpm: 116, swing: 0.1, tr: 0, padV: 0.03, padCut: 1300, arp: ARP_HOME, arpV: 0.075, arpBright: 2600,
    bass: BASS_HOME, bassV: 0.17, drums: drumsHome, melody: true,
  }),
  lobby: lounge({
    bpm: 108, swing: 0.16, tr: 2, padV: 0.024, padCut: 950, arp: ARP_LOBBY, arpV: 0.06, arpBright: 2000,
    bass: BASS_LOBBY, bassV: 0.14, drums: drumsLobby, comp: true,
  }),
  think: THINK,
  tension: TENSION,
  win: WIN,
  lose: LOSE,
};

// ───────────────────────── reproductor de música ─────────────────────────

class Player {
  constructor(song, x) {
    const now = ctx.currentTime;
    this.song = song;
    this.intensity = x;
    this.t0 = now;
    this.held = [];
    this.heldNodes = [];
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.linearRampToValueAtTime(1, now + XFADE);
    this.out.connect(musicBus);
    this.L = pan(this.out, -0.35);
    this.R = pan(this.out, 0.35);
    this.step = 0;
    this.next = now + 0.06;
    this.stopAt = Infinity;
    this.disposeAt = 0;
    this.killed = false;
    if (song.init) song.init(this, now);
  }
  // Nodos persistentes (drones) que viven lo que dure el reproductor.
  G(to, v = 1) {
    const g = ctx.createGain(); g.gain.value = v; g.connect(to); this.heldNodes.push(g); return g;
  }
  F(to, type, f, q = 0.7) {
    const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q;
    n.connect(to); this.heldNodes.push(n); return n;
  }
  osc(type, f, to, detune = 0) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = detune;
    o.connect(to); o.start(this.t0); this.held.push(o); return o;
  }
  noise(to) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    s.connect(to); s.start(this.t0, Math.random() * NOISE_SEC * 0.9); this.held.push(s); return s;
  }
  stepDur() { return 15 / this.song.bpm(this); }
  schedule(now, until) {
    if (this.next < now - 0.1) {
      // El hilo principal se bloqueó: saltar los pasos perdidos en vez de soltarlos de golpe.
      while (this.next < now) { this.next += this.stepDur(); this.step++; }
    }
    while (this.next < until && this.next < this.stopAt) {
      if (this.song.length && this.step >= this.song.length) {
        this.stopAt = this.next;
        this.disposeAt = this.next + (this.song.tail || 3);
        break;
      }
      const sd = this.stepDur();
      const t = this.next + (this.step & 1 ? (this.song.swing || 0) * sd : 0);
      this.song.step(this, this.step, t);
      this.next += sd;
      this.step++;
    }
  }
  setIntensity(x, now) {
    this.intensity = x;
    if (this.song.update) this.song.update(this, now);
  }
  fade(now, dur = XFADE) {
    holdParam(this.out.gain, now);
    this.out.gain.linearRampToValueAtTime(0, now + dur);
    this.stopAt = Math.min(this.stopAt, now + dur);
    this.disposeAt = now + dur + 2.5;
  }
  dispose() {
    for (const s of this.held) {
      try { s.stop(); } catch (e) { /* ya parado */ }
      try { s.disconnect(); } catch (e) { /* ya desconectado */ }
    }
    for (const n of this.heldNodes.concat([this.L, this.R, this.out])) {
      try { n.disconnect(); } catch (e) { /* ya desconectado */ }
    }
    this.held.length = 0;
    this.heldNodes.length = 0;
  }
}

function removePlayer(p) {
  const i = players.indexOf(p);
  if (i >= 0) players.splice(i, 1);
  p.dispose();
}

function retire(p, now) {
  if (ctx.state !== 'running') { removePlayer(p); return; } // en pausa no se oye: liberar ya
  p.fade(now);
}

function startPlayer(m, x) {
  const now = ctx.currentTime;
  const p = new Player(SONGS[m], x);
  players.push(p);
  const alive = players.filter((q) => !q.killed);
  if (alive.length > MAX_PLAYERS) {
    const old = alive[0];
    old.killed = true;
    old.fade(now, 0.05);
    old.disposeAt = now + 0.15;
  }
  return p;
}

// ───────────────────────── efectos ─────────────────────────
// Cada efecto recibe su propio nodo de salida y el instante de inicio; devuelve su duración.

const FX = {
  click(o, t) {
    const V = new Voice(), g = V.gain(o), e = perc(g.gain, t, 0.2, 0.002, 0.05);
    V.osc(g, 'triangle', 1300, t, e).frequency.exponentialRampToValueAtTime(700, t + 0.05);
    V.done();
    return e - t;
  },
  hover(o, t) {
    const V = new Voice(), g = V.gain(o), e = perc(g.gain, t, 0.045, 0.006, 0.04);
    V.osc(g, 'sine', 1900, t, e).frequency.linearRampToValueAtTime(2150, t + 0.04);
    V.done();
    return e - t;
  },
  vote(o, t) {
    const V = new Voice(), lp = V.filter(o, 'lowpass', 2800, 0.7);
    for (const [dt, m, d] of [[0, 76, 0.07], [0.065, 83, 0.14]]) {
      const g = V.gain(lp), e = perc(g.gain, t + dt, 0.1, 0.003, d);
      V.osc(g, 'square', mtof(m), t + dt, e);
    }
    V.done();
    return 0.25;
  },
  join(o, t) {
    bell(o, t, 72, 0.12, 0.45, 2, 1.1);
    bell(o, t + 0.09, 79, 0.12, 0.7, 2, 1.1);
    return 0.85;
  },
  leave(o, t) {
    bell(o, t, 76, 0.09, 0.35, 2, 0.9);
    bell(o, t + 0.1, 69, 0.08, 0.55, 2, 0.9);
    return 0.7;
  },
  chat(o, t) {
    const V = new Voice();
    const g = V.gain(o), e = perc(g.gain, t, 0.13, 0.004, 0.09);
    V.osc(g, 'sine', 600, t, e).frequency.exponentialRampToValueAtTime(1050, t + 0.06);
    const g2 = V.gain(o), e2 = perc(g2.gain, t + 0.07, 0.08, 0.004, 0.08);
    V.osc(g2, 'sine', 900, t + 0.07, e2).frequency.exponentialRampToValueAtTime(1400, t + 0.12);
    V.done();
    return 0.22;
  },
  lifeline(o, t) {
    [72, 76, 79, 83, 88].forEach((m, i) => bell(o, t + i * 0.055, m, 0.07, 0.5, 2.01, 1.4));
    const V = new Voice(), g = V.gain(o), bp = V.filter(g, 'bandpass', 900, 1.2);
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(6000, t + 0.45);
    V.noise(bp, t, env(g.gain, t, 0.06, 0.2, 0.1, 0.25));
    V.done();
    return 0.95;
  },
  tick(o, t) {
    const V = new Voice();
    const g = V.gain(o), e = perc(g.gain, t, 0.16, 0.001, 0.05);
    V.osc(g, 'sine', 1500, t, e);
    const g2 = V.gain(o), bp = V.filter(g2, 'bandpass', 3500, 2);
    V.noise(bp, t, perc(g2.gain, t, 0.2, 0.001, 0.025));
    V.done();
    return 0.09;
  },
  final(o, t) {
    const V = new Voice(), g = V.gain(o), lp = V.filter(g, 'lowpass', 3500, 0.7);
    const e = env(g.gain, t, 0.11, 0.005, 0.15, 0.08);
    V.osc(lp, 'square', 880, t, e);
    V.osc(V.gain(lp, 0.6), 'sine', 1760, t, e);
    V.done();
    return e - t;
  },
  lock(o, t) {
    const V = new Voice(), D = 0.9;
    const g = V.gain(o), lp = V.filter(g, 'lowpass', 400, 4);
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(5000, t + D);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + D);
    g.gain.linearRampToValueAtTime(0, t + D + 0.04);
    V.osc(lp, 'sawtooth', 180, t, t + D + 0.06).frequency.exponentialRampToValueAtTime(720, t + D);
    V.osc(lp, 'sawtooth', 270, t, t + D + 0.06, 8).frequency.exponentialRampToValueAtTime(1080, t + D);
    const gn = V.gain(o), hp = V.filter(gn, 'highpass', 800, 0.7);
    hp.frequency.setValueAtTime(800, t);
    hp.frequency.exponentialRampToValueAtTime(7000, t + D);
    gn.gain.setValueAtTime(0, t);
    gn.gain.linearRampToValueAtTime(0.05, t + D);
    gn.gain.linearRampToValueAtTime(0, t + D + 0.04);
    V.noise(hp, t, t + D + 0.06);
    const tk = t + D;
    const gk = V.gain(o), ek = perc(gk.gain, tk, 0.3, 0.002, 0.18);
    V.osc(gk, 'sine', 220, tk, ek).frequency.exponentialRampToValueAtTime(70, tk + 0.12);
    const gc = V.gain(o), bc = V.filter(gc, 'bandpass', 2500, 3);
    V.noise(bc, tk, perc(gc.gain, tk, 0.25, 0.001, 0.04));
    V.done();
    return D + 0.3;
  },
  correct(o, t) {
    [72, 76, 79, 84].forEach((m, i) => pluck(o, t + i * 0.065, m, 0.12, 0.35, 4000));
    bell(o, t + 0.26, 96, 0.06, 1.3, 3.5, 1.2);
    bell(o, t + 0.26, 91, 0.05, 1.1, 2, 1);
    return 1.6;
  },
  wrong(o, t) {
    const V = new Voice(), g = V.gain(o), lp = V.filter(g, 'lowpass', 1500, 1);
    const e = env(g.gain, t, 0.12, 0.01, 0.45, 0.15);
    lp.frequency.setValueAtTime(1500, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.6);
    V.osc(lp, 'sawtooth', 300, t, e).frequency.exponentialRampToValueAtTime(140, t + 0.6);
    V.osc(lp, 'square', 283, t, e).frequency.exponentialRampToValueAtTime(131, t + 0.6);
    V.done();
    return e - t;
  },
  win(o, t) {
    // anacrusa en tresillo y gran acorde de do mayor con campanitas
    brass(o, t, 67, 0.09, 0.08);
    brass(o, t + 0.1, 72, 0.09, 0.08);
    brass(o, t + 0.2, 76, 0.09, 0.08);
    const t1 = t + 0.32;
    for (const m of [48, 60, 64, 67, 72]) brass(o, t1, m, 1.6, 0.045);
    brass(o, t1, 79, 0.45, 0.07);
    brass(o, t1 + 0.48, 77, 0.12, 0.06);
    brass(o, t1 + 0.61, 79, 0.12, 0.06);
    brass(o, t1 + 0.74, 84, 1.0, 0.07);
    kick(o, t1, 0.4);
    cymbal(o, t1, 0.07, 1.8);
    [84, 88, 91, 96, 100].forEach((m, i) => bell(o, t1 + 0.2 + i * 0.07, m, 0.035, 0.8, 3.5, 1));
    return 2.7;
  },
  walk(o, t) {
    // mecanismo + campanilla + monedas: neutro, ni premio ni castigo
    for (const dt of [0, 0.06]) {
      const V = new Voice(), g = V.gain(o), bp = V.filter(g, 'bandpass', 1800, 2.5);
      V.noise(bp, t + dt, perc(g.gain, t + dt, 0.12, 0.001, 0.035));
      V.done();
    }
    bell(o, t + 0.12, 93, 0.07, 0.9, 1.41, 1.2);
    bell(o, t + 0.12, 100, 0.05, 1.0, 1.41, 1);
    clink(o, t + 0.4, 0.04, 2300);
    clink(o, t + 0.5, 0.035, 2650);
    clink(o, t + 0.58, 0.03, 2450);
    return 1.3;
  },
  unlock(o, t) {
    [84, 86, 88, 91, 93, 96, 98, 100].forEach((m, i) => {
      bell(o, t + i * 0.045 + Math.random() * 0.015, m, 0.045, 0.35 + Math.random() * 0.2, 2.01, 0.9);
    });
    const V = new Voice(), g = V.gain(o), hp = V.filter(g, 'highpass', 7000, 0.7);
    V.noise(hp, t, env(g.gain, t, 0.03, 0.2, 0.05, 0.3));
    V.done();
    return 0.9;
  },
  swap(o, t) {
    const V = new Voice();
    const g = V.gain(o), bp = V.filter(g, 'bandpass', 300, 3);
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(3500, t + 0.2);
    bp.frequency.exponentialRampToValueAtTime(500, t + 0.42);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.18);
    g.gain.linearRampToValueAtTime(0, t + 0.45);
    V.noise(bp, t, t + 0.47);
    // tartamudeo digital: alturas aleatorias escalonadas
    const gs = V.gain(o), lp = V.filter(gs, 'lowpass', 3000, 1);
    const x = V.osc(lp, 'square', 600, t, t + 0.32);
    for (let i = 0; i < 9; i++) {
      const ti = t + i * 0.03;
      x.frequency.setValueAtTime(300 + Math.random() * 1500, ti);
      gs.gain.setTargetAtTime(i % 3 === 2 ? 0 : 0.035, ti, 0.002);
    }
    gs.gain.setTargetAtTime(0, t + 0.27, 0.006);
    V.done();
    return 0.5;
  },
  poll(o, t) {
    // murmullo del público: ruido filtrado en varias "voces" con modulación de sílabas, que crece y se apaga
    const V = new Voice(), D = 1.9, g = V.gain(o), p = g.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(0.5, t + 1.1);
    p.setValueAtTime(0.5, t + 1.25);
    p.exponentialRampToValueAtTime(0.0005, t + D - 0.02);
    p.linearRampToValueAtTime(0, t + D);
    for (const [f, r] of [[420, 4.1], [700, 5.3], [1150, 3.7], [1800, 6.1], [2600, 4.7]]) {
      const am = V.gain(g, 0.5), bp = V.filter(am, 'bandpass', f, 2.2);
      bp.frequency.setValueAtTime(f, t);
      bp.frequency.linearRampToValueAtTime(f * 1.15, t + D);
      V.noise(bp, t, t + D);
      V.osc(V.gain(am.gain, 0.45), 'sine', r * (0.9 + Math.random() * 0.2), t, t + D);
      V.osc(V.gain(am.gain, 0.25), 'sine', r * 0.37, t, t + D);
    }
    V.done();
    return D;
  },
  whoosh(o, t) {
    const V = new Voice(), g = V.gain(o), bp = V.filter(g, 'bandpass', 400, 1.3);
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.2);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.42);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.16);
    g.gain.linearRampToValueAtTime(0, t + 0.42);
    V.noise(bp, t, t + 0.44);
    V.done();
    return 0.45;
  },
  start(o, t) {
    for (let i = 0; i < 6; i++) snare(o, t + i * 0.045, 0.03 + i * 0.012);
    const t1 = t + 0.3;
    kick(o, t1, 0.45);
    cymbal(o, t1, 0.06, 1.4);
    for (const m of [55, 62, 67, 71]) brass(o, t1, m, 0.12, 0.05);
    for (const m of [48, 60, 64, 67, 72, 76]) brass(o, t1 + 0.16, m, 0.9, 0.04);
    bell(o, t1 + 0.16, 88, 0.035, 1, 3.5, 1);
    return 1.5;
  },
  coin(o, t) {
    clink(o, t, 0.09, 2300);
    clink(o, t + 0.075, 0.08, 3050);
    return 0.4;
  },
  react(o, t) {
    const V = new Voice(), g = V.gain(o), e = perc(g.gain, t, 0.15, 0.003, 0.07);
    V.osc(g, 'sine', 380, t, e).frequency.exponentialRampToValueAtTime(850, t + 0.05);
    V.done();
    return 0.1;
  },
};

function pruneFx(now) {
  fxActive = fxActive.filter((a) => {
    if (now < a.end + 0.15) return true;
    try { a.o.disconnect(); } catch (e) { /* ya desconectado */ }
    return false;
  });
}

// Roba una voz: fundido rapidísimo y desconexión.
function steal(a, now) {
  const i = fxActive.indexOf(a);
  if (i >= 0) fxActive.splice(i, 1);
  holdParam(a.o.gain, now);
  a.o.gain.linearRampToValueAtTime(0, now + 0.03);
  setTimeout(() => { try { a.o.disconnect(); } catch (e) { /* ya desconectado */ } }, 90);
}

function playFx(name) {
  if (!ctx || ctx.state !== 'running') return;
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(FX, name)) return;
  const now = ctx.currentTime;
  const last = fxLast[name];
  if (last !== undefined && now - last >= 0 && now - last < (FX_GAP[name] || 0.03)) return;
  fxLast[name] = now;
  pruneFx(now);
  const same = fxActive.filter((a) => a.name === name);
  if (same.length >= (FX_SAME[name] || 3)) steal(same[0], now);
  while (fxActive.length >= MAX_SFX) steal(fxActive[0], now);
  const o = ctx.createGain();
  o.connect(sfxBus);
  const t = now + 0.005;
  const dur = FX[name](o, t);
  fxActive.push({ name, o, end: t + (dur || 1) });
}

// ───────────────────────── núcleo ─────────────────────────

function tick() {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime, until = now + LOOKAHEAD;
  for (let i = players.length - 1; i >= 0; i--) {
    const p = players[i];
    if (p.disposeAt && now >= p.disposeAt) { players.splice(i, 1); p.dispose(); continue; }
    try {
      p.schedule(now, until);
    } catch (e) {
      if (!warned) { warned = true; console.warn('[audio] error en el planificador', e); }
      p.stopAt = now;
      p.disposeAt = now + 1;
    }
  }
  pruneFx(now);
}

function onVisibility() {
  if (!ctx || ctx.state === 'closed') return;
  if (document.hidden) { if (ctx.state === 'running') quiet(ctx.suspend()); }
  else if (ctx.state !== 'running') quiet(ctx.resume());
}

function init() {
  try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 10;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  const master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(comp);
  comp.connect(ctx.destination);
  musicBus = ctx.createGain();
  musicBus.gain.value = vol.music * MUSIC_SCALE;
  musicBus.connect(master);
  sfxBus = ctx.createGain();
  sfxBus.gain.value = vol.sfx * SFX_SCALE;
  sfxBus.connect(master);
  noiseBuf = makeNoise();
  // Reverberación corta compartida (respuesta al impulso generada, no grabada).
  try {
    const rev = ctx.createConvolver();
    rev.buffer = makeIR(1.8);
    const revOut = ctx.createGain(); revOut.gain.value = 0.55;
    rev.connect(revOut); revOut.connect(master);
    const sm = ctx.createGain(); sm.gain.value = 0.3; musicBus.connect(sm); sm.connect(rev);
    const ss = ctx.createGain(); ss.gain.value = 0.12; sfxBus.connect(ss); ss.connect(rev);
  } catch (e) { /* sin reverberación */ }
  // iOS: un búfer silencioso dentro del gesto desbloquea la salida.
  try {
    const b = ctx.createBufferSource();
    b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    b.connect(ctx.destination);
    b.onended = () => { try { b.disconnect(); } catch (e) { /* nada */ } };
    b.start(0);
  } catch (e) { /* nada */ }
  setInterval(tick, TICK_MS);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (mode === 'lose') mode = 'off'; // un cierre pedido antes del desbloqueo ya no tiene sentido
  if (mode !== 'off') current = startPlayer(mode, intensity);
}

export const audio = {
  unlock() {
    if (!AC) return;
    try {
      if (!ctx) init();
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (ctx.state !== 'running' && ctx.state !== 'closed' && !hidden) quiet(ctx.resume());
    } catch (e) { /* el audio nunca debe romper el juego */ }
  },

  setVolumes(v) {
    try {
      if (!v || typeof v !== 'object') return;
      if (typeof v.music === 'number' && isFinite(v.music)) vol.music = clamp01(v.music);
      if (typeof v.sfx === 'number' && isFinite(v.sfx)) vol.sfx = clamp01(v.sfx);
      if (!ctx) return;
      const now = ctx.currentTime;
      musicBus.gain.setTargetAtTime(vol.music * MUSIC_SCALE, now, 0.06);
      sfxBus.gain.setTargetAtTime(vol.sfx * SFX_SCALE, now, 0.06);
    } catch (e) { /* nada */ }
  },

  setMusic(m, x = 0) {
    try {
      if (m !== 'off' && !Object.prototype.hasOwnProperty.call(SONGS, m)) return;
      intensity = clamp01(Number(x) || 0);
      if (!AC) return;
      if (!ctx) { mode = m; return; } // se aplica al desbloquear
      const now = ctx.currentTime;
      if (m === mode) {
        if (current) current.setIntensity(intensity, now);
        return;
      }
      mode = m;
      if (current) { retire(current, now); current = null; }
      if (m !== 'off') current = startPlayer(m, intensity);
    } catch (e) { /* nada */ }
  },

  sfx(name) {
    try { playFx(name); } catch (e) { /* nada */ }
  },

  get enabled() {
    return !!ctx && ctx.state === 'running';
  },
};
