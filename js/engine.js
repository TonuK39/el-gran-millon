// Motor de partida autoritativo: lo ejecuta solo el anfitrión de la sala.
// Los demás clientes envían acciones y reciben el estado completo.
import { LADDERS, safeLevels, levelDifficulty, ROLES, BASE_ROLES, MAX_PLAYERS, CATEGORIES, THEMES, TIME_OPTIONS } from './config.js';
import { toPlayable } from './questions.js';

const INTRO_MS = 3400;
const INTRO_SHORT = 2300;
const FINAL_MS = 4000;
const REVEAL_OK = 3700;
const REVEAL_BAD = 4300;
const RETRY_MS = 2800;
const lockMs = n => 1500 + Math.min(2800, n * 190);

const rid = () => Math.random().toString(36).slice(2, 10);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export function defaultSettings() {
  return {
    team: '', cats: CATEGORIES.map(c => c.id), len: 15, time: 30, diff: 'normal', safe: 'clasico',
    theme: 'gala', pub: false, customMode: 'off', customCount: 0,
  };
}

export function newRoomState(hostId, settings) {
  return { rev: 0, hostId, phase: 'lobby', settings, players: [], game: null, evs: [] };
}

function makePoll(answer, d, removed) {
  const avail = [0, 1, 2, 3].filter(i => !removed.includes(i));
  let acc = [0.74, 0.62, 0.5, 0.41, 0.34][d - 1] + (Math.random() * 0.14 - 0.07);
  if (avail.length === 2) acc = Math.max(acc, 0.56);
  let fav = answer;
  // En preguntas difíciles el público a veces se equivoca.
  if (Math.random() > Math.min(0.95, acc + 0.33)) {
    const wrong = avail.filter(i => i !== answer);
    if (wrong.length) fav = wrong[Math.floor(Math.random() * wrong.length)];
  }
  const p = [0, 0, 0, 0];
  p[fav] = acc;
  let rest = 1 - acc;
  const others = shuffle(avail.filter(i => i !== fav));
  others.forEach((o, k) => {
    const share = k === others.length - 1 ? rest : rest * (0.35 + Math.random() * 0.4);
    p[o] = share; rest -= share;
  });
  const ints = p.map(x => Math.round(x * 100));
  const diff = 100 - ints.reduce((a, b) => a + b, 0);
  ints[fav] += diff;
  return ints;
}

function makeHint(answer, d, removed) {
  const avail = [0, 1, 2, 3].filter(i => !removed.includes(i));
  const conf = Math.max(35, Math.min(98, [94, 84, 72, 61, 52][d - 1] + Math.round(Math.random() * 14 - 7)));
  let idx = answer;
  if (Math.random() > conf / 100 + 0.04) {
    const wrong = avail.filter(i => i !== answer);
    if (wrong.length) idx = wrong[Math.floor(Math.random() * wrong.length)];
  }
  return { idx, conf };
}

export class Engine {
  constructor({ bank, meId, send, onLocal, onOver }) {
    this.bank = bank;
    this.meId = meId;
    this.send = send;
    this.onLocal = onLocal;
    this.onOver = onOver;
    this.state = null;
    this.answer = null;
    this.custom = { text: '', list: [] };
    this.seen = new Map();
    this.banned = new Set();
    this.used = new Set();
    this.t = { phaseEnd: 0, deadline: 0, finalAt: 0, total: 0, remainAtLock: 0 };
    this.lastSend = 0;
    this.seq = 0;
    this.flushQueued = false;
    this.interval = setInterval(() => this.tick(), 120);
  }

  destroy() { clearInterval(this.interval); this.interval = null; }

