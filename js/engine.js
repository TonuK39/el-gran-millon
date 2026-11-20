// Motor de partida autoritativo: lo ejecuta solo el anfitrión de la sala.
// Los demás clientes envían acciones y reciben el estado completo.
import { LADDERS, safeLevels, levelDifficulty, ROLES, BASE_ROLES, MAX_PLAYERS, CATEGORIES, THEMES, TIME_OPTIONS } from './config.js';
import { toPlayable } from './questions.js';

const INTRO_MS = 3400;
const INTRO_SHORT = 2300;
const REVEAL_OK = 3700;
const REVEAL_BAD = 4300;
const RETRY_MS = 2800;
const lockMs = n => 1500 + Math.min(2800, n * 190);

const rid = () => Math.random().toString(36).slice(2, 10);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export function defaultSettings() {
  return {
    team: '', cats: CATEGORIES.map(c => c.id), len: 15, time: 30, diff: 'normal', safe: 'clasico',
    theme: 'gala', pub: false, customMode: 'off', customCount: 0, mode: 'coop',
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
      this.pAns = {};
      if (g.comp) for (const [pid, P] of Object.entries(g.comp.p)) if (P.q) this.pAns[pid] = this.lookupAnswer(P.q);
      this.t.votingStart = now - Math.max(0, (tm.total || 0) - (tm.left || 0));
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
    if (s.phase === 'voting') { if (this.isComp()) this.compCheck(); else this.checkAllVoted(false); }
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
      case 'vote': if (this.isComp()) this.compVote(p, a.o); else this.vote(p, a.o); break;
      case 'life': if (this.isComp()) this.compLife(p, a.role); else this.useLife(p, a.role); break;
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
    if (['coop', 'comp'].includes(patch.mode)) st.mode = patch.mode;
    if (['off', 'mix', 'only'].includes(patch.customMode)) st.customMode = this.custom.list.length ? patch.customMode : 'off';
  }

  // Cada jugador tiene exactamente un comodín: el de su rol. Quien no eligió recibe uno libre al azar.
  assignRoles() {
    const s = this.state;
    const online = s.players.filter(p => p.online);
    const life = {};
    for (const p of online) if (p.role && ROLES[p.role] && !life[p.role]) life[p.role] = { owner: p.id, used: false };
    for (const p of online) {
      if (Object.values(life).some(l => l.owner === p.id)) continue;
      const free = shuffle(BASE_ROLES.filter(r => !life[r]));
      const r = free[0] || shuffle(Object.keys(ROLES).filter(x => !life[x]))[0];
      if (r) { life[r] = { owner: p.id, used: false, auto: true }; p.role = r; }
    }
    return life;
  }

  start() {
    const s = this.state, st = s.settings;
    if (st.customMode === 'only' && this.custom.list.length < st.len) return `Necesitas al menos ${st.len} preguntas personalizadas (tienes ${this.custom.list.length}).`;
    if (st.customMode !== 'only' && !st.cats.length) return 'Elige al menos un tema.';
    if (st.customMode !== 'only' && !this.bank.loaded) return 'Las preguntas aún se están cargando.';
    s.players = s.players.filter(p => p.online);
    if (st.mode === 'comp' && s.players.length < 2) return 'El modo competitivo necesita al menos 2 jugadores.';
    this.used = new Set();
    s.game = {
      id: rid(), n: 0, len: st.len, ladder: LADDERS[st.len], safe: safeLevels(st.len, st.safe), time: st.time,
      q: null, answer: null, removed: [], poll: null, hint: null, dbl: false, votes: {}, picked: null, result: null,
      life: this.assignRoles(), asked: [], correct: 0, outcome: null, lastCat: null, custom: false, timer: null,
      team: st.team || 'Los Sin Nombre', ps: {},
      roster: s.players.map(p => ({ id: p.id, name: p.name, av: p.av })),
    };
    if (st.mode === 'comp') this.compInit();
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
    const d = g.comp && g.comp.sd ? 5 : levelDifficulty(Math.min(g.n, g.len - 1), g.len, s.settings.diff);
    let item = this.pickItem(d);
    if (!item) { this.used = new Set(g.asked.slice(-3)); item = this.pickItem(d); }
    if (!item) { if (g.comp) this.compOver(); else this.gameOver('win'); return; }
    this.used.add(item.id);
    const { q, answer } = toPlayable(item);
    q.d = d;
    g.q = q;
    this.answer = answer;
    g.answer = null; g.removed = []; g.poll = null; g.hint = null; g.votes = {}; g.picked = null; g.result = null;
    g.lastCat = item.cat;
    if (q.custom) g.custom = true;
    g.asked.push(item.id);
    if (g.comp && !short) this.compResetRound();
    s.phase = 'intro';
    this.t.phaseEnd = Date.now() + (short ? INTRO_SHORT : INTRO_MS);
    this.t.deadline = 0; this.t.finalAt = 0; this.t.total = 0;
    this.push();
  }

  startVoting(ms) {
    const s = this.state;
    s.phase = 'voting';
    this.t.votingStart = Date.now();
    this.t.phaseEnd = 0;
    this.t.finalAt = 0;
    this.t.total = ms || 0;
    this.t.deadline = ms ? Date.now() + ms : 0;
    this.push();
  }

  vote(p, o) {
    const s = this.state, g = s.game;
    if (!g || s.phase !== 'voting' || !p.online) return;
    if (g.comp) return;
    if (!(o === 4 || (Number.isInteger(o) && o >= 0 && o <= 3 && !g.removed.includes(o)))) return;
    const cur = g.votes[p.id];
    if (cur && cur.o === o) cur.c = true; else g.votes[p.id] = { o, t: Date.now(), c: false };
    this.checkAllVoted();
  }

  checkAllVoted() {
    const s = this.state, g = s.game;
    const online = s.players.filter(p => p.online);
    if (online.length > 0 && online.every(p => g.votes[p.id] && g.votes[p.id].c)) this.resolve();
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
    const final = !(g.picked != null && g.picked !== this.answer && g.dbl);
    if (final) {
      g.ps = g.ps || {};
      for (const [pid, v] of Object.entries(g.votes)) {
        const st = g.ps[pid] || (g.ps[pid] = { ok: 0, n: 0 });
        st.n++;
        if (v.o === this.answer) st.ok++;
      }
    }
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
    if (L.owner !== p.id) return;
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

  // =====================================================================
  // Modo competitivo: todos responden las mismas preguntas por su cuenta,
  // nadie queda eliminado, cada acierto paga el valor del escalón y gana
  // quien junte más. Cada jugador tiene solo el comodín de su rol, una vez.
  // Empate al final: muerte súbita entre los empatados.
  // =====================================================================
  isComp() { const g = this.state && this.state.game; return !!(g && g.comp); }

  compInit() {
    const g = this.state.game;
    this.pAns = {};
    const p = {};
    const roleOf = {};
    for (const [role, L] of Object.entries(this.assignRoles())) roleOf[L.owner] = role;
    for (const r of g.roster) p[r.id] = this.compFresh(roleOf[r.id]);
    g.comp = { p, role: roleOf, score: {}, correct: {}, timeMs: {}, sd: null, sdRound: 0, rank: null };
    for (const r of g.roster) { g.comp.score[r.id] = 0; g.comp.correct[r.id] = 0; g.comp.timeMs[r.id] = 0; }
    g.life = {};
  }
  compFresh(role) {
    return {
      o: null, c: false, t: 0, res: null, removed: [], poll: null, hint: null, dbl: false, retry: false, extra: 0, q: null, ans: null,
      life: role ? { [role]: false } : {},
    };
  }
  // Quién juega la pregunta actual (en muerte súbita, solo los empatados).
  compPlayers() {
    const g = this.state.game;
    const ids = g.comp.sd ? g.comp.sd : g.roster.map(r => r.id);
    return ids.filter(id => g.comp.p[id]);
  }
  compOnline() {
    const on = new Set(this.state.players.filter(p => p.online).map(p => p.id));
    return this.compPlayers().filter(id => on.has(id));
  }
  compResetRound() {
    const g = this.state.game;
    this.pAns = {};
    for (const P of Object.values(g.comp.p)) {
      P.o = null; P.c = false; P.t = 0; P.res = null; P.removed = []; P.poll = null; P.hint = null;
      P.retry = false; P.extra = 0; P.q = null; P.ans = null;
    }
  }
  compAnswerOf(id) { return this.pAns[id] != null ? this.pAns[id] : this.answer; }
  compDeadline(P) { return this.t.deadline ? this.t.deadline + (P.extra || 0) : 0; }

  compVote(p, o) {
    const s = this.state, g = s.game;
    if (s.phase !== 'voting' || !p.online) return;
    const P = g.comp.p[p.id];
    if (!P || !this.compPlayers().includes(p.id) || P.c) return;
    if (!(Number.isInteger(o) && o >= 0 && o <= 3) || P.removed.includes(o)) return;
    const dl = this.compDeadline(P);
    if (dl && Date.now() > dl) return;
    if (P.o === o) {
      // segundo toque: fija la respuesta
      P.c = true; P.t = Date.now();
      if (P.dbl && o !== this.compAnswerOf(p.id)) {
        // Doble intento: no era esa y puede volver a elegir (los demás no se enteran de cuál es la buena)
        P.dbl = false; P.retry = true; P.removed = [...P.removed, o]; P.o = null; P.c = false; P.t = 0;
        this.event('retry', p.id);
      }
    } else { P.o = o; P.retry = false; }
    this.compCheck();
  }

  compLife(p, role) {
    const s = this.state, g = s.game;
    if (s.phase !== 'voting' || !p.online) return;
    const P = g.comp.p[p.id];
    if (!P || !this.compPlayers().includes(p.id) || P.c || !(role in P.life) || P.life[role]) return;
    const ans = this.compAnswerOf(p.id);
    const q = P.q || g.q;
    switch (role) {
      case 'sabio': {
        const wrong = shuffle([0, 1, 2, 3].filter(i => i !== ans && !P.removed.includes(i)));
        const k = Math.min(2, wrong.length - 1);
        if (k <= 0) return;
        P.removed = [...P.removed, ...wrong.slice(0, k)];
        if (P.removed.includes(P.o)) P.o = null;
        break;
      }
      case 'influencer': P.poll = makePoll(ans, q.d, P.removed); break;
      case 'profesora': P.hint = makeHint(ans, q.d, P.removed); break;
      case 'suertudo': if (P.dbl) return; P.dbl = true; break;
      case 'crono': if (!this.t.deadline) return; P.extra += 30000; break;
      case 'hacker': {
        // pregunta nueva del mismo nivel, solo para este jugador
        const item = this.pickItem(q.d);
        if (!item) return;
        this.used.add(item.id);
        const play = toPlayable(item);
        play.q.d = q.d;
        P.q = play.q; this.pAns[p.id] = play.answer;
        P.o = null; P.removed = []; P.poll = null; P.hint = null; P.retry = false;
        g.asked.push(item.id);
        break;
      }
      default: return;
    }
    P.life[role] = true;
    this.event('life', p.id, { role });
  }

  // ¿Ya respondieron todos (o se les acabó el tiempo)?
  compCheck(now = Date.now()) {
    const s = this.state, g = s.game;
    if (s.phase !== 'voting') return;
    const ids = this.compOnline();
    const done = id => { const P = g.comp.p[id]; const dl = this.compDeadline(P); return P.c || (dl && now >= dl); };
    if (!ids.length || ids.every(done)) this.compLock();
  }

  compLock() {
    const s = this.state;
    this.t.deadline = 0; this.t.finalAt = 0;
    s.phase = 'locked';
    this.t.phaseEnd = Date.now() + 1800;
    this.push();
  }

  compReveal() {
    const s = this.state, g = s.game, C = g.comp;
    const prize = C.sd ? 0 : g.ladder[Math.min(g.n, g.len - 1)];
    const full = (s.settings.time || 0) * 1000;
    for (const id of this.compPlayers()) {
      const P = C.p[id];
      const ans = this.compAnswerOf(id);
      P.ans = ans;
      if (P.o != null && P.o === ans) { P.res = 'ok'; C.score[id] += prize; if (!C.sd) C.correct[id]++; }
      else P.res = P.o == null ? 'timeout' : 'bad';
      const took = P.t ? P.t - (this.t.votingStart || P.t) : full + (P.extra || 0);
      C.timeMs[id] += Math.max(0, took);
    }
    g.answer = this.answer;
    s.phase = 'reveal';
    this.t.phaseEnd = Date.now() + 4200;
    this.push();
  }

  compAfterReveal() {
    const g = this.state.game, C = g.comp;
    if (C.sd) {
      C.sdRound++;
      const winners = C.sd.filter(id => C.p[id].res === 'ok');
      if (winners.length >= 1 && winners.length < C.sd.length) C.sd = winners;
      if (C.sd.length === 1 || C.sdRound >= 6) { this.compOver(); return; } // tras 6 rondas decide el tiempo
      this.nextQuestion(false);
      return;
    }
    g.n++;
    if (g.n < g.len) { this.nextQuestion(false); return; }
    // Fin de la escalera: ¿empate en el primer lugar?
    const top = Math.max(...g.roster.map(r => C.score[r.id] || 0));
    const tied = g.roster.map(r => r.id).filter(id => (C.score[id] || 0) === top);
    if (tied.length > 1) {
      C.sd = tied; C.sdRound = 0;
      this.event('sd', this.meId);
      this.nextQuestion(false);
    } else this.compOver();
  }

  compOver() {
    const s = this.state, g = s.game, C = g.comp;
    const sdAlive = new Set(C.sd || []);
    const rank = g.roster.map(r => ({
      id: r.id, name: r.name, av: r.av, score: C.score[r.id] || 0, correct: C.correct[r.id] || 0,
      timeMs: Math.round(C.timeMs[r.id] || 0), sd: sdAlive.has(r.id),
    }));
    // dinero; en empate, quien sobrevivió a la muerte súbita; luego el más rápido
    rank.sort((a, b) => b.score - a.score || (b.sd - a.sd) || a.timeMs - b.timeMs);
    C.rank = rank;
    g.answer = this.answer;
    g.outcome = { kind: 'comp', prize: rank[0] ? rank[0].score : 0, level: g.n, winner: rank[0] ? rank[0].id : null, sdRounds: C.sdRound };
    s.phase = 'over';
    this.t = { phaseEnd: 0, deadline: 0, finalAt: 0, total: 0, remainAtLock: 0 };
    this.event('over', this.meId);
    this.push();
    try { this.onOver && this.onOver(JSON.parse(JSON.stringify(s))); } catch (e) { console.warn(e); }
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
          if (s.game.comp) { this.compCheck(now); break; }
          if (this.t.finalAt && now >= this.t.finalAt) this.resolve();
          else if (this.t.deadline && now >= this.t.deadline) this.resolve();
          break;
        case 'locked':
          if (now >= this.t.phaseEnd) { if (s.game.comp) this.compReveal(); else this.reveal(); }
          break;
        case 'reveal':
          if (now >= this.t.phaseEnd) { if (s.game.comp) this.compAfterReveal(); else this.afterReveal(); }
          break;
        default: break;
      }
    }
    if (now - this.lastSend > 4000) this.push(); // latido para quien entra tarde o perdió mensajes
  }
}