  // Crear sala nueva o heredar el estado de un anfitrión que se fue.
  init(state) {
    this.state = state;
    this.state.hostId = this.meId;
    const g = state.game;
    if (g) {
      this.used = new Set(g.asked || []);
      if (g.q && g.answer == null) this.answer = this.lookupAnswer(g.q);
      else this.answer = g.answer;
      const now = Date.now();
      const tm = g.timer || {};
      this.t.deadline = tm.left != null ? now + tm.left : 0;
      this.t.total = tm.total || 0;
      this.t.finalAt = tm.final != null ? now + tm.final : 0;
      this.t.phaseEnd = tm.phase != null ? now + tm.phase : now + 1500;
      this.seq = Math.max(0, ...(state.evs || []).map(e => e.seq));
    }
    this.push();
  }

  setCustom(custom) {
    this.custom = custom;
    if (this.state) {
      this.state.settings.customCount = custom.list.length;
      if (!custom.list.length && this.state.settings.customMode !== 'off') this.state.settings.customMode = 'off';
      this.push();
    }
  }

  lookupAnswer(q) {
    const item = q.custom ? this.custom.list.find(x => x.id === q.id) : this.bank.byId.get(q.id);
    return item ? q.opts.indexOf(item.correct) : 0;
  }

  event(kind, by, extra = {}) {
    const s = this.state;
    s.evs = [...(s.evs || []), { seq: ++this.seq, kind, by, ...extra }].slice(-6);
  }

  push() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => { this.flushQueued = false; this.flush(); });
  }

  flush() {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    s.rev++;
    if (s.game) {
      s.game.timer = {
        left: this.t.deadline ? Math.max(0, this.t.deadline - now) : null,
        total: this.t.total || null,
        final: this.t.finalAt ? Math.max(0, this.t.finalAt - now) : null,
        phase: this.t.phaseEnd ? Math.max(0, this.t.phaseEnd - now) : null,
      };
    }
    this.lastSend = now;
    this.send('state', s);
    this.onLocal(JSON.parse(JSON.stringify(s)));
  }

  // ---- Presencia → jugadores ------------------------------------------
  syncMembers(members) {
    const s = this.state;
    if (!s) return;
    for (const p of s.players) {
      const m = members.find(x => x.id === p.id);
      if (m) { p.name = m.name; p.av = m.av; p.online = true; } else p.online = false;
    }
    for (const m of members) {
      if (s.players.some(p => p.id === m.id)) continue;
      if (this.banned.has(m.id)) { this.send('kick', { id: m.id, reason: 'kick' }); continue; }
      if (s.players.filter(p => p.online).length >= MAX_PLAYERS) { this.send('kick', { id: m.id, reason: 'full' }); continue; }
      s.players.push({ id: m.id, name: m.name, av: m.av, role: null, online: true });
      this.event('join', m.id);
    }
    if (s.phase === 'lobby') s.players = s.players.filter(p => p.online);
    if (s.phase === 'voting') this.checkAllVoted(false);
    this.push();
  }

  kick(id) {
    const s = this.state;
    if (id === this.meId) return;
    this.banned.add(id);
    s.players = s.players.filter(p => p.id !== id);
    this.send('kick', { id, reason: 'kick' });
  }

  // ---- Acciones ----------------------------------------------------------
  act(from, a) {
    const s = this.state;
    if (!s || !a) return null;
    if (a.t === 'seen') { this.seen.set(from, new Set((a.ids || []).slice(-1500))); return null; }
    const p = s.players.find(x => x.id === from);
    if (!p) return null;
    const isHost = from === s.hostId;
    let err = null;
    switch (a.t) {
      case 'role': {
        if (s.phase !== 'lobby') return null;
        const role = a.role || null;
        if (role && !ROLES[role]) return null;
        if (role && s.players.some(x => x.id !== from && x.role === role)) return null;
        p.role = p.role === role ? null : role;
        break;
      }
      case 'settings': if (!isHost || s.phase !== 'lobby') return null; this.applySettings(a.patch || {}); break;
      case 'start': if (!isHost || s.phase !== 'lobby') return null; err = this.start(); break;
      case 'vote': this.vote(p, a.o); break;
      case 'life': this.useLife(p, a.role); break;
      case 'lobby':
        if (!isHost || s.phase !== 'over') return null;
        s.phase = 'lobby'; s.game = null;
        s.players = s.players.filter(x => x.online);
        this.t = { phaseEnd: 0, deadline: 0, finalAt: 0, total: 0, remainAtLock: 0 };
        break;
      case 'kick': if (!isHost) return null; this.kick(a.id); break;
      default: return null;
    }
    this.push();
    return err;
  }

  applySettings(patch) {
    const st = this.state.settings;
    if (typeof patch.team === 'string') st.team = patch.team.slice(0, 28);
    if (Array.isArray(patch.cats)) st.cats = patch.cats.filter(c => CATEGORIES.some(x => x.id === c));
    if ([10, 15, 20].includes(patch.len)) st.len = patch.len;
    if (TIME_OPTIONS.includes(patch.time)) st.time = patch.time;
    if (['facil', 'normal', 'dificil'].includes(patch.diff)) st.diff = patch.diff;
    if (['clasico', 'uno', 'ninguno'].includes(patch.safe)) st.safe = patch.safe;
    if (THEMES[patch.theme]) st.theme = patch.theme;
    if (typeof patch.pub === 'boolean') st.pub = patch.pub;
    if (['off', 'mix', 'only'].includes(patch.customMode)) st.customMode = this.custom.list.length ? patch.customMode : 'off';
  }

  assignRoles() {
    const s = this.state;
    const online = s.players.filter(p => p.online);
    const life = {};
    for (const p of online) if (p.role && ROLES[p.role] && !life[p.role]) life[p.role] = { owner: p.id, used: false };
    const owned = id => Object.values(life).filter(l => l.owner === id).length;
    for (const r of BASE_ROLES) {
      if (Object.keys(life).length >= 4) break;
      if (life[r]) continue;
      const owner = [...online].sort((a, b) => owned(a.id) - owned(b.id))[0];
      life[r] = { owner: owner.id, used: false };
    }
    return life;
  }

  start() {
    const s = this.state, st = s.settings;
    if (st.customMode === 'only' && this.custom.list.length < st.len) return `Necesitas al menos ${st.len} preguntas personalizadas (tienes ${this.custom.list.length}).`;
    if (st.customMode !== 'only' && !st.cats.length) return 'Elige al menos un tema.';
    if (st.customMode !== 'only' && !this.bank.loaded) return 'Las preguntas aún se están cargando.';
    s.players = s.players.filter(p => p.online);
    this.used = new Set();
    s.game = {
      id: rid(), n: 0, len: st.len, ladder: LADDERS[st.len], safe: safeLevels(st.len, st.safe), time: st.time,
      q: null, answer: null, removed: [], poll: null, hint: null, dbl: false, votes: {}, picked: null, result: null,
      life: this.assignRoles(), asked: [], correct: 0, outcome: null, lastCat: null, custom: false, timer: null,
      team: st.team || `Equipo de ${(s.players.find(p => p.id === s.hostId) || {}).name || 'anfitrión'}`,
      roster: s.players.map(p => ({ id: p.id, name: p.name, av: p.av })),
    };
    this.event('start', this.meId);
    this.nextQuestion(false);
    return null;
  }

  pickItem(d) {
    const s = this.state, st = s.settings, g = s.game;
    const seenCount = id => { let c = 0; for (const set of this.seen.values()) if (set.has(id)) c++; return c; };
    const customPool = this.custom.list.filter(x => !this.used.has(x.id));
    if (st.customMode === 'only') return this.bank.pick({ cats: [], d, used: this.used, seenCount, lastCat: null, pool: customPool });
    if (st.customMode === 'mix' && customPool.length && Math.random() < 0.4) {
      const it = this.bank.pick({ cats: [], d, used: this.used, seenCount, lastCat: null, pool: customPool });
      if (it) return it;
    }
    let it = this.bank.pick({ cats: st.cats, d, used: this.used, seenCount, lastCat: g.lastCat });
    if (!it && customPool.length) it = this.bank.pick({ cats: [], d, used: this.used, seenCount, lastCat: null, pool: customPool });
    return it;
  }

  nextQuestion(short) {
    const s = this.state, g = s.game;
    const d = levelDifficulty(g.n, g.len, s.settings.diff);
    let item = this.pickItem(d);
    if (!item) { this.used = new Set(g.asked.slice(-3)); item = this.pickItem(d); }
    if (!item) { this.gameOver('win'); return; }
    this.used.add(item.id);
    const { q, answer } = toPlayable(item);
    q.d = d;
    g.q = q;
    this.answer = answer;
    g.answer = null; g.removed = []; g.poll = null; g.hint = null; g.votes = {}; g.picked = null; g.result = null;
    g.lastCat = item.cat;
    if (q.custom) g.custom = true;
    g.asked.push(item.id);
    s.phase = 'intro';
    this.t.phaseEnd = Date.now() + (short ? INTRO_SHORT : INTRO_MS);
    this.t.deadline = 0; this.t.finalAt = 0; this.t.total = 0;
    this.push();
  }

  startVoting(ms) {
    const s = this.state;
    s.phase = 'voting';
    this.t.phaseEnd = 0;
    this.t.finalAt = 0;
    this.t.total = ms || 0;
    this.t.deadline = ms ? Date.now() + ms : 0;
    this.push();
  }

  vote(p, o) {
    const s = this.state, g = s.game;
    if (!g || s.phase !== 'voting' || !p.online) return;
    if (!(o === 4 || (Number.isInteger(o) && o >= 0 && o <= 3 && !g.removed.includes(o)))) return;
    const cur = g.votes[p.id];
    let changed = true;
    if (cur && cur.o === o) { cur.c = true; changed = false; } else g.votes[p.id] = { o, t: Date.now(), c: false };
    this.checkAllVoted(changed);
  }

  checkAllVoted(changed) {
    const s = this.state, g = s.game;
    const online = s.players.filter(p => p.online);
    const all = online.length > 0 && online.every(p => g.votes[p.id]);
    if (!all) { this.t.finalAt = 0; return; }
    if (online.every(p => g.votes[p.id].c)) { this.resolve(); return; }
    if (changed || !this.t.finalAt) this.t.finalAt = Date.now() + FINAL_MS;
  }

  resolve() {
    const s = this.state, g = s.game;
    const onlineIds = new Set(s.players.filter(p => p.online).map(p => p.id));
    const by = new Map();
    for (const [pid, v] of Object.entries(g.votes)) {
      if (!onlineIds.has(pid)) continue;
      if (v.o !== 4 && g.removed.includes(v.o)) continue;
      const e = by.get(v.o) || { n: 0, t: 0 };
      e.n++; e.t = Math.max(e.t, v.t);
      by.set(v.o, e);
    }
    this.t.remainAtLock = this.t.deadline ? Math.max(0, this.t.deadline - Date.now()) : 0;
    this.t.deadline = 0; this.t.finalAt = 0;
    if (!by.size) { g.picked = null; this.reveal(); return; }
    // Mayoría; en empate gana la opción que llegó antes a ese número de votos.
    let best = null;
    for (const [o, e] of by) if (!best || e.n > best.e.n || (e.n === best.e.n && e.t < best.e.t)) best = { o, e };
    g.picked = best.o;
    if (best.o === 4) { g.result = 'walk'; this.gameOver('walk'); return; }
    s.phase = 'locked';
    this.t.phaseEnd = Date.now() + lockMs(g.n);
    this.push();
  }

  reveal() {
    const s = this.state, g = s.game;
    s.phase = 'reveal';
    if (g.picked != null && g.picked === this.answer) {
      g.result = 'ok'; g.correct++; g.answer = this.answer;
      this.t.phaseEnd = Date.now() + REVEAL_OK;
    } else if (g.picked != null && g.dbl) {
      g.result = 'retry'; g.dbl = false;
      g.removed = [...g.removed, g.picked];
      this.t.phaseEnd = Date.now() + RETRY_MS;
    } else {
      g.result = g.picked == null ? 'timeout' : 'bad';
      g.answer = this.answer;
      this.t.phaseEnd = Date.now() + REVEAL_BAD;
    }
    this.push();
  }

  afterReveal() {
    const g = this.state.game;
    if (g.result === 'ok') {
      g.n++;
      g.dbl = false;
      if (g.n >= g.len) this.gameOver('win'); else this.nextQuestion(false);
    } else if (g.result === 'retry') {
      g.votes = {}; g.picked = null; g.result = null;
      const t = this.state.settings.time;
      this.startVoting(t ? Math.max(15000, this.t.remainAtLock) : 0);
    } else this.gameOver('lose');
  }

  gameOver(kind) {
    const s = this.state, g = s.game;
    const n = g.n;
    let prize = 0;
    if (kind === 'win') prize = g.ladder[g.len - 1];
    else if (kind === 'walk') prize = n > 0 ? g.ladder[n - 1] : 0;
    else { const safes = g.safe.filter(i => i < n); prize = safes.length ? g.ladder[Math.max(...safes)] : 0; }
    g.answer = this.answer;
    g.outcome = { kind, prize, level: n };
    s.phase = 'over';
    this.t = { phaseEnd: 0, deadline: 0, finalAt: 0, total: 0, remainAtLock: 0 };
    this.event('over', this.meId);
    this.push();
    try { this.onOver && this.onOver(JSON.parse(JSON.stringify(s))); } catch (e) { console.warn(e); }
  }

  useLife(p, role) {
    const s = this.state, g = s.game;
    if (!g || s.phase !== 'voting') return;
    const L = g.life[role];
    if (!L || L.used) return;
    const owner = s.players.find(x => x.id === L.owner);
    if (L.owner !== p.id && owner && owner.online) return;
    switch (role) {
      case 'sabio': {
        const wrong = shuffle([0, 1, 2, 3].filter(i => i !== this.answer && !g.removed.includes(i)));
        // Quita hasta 2 incorrectas, pero siempre deja al menos una incorrecta junto a la correcta.
        const k = Math.min(2, wrong.length - 1);
        if (k <= 0) return;
        g.removed = [...g.removed, ...wrong.slice(0, k)];
        for (const [pid, v] of Object.entries(g.votes)) if (g.removed.includes(v.o)) delete g.votes[pid];
        this.t.finalAt = 0;
        break;
      }
      case 'influencer': g.poll = makePoll(this.answer, g.q.d, g.removed); break;
      case 'profesora': g.hint = makeHint(this.answer, g.q.d, g.removed); break;
      case 'suertudo': if (g.dbl) return; g.dbl = true; break;
      case 'crono':
        if (!this.t.deadline) return;
        this.t.deadline += 30000; this.t.total += 30000;
        break;
      case 'hacker':
        L.used = true; L.by = p.id;
        this.event('life', p.id, { role });
        this.nextQuestion(true);
        return;
      default: return;
    }
    L.used = true; L.by = p.id;
    this.event('life', p.id, { role });
  }

  tick() {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    if (s.game) {
      switch (s.phase) {
        case 'intro':
          if (now >= this.t.phaseEnd) this.startVoting(s.settings.time * 1000);
          break;
        case 'voting':
          if (this.t.finalAt && now >= this.t.finalAt) this.resolve();
          else if (this.t.deadline && now >= this.t.deadline) this.resolve();
          break;
        case 'locked':
          if (now >= this.t.phaseEnd) this.reveal();
          break;
        case 'reveal':
          if (now >= this.t.phaseEnd) this.afterReveal();
          break;
        default: break;
      }
    }
    if (now - this.lastSend > 4000) this.push(); // latido para quien entra tarde o perdió mensajes
  }
}
