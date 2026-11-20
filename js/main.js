// El Gran Millón · interfaz y flujo de la aplicación.
import {
  CATEGORIES, CAT_BY_ID, ROLES, BASE_ROLES, THEMES, AVATAR, HAT_UNLOCKS, REACTIONS, QUICK_PHRASES, MAX_PLAYERS,
  TIME_OPTIONS, DIFFICULTIES, SAFE_MODES, LADDERS, safeLevels, fmtMoney, randomTeamName,
} from './config.js';
import { profile, saveProfile, isThemeUnlocked, isRoleUnlocked, isHatUnlocked, recordGame, getSeen, addSeen, myId } from './storage.js';
import { Bank, parseCustom, CUSTOM_MAX } from './questions.js';
import { Room, newCode, cleanCode, findPublicRooms, LobbyAd, submitFame, fetchFame, fameRank, reportQuestion } from './net.js';
import { Engine, defaultSettings, newRoomState } from './engine.js';
import { Stage } from './scene.js';
import { AvatarStudio } from './avatar.js';
import { audio } from './audio.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LETTERS = ['A', 'B', 'C', 'D'];
const FUN_NAMES = ['Búho Sabio', 'Llama Lista', 'Tucán Veloz', 'Gato Genio', 'Zorro Astuto', 'Panda Pro', 'Coyote Cool', 'Jaguar Joven', 'Delfín Feliz', 'Colibrí Rápido', 'Pulpo Listo', 'Erizo Épico', 'Quetzal Crack', 'Capibara Zen'];
const colorOf = av => AVATAR.colors[(av && av.color) % AVATAR.colors.length] || '#ffffff';

// El nombre es obligatorio y nunca se pone solo: borra los que versiones anteriores asignaban al azar.
if (!profile.nameOk && FUN_NAMES.includes(profile.name)) { profile.name = ''; saveProfile(); }
const me = { id: myId(), name: profile.name, av: { ...profile.avatar } };
const bank = new Bank();
const lobbyAd = new LobbyAd();
let stage = null;
let studio = null;

const S = {
  screen: 'home', room: null, engine: null, state: null, custom: { text: '', list: [] },
  lastEv: 0, recorded: null, overShown: null, seenSentTo: null, hostMissingSince: 0,
  deadline: 0, total: 0, finalAt: 0, lastTick: -1, lastFinal: -1, previewAnim: 'idle', previewUntil: 0,
  lastChat: 0, lastReact: 0, lastSay: 0, chatOpen: false, unlocks: [],
  waitKey: '', waitSince: 0, waitShown: false, waitIds: [],
};

// ====================================================================
// utilidades de interfaz
// ====================================================================
function toast(text, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}
function setLoader(text, soft = false) {
  const l = $('#loader');
  $('#loader-text').textContent = text;
  l.classList.toggle('soft', soft);
  l.classList.remove('hidden', 'fade');
}
function hideLoader() {
  const l = $('#loader');
  l.classList.add('fade');
  setTimeout(() => { if (l.classList.contains('fade')) l.classList.add('hidden'); }, 420);
}
let centerTimer = null;
function centerMsg(big, small = '', cls = '', ms = 1700) {
  const el = $('#center-msg');
  el.className = 'center-msg ' + cls;
  el.innerHTML = `${esc(big)}${small ? `<small>${esc(small)}</small>` : ''}`;
  void el.offsetWidth;
  clearTimeout(centerTimer);
  centerTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
const thumbCache = new Map();
function thumb(av, size = 96) {
  const key = `${av?.color}.${av?.eyes}.${av?.mouth}.${av?.hat}.${size}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  let url = '';
  try { url = studio ? studio.thumb(av, size) : ''; } catch (e) { console.warn(e); }
  if (!url) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d'); g.fillStyle = colorOf(av); g.beginPath(); g.arc(size / 2, size / 2, size / 2.2, 0, Math.PI * 2); g.fill();
    url = c.toDataURL();
  }
  thumbCache.set(key, url);
  return url;
}
const imgThumb = (av, title = '', size = 96, cls = '') => `<img src="${thumb(av, size)}" alt="" title="${esc(title)}" class="${cls}" style="border-color:${colorOf(av)}">`;

function show(screen) {
  S.screen = screen;
  document.body.dataset.screen = screen;
  for (const id of ['home', 'lobby', 'game']) $('#' + id).classList.toggle('hidden', id !== screen);
}

function ensureName() {
  const input = $('#name-input');
  const n = (input.value || '').trim().slice(0, 16);
  if (n.length < 2) {
    if (S.screen !== 'home') goHome();
    input.classList.remove('need'); void input.offsetWidth; input.classList.add('need');
    $('#name-error').classList.remove('hidden');
    input.focus();
    audio.sfx('wrong');
    return false;
  }
  profile.name = n; profile.nameOk = true;
  saveProfile();
  me.name = n;
  me.av = { ...profile.avatar };
  return true;
}

function inviteUrl(code) { return `${location.origin}${location.pathname}?sala=${code}`; }

// ====================================================================
// inicio
// ====================================================================
const AM_ROWS = [
  { key: 'color', label: 'Color', icon: '🎨', names: AVATAR.colorNames },
  { key: 'eyes', label: 'Ojos', icon: '👀', names: AVATAR.eyeNames },
  { key: 'mouth', label: 'Boca', icon: '👄', names: AVATAR.mouthNames },
  { key: 'hat', label: 'Sombrero', icon: '🎩', names: AVATAR.hatNames },
];
const npcs = Array.from({ length: 3 }, (_, i) => ({
  id: 'npc' + i, name: FUN_NAMES[(i * 5 + 3) % FUN_NAMES.length],
  av: { color: (i * 4 + 2) % 12, eyes: (i * 2 + 1) % 6, mouth: i % 6, hat: (i + 1) % 4 },
}));

function initHome() {
  const input = $('#name-input');
  input.value = profile.name || '';
  input.addEventListener('input', () => {
    profile.name = input.value.trim().slice(0, 16);
    if (profile.name.length >= 2) { profile.nameOk = true; input.classList.remove('need'); $('#name-error').classList.add('hidden'); }
    saveProfile(); setHomePlayers();
  });
  const side = d => AM_ROWS.map(r => {
    const lbl = `${r.label} ${d < 0 ? 'anterior' : 'siguiente'}`;
    return `<button type="button" data-key="${r.key}" data-d="${d}" title="${lbl}" aria-label="${lbl}">${d < 0 ? '<b>◀</b>' : ''}<i>${r.icon}</i>${d > 0 ? '<b>▶</b>' : ''}</button>`;
  }).join('');
  $('#am-left').innerHTML = side(-1);
  $('#am-right').innerHTML = side(1);
  $('.avatar-maker').addEventListener('click', e => {
    const b = e.target.closest('button[data-key]');
    if (!b) return;
    const key = b.dataset.key;
    const row = AM_ROWS.find(r => r.key === key);
    const n = row.names.length;
    let v = profile.avatar[key];
    for (let k = 0; k < n; k++) {
      v = (v + Number(b.dataset.d) + n) % n;
      if (key !== 'hat' || isHatUnlocked(v)) break;
    }
    profile.avatar[key] = v;
    saveProfile();
    audio.sfx('click');
    syncAvatarLabels(key);
    setHomePlayers();
    S.previewAnim = 'happy'; S.previewUntil = performance.now() + 900;
  });
  $('#avatar-random').addEventListener('click', () => {
    const r = n => Math.floor(Math.random() * n);
    const hats = AVATAR.hats.map((_, i) => i).filter(i => isHatUnlocked(i));
    profile.avatar = { color: r(12), eyes: r(6), mouth: r(6), hat: hats[r(hats.length)] };
    saveProfile(); syncAvatarLabels(); setHomePlayers();
    audio.sfx('react');
    S.previewAnim = 'dance'; S.previewUntil = performance.now() + 1400;
  });
  $('#avatar-preview').addEventListener('click', () => { S.previewAnim = 'happy'; S.previewUntil = performance.now() + 1300; audio.sfx('react'); });
  syncAvatarLabels();

  $('#btn-play').addEventListener('click', () => {
    const code = $('#btn-play').dataset.code;
    if (code) enterRoom(code, 'join'); else quickPlay();
  });
  $('#btn-create').addEventListener('click', () => enterRoom(newCode(), 'create', { pub: false }));
  $('#join-form').addEventListener('submit', e => {
    e.preventDefault();
    const code = cleanCode($('#code-input').value);
    if (code.length !== 5) { toast('El código de sala tiene 5 caracteres.'); return; }
    enterRoom(code, 'join');
  });
  $('#code-input').addEventListener('input', e => { e.target.value = cleanCode(e.target.value); });

  const canvas = $('#avatar-preview');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const fit = () => { const w = canvas.clientWidth || 170; canvas.width = Math.round(w * dpr); canvas.height = Math.round(w * dpr); };
  fit();
  window.addEventListener('resize', fit);
  const loop = (t) => {
    if (S.screen === 'home' && studio) {
      if (S.previewUntil && t > S.previewUntil) { S.previewAnim = 'idle'; S.previewUntil = 0; }
      try { studio.preview(profile.avatar, canvas, t / 1000, S.previewAnim); } catch (e) { /* ignore */ }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function syncAvatarLabels(key) {
  const row = AM_ROWS.find(r => r.key === key);
  $('#am-caption').textContent = row ? `${row.icon} ${row.label}: ${row.names[profile.avatar[key] % row.names.length]}` : 'Usa las flechas para personalizar';
}

function setHomePlayers() {
  if (!stage || S.screen !== 'home') return;
  const list = [npcs[0], { id: 'me', name: profile.name || 'Tú', av: profile.avatar }, npcs[1], npcs[2]];
  stage.setPlayers(list);
  stage.setAnim('npc0', 'dance'); stage.setAnim('npc1', 'wave'); stage.setAnim('npc2', 'idle'); stage.setAnim('me', 'happy');
}

function goHome() {
  show('home');
  document.body.dataset.theme = isThemeUnlocked(profile.theme) ? profile.theme : 'gala';
  if (stage) {
    stage.setTheme(document.body.dataset.theme);
    stage.setMode('home');
    stage.hideConfetti();
    stage.setScreen({ top: '¡Bienvenidos a', big: 'EL GRAN MILLÓN', bottom: 'Preguntas en equipo' });
    setHomePlayers();
  }
  audio.setMusic('home');
  updateFraming();
  const sala = cleanCode(new URLSearchParams(location.search).get('sala'));
  const banner = $('#invite-banner');
  if (sala.length === 5) {
    banner.textContent = `🎟️ Te invitaron a la sala ${sala}`;
    banner.classList.remove('hidden');
    $('#btn-play').textContent = 'Entrar a la sala';
    $('#btn-play').dataset.code = sala;
  } else {
    banner.classList.add('hidden');
    $('#btn-play').textContent = '¡Jugar!';
    delete $('#btn-play').dataset.code;
  }
}

// ====================================================================
// salas
// ====================================================================
async function quickPlay() {
  if (!ensureName()) return;
  audio.unlock();
  setLoader('Buscando una sala abierta…', true);
  let rooms = [];
  try { rooms = await findPublicRooms(); } catch { rooms = []; }
  const open = rooms.filter(r => r.code && (r.n || 0) < MAX_PLAYERS)
    .sort((a, b) => (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1) || (b.n || 0) - (a.n || 0));
  if (open.length) {
    const ok = await enterRoom(open[0].code, 'join', { quick: true });
    if (ok) return;
  }
  await enterRoom(newCode(), 'create', { pub: true });
  toast('Creamos una sala pública: entrará gente en cuanto alguien pulse «¡Jugar!». También puedes invitar con el link.', 5200);
}

async function enterRoom(code, intent, opts = {}) {
  if (!ensureName()) return false;
  if (S.room) await leaveRoom(true);
  audio.unlock();
  setLoader(intent === 'create' ? 'Preparando el estudio…' : 'Entrando a la sala…', true);
  const room = new Room(code, me, {
    onMembers: list => onMembers(room, list),
    onMessage: (ev, p, from) => onMessage(room, ev, p, from),
  });
  Object.assign(S, {
    room, state: null, engine: null, custom: { text: '', list: [] }, lastEv: 0, recorded: null, overShown: null,
    seenSentTo: null, hostMissingSince: 0, unlocks: [], settingsBuilt: null,
  });
  clearChat();
  try {
    await room.connect();
  } catch (e) {
    console.warn(e);
    hideLoader();
    await leaveRoom(true);
    toast('No pudimos conectar con el servidor. Revisa tu internet e inténtalo de nuevo.', 4500);
    return false;
  }
  if (S.room !== room) return false;
  if (intent === 'create') {
    const theme = isThemeUnlocked(profile.theme) ? profile.theme : 'gala';
    becomeHost(newRoomState(me.id, { ...defaultSettings(), pub: !!opts.pub, theme, team: randomTeamName() }));
  } else {
    const ok = await waitForState(room, 5500);
    if (!ok) {
      hideLoader();
      await leaveRoom(true);
      if (!opts.quick) toast(`No encontramos la sala ${code}. Revisa el código o crea una nueva.`, 4500);
      return false;
    }
  }
  hideLoader();
  try { history.replaceState(null, '', `?sala=${code}`); } catch { /* ignore */ }
  addSys(`Entraste a la sala ${code}. ¡Invita a tus amigos con el link!`);
  return true;
}

function waitForState(room, ms) {
  return new Promise(res => {
    const t0 = Date.now();
    let lastHello = 0;
    const iv = setInterval(() => {
      if (S.room !== room) { clearInterval(iv); res(false); return; }
      if (S.state) { clearInterval(iv); res(true); return; }
      const now = Date.now();
      if (now - t0 > ms) { clearInterval(iv); res(false); return; }
      if (now - lastHello > 1500) { lastHello = now; room.send('hello', {}); }
    }, 100);
  });
}

async function leaveRoom(silent = false) {
  const room = S.room;
  S.room = null;
  if (S.engine) { S.engine.destroy(); S.engine = null; }
  lobbyAd.stop();
  S.state = null;
  closeModal();
  $('#over').classList.add('hidden');
  if (room) await room.leave();
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  if (!silent) goHome();
}

function membersWithMe(list) {
  return list.some(m => m.id === me.id) ? list : [...list, { id: me.id, name: me.name, av: me.av, joinedAt: S.room ? S.room.joinedAt : Date.now() }];
}

function becomeHost(st) {
  S.engine = new Engine({
    bank, meId: me.id,
    send: (ev, p) => { if (S.room) S.room.send(ev, p); },
    onLocal: st2 => applyState(st2),
    onOver: hostOver,
  });
  S.engine.custom = S.custom;
  S.engine.init(st);
  S.engine.setCustom(S.custom);
  S.engine.syncMembers(membersWithMe(S.room.members));
  S.engine.act(me.id, { t: 'seen', ids: getSeen() });
  if (S.custom.list.length) S.room.send('custom', S.custom);
}

function onMembers(room, list) {
  if (room !== S.room) return;
  if (S.engine) S.engine.syncMembers(membersWithMe(list));
  else if (S.state) checkHost();
}

function checkHost() {
  if (!S.room || !S.state || S.engine) return;
  const list = S.room.members;
  if (list.some(m => m.id === S.state.hostId)) { S.hostMissingSince = 0; return; }
  const now = Date.now();
  if (!S.hostMissingSince) { S.hostMissingSince = now; setTimeout(checkHost, 1700); return; }
  if (now - S.hostMissingSince < 1500) { setTimeout(checkHost, 600); return; }
  const players = new Set(S.state.players.map(p => p.id));
  const cands = membersWithMe(list).filter(m => players.has(m.id)).sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
  const pick = cands[0];
  if (pick && pick.id === me.id) {
    addSys('El anfitrión se fue: ahora tú diriges la sala. 👑');
    S.hostMissingSince = 0;
    becomeHost(JSON.parse(JSON.stringify(S.state)));
  } else setTimeout(checkHost, 2000);
}

function onMessage(room, ev, p, from) {
  if (room !== S.room) return;
  switch (ev) {
    case 'hello':
      if (S.engine) { S.engine.push(); if (S.custom.list.length) room.send('custom', S.custom); }
      break;
    case 'state': {
      delete p._from;
      if (S.engine) {
        if (p.hostId === me.id) return;
        const other = room.members.find(m => m.id === p.hostId);
        if (other && (other.joinedAt < room.joinedAt || (other.joinedAt === room.joinedAt && other.id < me.id))) {
          S.engine.destroy(); S.engine = null; lobbyAd.stop();
          applyState(p);
        }
        return;
      }
      if (p.hostId !== from) return;
      applyState(p);
      break;
    }
    case 'custom':
      S.custom = { text: String(p.text || '').slice(0, 30000), list: Array.isArray(p.list) ? p.list.slice(0, CUSTOM_MAX) : [] };
      if (S.engine) S.engine.setCustom(S.custom);
      break;
    case 'act':
      if (S.engine) { delete p._from; S.engine.act(from, p); }
      break;
    case 'chat':
      addChat(p);
      audio.sfx('chat');
      break;
    case 'react':
      if (REACTIONS.includes(p.e) && stage) { stage.react(from, p.e); audio.sfx('react'); }
      break;
    case 'say': {
      const text = QUICK_PHRASES[p.k | 0];
      const who = S.state && S.state.players.find(x => x.id === from);
      if (!text || !who) break;
      showSay(who, text);
      break;
    }
    case 'kick':
      if (p.id === me.id) {
        leaveRoom(false);
        toast(p.reason === 'full' ? 'La sala está llena (máximo 4 jugadores).' : 'El anfitrión te sacó de la sala.', 4500);
      }
      break;
    default: break;
  }
}

function act(a) {
  if (!S.room) return;
  if (S.engine) {
    const err = S.engine.act(me.id, a);
    if (err) toast(err, 4200);
  } else S.room.send('act', a);
}

function updateLobbyAd(st) {
  if (!S.engine || !st.settings.pub) { lobbyAd.stop(); return; }
  lobbyAd.set({
    code: S.room.code, n: st.players.filter(p => p.online).length,
    phase: st.phase === 'lobby' ? 'lobby' : 'playing', theme: st.settings.theme,
  }).catch(() => {});
}

// ====================================================================
// estado → pantalla
// ====================================================================
function applyState(st) {
  if (!S.room) return;
  const prev = S.state;
  S.state = st;
  const now = performance.now();
  const g = st.game;
  const tm = g && g.timer;
  S.deadline = tm && tm.left != null && st.phase === 'voting' ? now + tm.left : 0;
  S.total = tm && tm.total ? tm.total : 0;
  S.finalAt = tm && tm.final != null && st.phase === 'voting' ? now + tm.final : 0;
  const myComp = g && g.comp && g.comp.p[me.id];
  if (myComp && myComp.extra && S.deadline) { S.deadline += myComp.extra; S.total += myComp.extra; }
  if (!S.engine && S.seenSentTo !== st.hostId) { S.seenSentTo = st.hostId; act({ t: 'seen', ids: getSeen() }); }

  const theme = THEMES[st.settings.theme] ? st.settings.theme : 'gala';
  document.body.dataset.theme = theme;
  if (stage) {
    stage.setTheme(theme);
    stage.setPlayers(st.players.filter(p => p.online).slice(0, MAX_PLAYERS));
  }
  if (st.phase === 'lobby') {
    if (S.screen !== 'lobby') showLobby();
    renderLobby(st);
  } else {
    if (S.screen !== 'game') showGame();
    renderGame(st, prev);
  }
  processEvents(st, prev);
  updateLobbyAd(st);
}

function processEvents(st, prev) {
  const evs = st.evs || [];
  if (!prev) { S.lastEv = Math.max(0, ...evs.map(e => e.seq)); }
  else {
    for (const e of evs) {
      if (e.seq <= S.lastEv) continue;
      S.lastEv = e.seq;
      const who = st.players.find(p => p.id === e.by);
      const name = who ? who.name : 'Alguien';
      if (e.kind === 'join' && e.by !== me.id) {
        addSys(`${name} se unió a la sala.`);
        audio.sfx('join');
        if (stage) { stage.setAnim(e.by, 'wave'); setTimeout(() => stage && stage.setAnim(e.by, 'idle'), 2200); }
      } else if (e.kind === 'life' && ROLES[e.role] && st.game && st.game.comp && e.by !== me.id) {
        addSys(`${name} usó ${ROLES[e.role].icon} ${ROLES[e.role].power}.`);
      } else if (e.kind === 'retry') {
        if (e.by === me.id) { audio.sfx('wrong'); centerMsg('¡Uy, no era esa!', '🍀 Doble intento: elige otra', 'bad', 2000); }
      } else if (e.kind === 'sd') {
        const C = st.game && st.game.comp;
        const names = C && C.sd ? C.sd.map(id => (st.players.find(p => p.id === id) || {}).name || '?').join(' vs ') : '';
        audio.sfx('final');
        centerMsg('⚔️ ¡Empate!', `Muerte súbita: ${names}`, '', 2600);
        addSys(`⚔️ Muerte súbita: ${names}. Gana quien acierte cuando el otro falle.`);
      } else if (e.kind === 'life' && ROLES[e.role]) {
        const R = ROLES[e.role];
        addSys(`${name} usó ${R.icon} ${R.power}.`);
        audio.sfx({ influencer: 'poll', hacker: 'swap' }[e.role] || 'lifeline');
        centerMsg(`${R.icon} ${R.power}`, `${name} · ${R.name}`, '', 1500);
        if (stage) stage.setAnim(e.by, 'happy');
      } else if (e.kind === 'start') {
        audio.sfx('start');
      }
    }
  }
  // Avisos de salida
  if (prev) {
    for (const p of prev.players) {
      const now = st.players.find(x => x.id === p.id);
      if (p.online && (!now || !now.online)) { addSys(`${p.name} salió.`); audio.sfx('leave'); }
    }
  }
}

// ====================================================================
// sala de espera
// ====================================================================
function showLobby() {
  show('lobby');
  $('#chat-slot-lobby').appendChild($('#chat'));
  $('#over').classList.add('hidden');
  document.body.dataset.phase = '';
  $('.lobby-settings').classList.remove('open');
  if (stage) { stage.clearPodium?.(); stage.setMode('lobby'); stage.setAllAnim('idle'); stage.setMood('idle'); stage.setScreen({ top: 'Sala ' + S.room.code, big: 'EL GRAN MILLÓN', bottom: 'Esperando al equipo…' }); }
  audio.setMusic('lobby');
  S.settingsBuilt = null;
  updateFraming();
}

function renderLobby(st) {
  const isHost = st.hostId === me.id;
  const online = st.players.filter(p => p.online);
  $('#room-code').textContent = S.room.code;
  $('#lobby-count').textContent = `${online.length}/${MAX_PLAYERS}`;
  $('#room-vis').textContent = st.settings.pub ? '🌎 Pública' : '🔒 Privada';
  $('#host-note').textContent = isHost ? '👑 Tú eliges los ajustes' : 'El anfitrión elige los ajustes';
  const slots = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = online[i];
    if (!p) { slots.push(`<li class="player empty"><span class="thumb">➕</span><span class="p-info"><span class="p-name">Lugar libre</span></span></li>`); continue; }
    const R = p.role ? ROLES[p.role] : null;
    slots.push(`<li class="player ${p.id === me.id ? 'me' : ''}">
      ${imgThumb(p.av, p.name)}
      <div class="p-info"><div class="p-name">${esc(p.name)}${p.id === st.hostId ? ' <span class="crown" title="Anfitrión">👑</span>' : ''}</div>
      <div class="p-role">${R ? `${R.icon} ${R.power}` : 'Eligiendo rol…'}</div></div>
      ${isHost && p.id !== me.id ? `<button class="kick" data-kick="${esc(p.id)}" title="Sacar de la sala" aria-label="Sacar a ${esc(p.name)}">✖</button>` : ''}
    </li>`);
  }
  $('#lobby-list').innerHTML = slots.join('');
  renderSettings(st, isHost);
  renderRoles(st);
  $('#btn-start').classList.toggle('hidden', !isHost);
  $('#wait-host').classList.toggle('hidden', isHost);
  $('#btn-start').disabled = !bank.loaded && st.settings.customMode !== 'only';
  if (stage) stage.setScreen({ top: 'Sala ' + S.room.code, big: 'EL GRAN MILLÓN', bottom: `${online.length} de ${MAX_PLAYERS} jugadores` });
}

function settingsSummary(s) {
  const t = THEMES[s.theme] || THEMES.gala;
  const cats = s.cats.length === CATEGORIES.length ? 'Todos los temas' : `${s.cats.length} temas`;
  return `${s.mode === 'comp' ? '⚔️ Competitivo' : '🤝 Cooperativo'} · ${s.len} preguntas · ${s.time ? s.time + ' s' : 'sin límite'} · ${(DIFFICULTIES.find(d => d.id === s.diff) || {}).name} · ${cats} · ${t.icon}`;
}

function renderSettings(st, isHost) {
  const form = $('#settings-form');
  const key = isHost ? 'host' : 'guest';
  if (S.settingsBuilt !== key) {
    S.settingsBuilt = key;
    const seg = (k, opts) => `<div class="seg" data-key="${k}">${opts.map(([v, l, tip]) => `<button type="button" data-v="${v}" ${tip ? `title="${esc(tip)}"` : ''}>${l}</button>`).join('')}</div>`;
    form.innerHTML = `
      <div class="field wide"><label for="f-team">Equipo</label>
        <div class="f-row"><input id="f-team" class="input" maxlength="28" autocomplete="off">${isHost ? '<button type="button" class="icon-btn" id="f-team-dice" title="Otro nombre al azar" aria-label="Otro nombre al azar">🎲</button>' : ''}</div></div>
      <div class="field wide"><span class="f-label">Modo</span>${seg('mode', [['coop', '🤝 Cooperativo', 'Votan juntos y suben la escalera en equipo'], ['comp', '⚔️ Competitivo', 'Cada quien responde por su lado y gana quien junte más']])}<small class="muted f-info" id="f-mode-info"></small></div>
      <div class="field"><span class="f-label">Preguntas</span>${seg('len', [[10, '10'], [15, '15'], [20, '20']])}</div>
      <div class="field"><span class="f-label">Tiempo</span>${seg('time', TIME_OPTIONS.map(t => [t, t ? `${t}s` : '∞', t ? `${t} segundos por pregunta` : 'Sin límite de tiempo']))}</div>
      <div class="field"><span class="f-label">Dificultad</span>${seg('diff', DIFFICULTIES.map(d => [d.id, d.name]))}</div>
      <div class="field" id="f-safe-field"><span class="f-label">Puntos seguros</span>${seg('safe', [['clasico', '2 🛡️', 'Dos puntos seguros'], ['uno', '1 🛡️', 'Un punto seguro'], ['ninguno', 'Ninguno', 'Todo o nada']])}</div>
      <div class="field"><span class="f-label">Temas</span><button type="button" class="btn btn-small pick-btn" id="f-cats-btn"></button></div>
      <div class="field"><span class="f-label">Estilo</span><div class="theme-dots" id="f-themes"></div></div>
      <div class="field"><span class="f-label">Sala</span>${seg('pub', [['false', '🔒 Privada', 'Solo entra quien tenga el link'], ['true', '🌎 Pública', 'Cualquiera puede entrar con «¡Jugar!»']])}</div>
      <div class="field"><span class="f-label">Preguntas propias</span><button type="button" class="btn btn-small pick-btn" id="f-custom"></button></div>`;
  }
  const s = st.settings;
  $('#settings-summary').textContent = settingsSummary(s) + '  ▾';
  for (const segEl of $$('.seg', form)) {
    const k = segEl.dataset.key;
    for (const b of $$('button', segEl)) {
      b.classList.toggle('on', String(s[k]) === b.dataset.v);
      b.disabled = !isHost;
    }
  }
  const comp = s.mode === 'comp';
  $('#f-safe-field').classList.toggle('hidden', comp);
  $('#f-mode-info').textContent = comp
    ? 'Cada quien responde por su lado: cada acierto paga su escalón y gana quien junte más. Empate: muerte súbita. Mínimo 2.'
    : 'Votan juntos la misma respuesta y suben la escalera en equipo.';
  const team = $('#f-team');
  if (document.activeElement !== team) team.value = s.team;
  team.disabled = !isHost;
  const nCats = s.cats.length;
  $('#f-cats-btn').textContent = nCats === CATEGORIES.length ? '🗂️ Todos (12)' : nCats ? `🗂️ ${nCats} de ${CATEGORIES.length}` : '⚠️ Ninguno';
  $('#f-custom').textContent = s.customCount ? `✏️ ${s.customCount} · ${{ off: 'sin usar', mix: 'mezcladas', only: 'solo propias' }[s.customMode]}` : (isHost ? '✏️ Escribir' : '✏️ Ninguna');
  $('#f-custom').disabled = !isHost;
  $('#f-themes').innerHTML = Object.entries(THEMES).map(([id, t]) => {
    const locked = isHost ? !isThemeUnlocked(id) : false;
    const on = s.theme === id;
    const tip = locked ? `${t.name} · 🔒 ${t.unlock.text}` : `${t.name}: ${t.desc}`;
    return `<button type="button" class="theme-dot ${on ? 'on' : ''} ${locked ? 'locked' : ''}" data-theme="${id}" ${!isHost || locked ? 'disabled' : ''} title="${esc(tip)}" aria-label="${esc(tip)}">${t.icon}</button>`;
  }).join('');
}

const amHost = () => !!(S.state && S.state.hostId === me.id);
function bindSettings(form) {
  form.addEventListener('click', e => {
    if (e.target.closest('#f-cats-btn')) { openCatsModal(); return; }
    if (!amHost()) return;
    const segBtn = e.target.closest('.seg button');
    if (segBtn && !segBtn.disabled) {
      const k = segBtn.closest('.seg').dataset.key;
      let v = segBtn.dataset.v;
      if (k === 'len' || k === 'time') v = Number(v);
      if (k === 'pub') v = v === 'true';
      act({ t: 'settings', patch: { [k]: v } });
      audio.sfx('click');
      return;
    }
    if (e.target.closest('#f-team-dice')) { act({ t: 'settings', patch: { team: randomTeamName() } }); audio.sfx('react'); return; }
    const th = e.target.closest('.theme-dot');
    if (th && !th.disabled) { act({ t: 'settings', patch: { theme: th.dataset.theme } }); profile.theme = th.dataset.theme; saveProfile(); audio.sfx('whoosh'); return; }
    if (e.target.closest('#f-custom')) openCustomModal();
  });
  let tmr = null;
  form.addEventListener('input', e => {
    if (e.target.id !== 'f-team' || !amHost()) return;
    clearTimeout(tmr);
    tmr = setTimeout(() => act({ t: 'settings', patch: { team: e.target.value.trim() } }), 350);
  });
  $('#settings-summary').addEventListener('click', () => {
    const box = $('.lobby-settings');
    box.classList.toggle('open');
    $('#settings-summary').setAttribute('aria-expanded', String(box.classList.contains('open')));
  });
}

function openCatsModal() {
  const host = amHost();
  const cur = new Set(S.state ? S.state.settings.cats : []);
  const paint = box => $$('.chip', box).forEach(c => c.classList.toggle('on', cur.has(c.dataset.cat)));
  openModal(`<h2>🗂️ Temas de las preguntas</h2>
    ${host ? '<div class="chip-tools"><button type="button" data-all="1">Todos</button><button type="button" data-all="0">Ninguno</button></div>' : '<p class="muted">El anfitrión elige los temas.</p>'}
    <div class="chips cats-grid">${CATEGORIES.map(c => `<button type="button" class="chip" data-cat="${c.id}" ${host ? '' : 'disabled'}>${c.icon} ${c.name}${bank.loaded ? ` <small>${bank.countFor([c.id])}</small>` : ''}</button>`).join('')}</div>
    <div class="over-actions"><button class="btn btn-go" id="cats-ok">Listo</button></div>`, box => {
    paint(box);
    box.addEventListener('click', e => {
      if (e.target.closest('#cats-ok')) { closeModal(); return; }
      if (!host) return;
      const all = e.target.closest('[data-all]');
      const chip = e.target.closest('.chip');
      if (all) { cur.clear(); if (all.dataset.all === '1') CATEGORIES.forEach(c => cur.add(c.id)); }
      else if (chip) { if (cur.has(chip.dataset.cat)) cur.delete(chip.dataset.cat); else cur.add(chip.dataset.cat); }
      else return;
      paint(box);
      audio.sfx('click');
      act({ t: 'settings', patch: { cats: CATEGORIES.map(c => c.id).filter(id => cur.has(id)) } });
    });
  });
}

function renderRoles(st) {
  const meP = st.players.find(p => p.id === me.id) || {};
  const myRole = meP.role;
  const ids = Object.keys(ROLES).filter(id => BASE_ROLES.includes(id) || isRoleUnlocked(id) || st.players.some(p => p.role === id && p.online));
  $('#role-picker').innerHTML = ids.map(id => {
    const R = ROLES[id];
    const owner = st.players.find(p => p.role === id && p.online);
    const mine = owner && owner.id === me.id;
    const taken = owner && !mine;
    const tip = `${R.name} · ${R.power}: ${R.desc}${taken ? ` (lo eligió ${owner.name})` : ''}`;
    return `<button type="button" class="role ${mine ? 'mine' : ''} ${taken ? 'taken' : ''}" data-role="${id}" ${taken ? 'disabled' : ''} title="${esc(tip)}" aria-label="${esc(tip)}">
      <span class="ri">${R.icon}</span><b>${R.power}</b><small>${R.name}</small>
      ${owner ? `<img class="owner" src="${thumb(owner.av, 64)}" alt="">` : ''}
    </button>`;
  }).join('');
  const R = myRole && ROLES[myRole];
  $('#role-hint').innerHTML = R
    ? `${R.icon} <b>${esc(R.name)}</b>: ${esc(R.desc)} Solo tú puedes usarlo, una vez.`
    : 'Elige un rol: su comodín será solo tuyo. Si no eliges, te toca uno al azar.';
}

// ====================================================================
// partida
// ====================================================================
function showGame() {
  show('game');
  $('#chat-slot-game').appendChild($('#chat'));
  $('#game-room').textContent = 'Sala ' + S.room.code;
  if (stage) stage.setMode('game');
  updateFraming();
  setTimeout(updateFraming, 60);
}

// En competitivo cada quien ve su propia pregunta, sus comodines y su respuesta: se arma una vista
// del estado con esos datos para reutilizar las mismas funciones de dibujo que el modo cooperativo.
function viewOf(st) {
  const g = st && st.game;
  if (!g || !g.comp) return st;
  const C = g.comp, P = C.p[me.id];
  const v = { ...g, safe: [], life: {}, sharedQ: g.q, me: P || null, playing: !!P && (!C.sd || C.sd.includes(me.id)) };
  if (P) {
    v.q = P.q || g.q;
    v.removed = P.removed; v.poll = P.poll; v.hint = P.hint; v.dbl = P.dbl;
    v.votes = P.o != null ? { [me.id]: { o: P.o, c: P.c } } : {};
    v.picked = P.o; v.result = P.res;
    v.answer = P.ans != null ? P.ans : g.answer;
  } else { v.votes = {}; v.picked = null; v.result = null; v.removed = []; v.poll = null; v.hint = null; v.dbl = false; }
  return { ...st, game: v };
}
function compPlace(g, id) {
  const C = g.comp;
  const sorted = g.roster.map(r => C.score[r.id] || 0).sort((a, b) => b - a);
  return sorted.indexOf(C.score[id] || 0) + 1;
}

function renderGame(st, prev) {
  st = viewOf(st); prev = prev && viewOf(prev);
  const g = st.game;
  if (!g) return;
  const pg = prev && prev.game;
  const newGame = !pg || pg.id !== g.id;
  const qChanged = newGame || !pg.q || !g.q || pg.q.id !== g.q.id;
  const phaseChanged = !prev || prev.phase !== st.phase || newGame;
  if (newGame) { $('#over').classList.add('hidden'); S.overShown = null; if (stage) { stage.hideConfetti(); stage.clearPodium?.(); } }
  document.body.dataset.phase = st.phase;

  const shownLevel = Math.min(g.n, g.len - 1);
  if (g.comp && st.phase === 'over') $('#level-pill').innerHTML = '🏁 <b>Fin de la partida</b>' + (g.me ? ` · Tú <b>${fmtMoney(g.comp.score[me.id] || 0)}</b>` : '');
  else if (g.comp && g.comp.sd) $('#level-pill').innerHTML = `⚔️ <b>Muerte súbita</b> · ronda ${g.comp.sdRound + 1}`;
  else $('#level-pill').innerHTML = `<span class="lp-word">Pregunta </span><b>${Math.min(g.n + 1, g.len)}</b>/${g.len} · <b>${fmtMoney(g.ladder[shownLevel])}</b>` + (g.comp && g.me ? ` · Tú <b>${fmtMoney(g.comp.score[me.id] || 0)}</b> (${compPlace(g, me.id)}.º)` : '');
  renderLadder(st);
  renderLifelines(st);
  renderQuestion(st, qChanged);
  renderVotes(st);
  renderStatus(st);
  if (stage) {
    stage.setLadder(g.len, g.n, g.safe);
    if (qChanged || phaseChanged) {
      const cat = g.q ? (CAT_BY_ID[g.q.cat] || { name: 'Personalizada', icon: '✏️' }) : null;
      stage.setScreen({ top: `PREGUNTA ${Math.min(g.n + 1, g.len)} DE ${g.len}`, big: fmtMoney(g.ladder[shownLevel]), bottom: cat ? `${cat.name}` : '' });
    }
  }
  if (phaseChanged || qChanged) onPhase(st, prev, qChanged);
  if (st.phase === 'over') renderOver(st);
  updateFraming();
}

function onPhase(st, prev, qChanged) {
  const g = st.game;
  const ph = st.phase;
  if (!stage) return;
  const online = st.players.filter(p => p.online);
  if (ph === 'intro') {
    if (qChanged) {
      audio.sfx('whoosh');
      if (g.comp && g.comp.sd) centerMsg('⚔️ Muerte súbita', `Ronda ${g.comp.sdRound + 1}`, '', 1500);
      else centerMsg(`Pregunta ${g.n + 1}`, `por ${fmtMoney(g.ladder[Math.min(g.n, g.len - 1)])}`, '', 1500);
    }
    audio.setMusic('think', g.n / Math.max(1, g.len - 1));
    stage.cameraShot('wide'); stage.setMood('idle');
    online.forEach(p => stage.setAnim(p.id, 'think'));
  } else if (ph === 'voting') {
    audio.setMusic('think', g.n / Math.max(1, g.len - 1));
    stage.cameraShot('wide'); stage.setMood('idle');
    if (S.tipShown !== g.id && (g.n === 0 || !S.tipShown)) {
      S.tipShown = g.id;
      centerMsg('👆 Toca dos veces', 'Un toque elige la respuesta y el segundo la confirma', '', 3400);
    }
  } else if (ph === 'locked') {
    audio.sfx('lock'); audio.setMusic('tension');
    stage.cameraShot('lock'); stage.setMood('tense');
    online.forEach(p => stage.setAnim(p.id, 'think'));
  } else if (ph === 'reveal' && g.comp) {
    stage.cameraShot('reveal');
    const P = g.me;
    const prize = g.ladder[Math.min(g.n, g.len - 1)];
    if (!P || !g.playing) {
      centerMsg('Respuesta', g.answer != null && g.q ? `Era la ${LETTERS[g.answer]}: ${g.q.opts[g.answer]}` : '', '', 2200);
    } else if (P.res === 'ok') {
      audio.sfx('correct'); audio.sfx('coin');
      stage.confetti(0.6); stage.setMood('cheer');
      centerMsg('¡Correcto!', g.comp.sd ? 'Sigues vivo en la muerte súbita' : `+${fmtMoney(prize)}`, 'good', 2400);
    } else {
      audio.sfx('wrong'); stage.shake(0.35); stage.setMood('tense');
      centerMsg(P.res === 'timeout' ? '⏰ ¡Sin tiempo!' : 'Incorrecto', g.q && g.answer != null ? `Era la ${LETTERS[g.answer]}: ${g.q.opts[g.answer]}` : '', 'bad', 2800);
    }
  } else if (ph === 'reveal') {
    stage.cameraShot('reveal');
    if (g.result === 'ok') {
      audio.sfx('correct'); audio.sfx('coin');
      stage.confetti(); stage.setMood('cheer'); stage.setAllAnim('happy');
      const safe = g.safe.includes(g.n);
      centerMsg('¡Correcto!', safe ? `🛡️ ¡Punto seguro! ${fmtMoney(g.ladder[g.n])} asegurados` : `Suben a ${fmtMoney(g.ladder[g.n])}`, 'good', 2600);
    } else if (g.result === 'retry') {
      audio.sfx('wrong');
      stage.shake(0.25); stage.setMood('tense');
      centerMsg('¡Uy, no era esa!', '🍀 El Suertudo les da otra oportunidad', 'bad', 2400);
    } else {
      audio.sfx('wrong');
      stage.shake(0.5); stage.setMood('sad'); stage.setAllAnim('sad');
      centerMsg(g.result === 'timeout' ? '⏰ ¡Se acabó el tiempo!' : 'Incorrecto', `Era la ${LETTERS[g.answer]}: ${g.q.opts[g.answer]}`, 'bad', 3200);
    }
  } else if (ph === 'over') {
    const kind = g.outcome && g.outcome.kind;
    const onlineIds = new Set(online.map(p => p.id));
    const ps = g.ps || {};
    const ranked = (g.comp && g.comp.rank ? g.comp.rank.map(r => r.id) : [...g.roster].sort((a, b) => ((ps[b.id] || {}).ok || 0) - ((ps[a.id] || {}).ok || 0)).map(r => r.id))
      .filter(id => onlineIds.has(id));
    if (stage.showPodium) { stage.showPodium(ranked); stage.cameraShot('podium'); } else stage.cameraShot('over');
    if (kind === 'comp') {
      const iWon = g.outcome.winner === me.id;
      audio.sfx(iWon ? 'win' : 'walk'); audio.setMusic(iWon ? 'win' : 'lobby');
      stage.fireworks(iWon ? 10 : 4); stage.confetti(iWon ? 1.4 : 0.6); stage.setMood('cheer');
      online.forEach(p => stage.setAnim(p.id, p.id === g.outcome.winner ? 'dance' : 'wave'));
    } else if (kind === 'win') {
      audio.sfx('win'); audio.setMusic('win');
      stage.fireworks(10); stage.confetti(1.4); stage.setMood('cheer'); stage.setAllAnim('dance');
    } else if (kind === 'walk') {
      audio.sfx('walk'); audio.setMusic('lobby');
      stage.setMood('idle'); stage.setAllAnim('wave');
      if (g.outcome.prize > 0) stage.confetti(0.6);
    } else {
      audio.setMusic('lose'); stage.setMood('sad');
    }
  }
}

function renderLadder(st) {
  const g = st.game;
  const html = g.ladder.map((amt, i) => {
    const cls = ['rung'];
    if (g.safe.includes(i)) cls.push('safe');
    if (i < g.n) cls.push('done');
    if (i === g.n && st.phase !== 'over') cls.push('cur');
    if (i === g.len - 1) cls.push('top');
    return `<div class="${cls.join(' ')}"><span class="rn">${i + 1}</span><span class="ra">${amt.toLocaleString('es-MX')}</span></div>`;
  }).join('');
  let board = '';
  if (g.comp) {
    const C = g.comp;
    const rows = g.roster.map(r => ({ ...r, score: C.score[r.id] || 0 })).sort((a, b) => b.score - a.score);
    board = `<div class="scoreboard"><div class="sb-title">${C.sd ? '⚔️ Muerte súbita' : 'Marcador'}</div>${rows.map((r, i) => `<div class="sb-row ${r.id === me.id ? 'me' : ''} ${C.sd && C.sd.includes(r.id) ? 'sd' : ''}"><span class="sb-pos">${i + 1}</span>${imgThumb(r.av, r.name, 48)}<span class="sb-name">${esc(r.name)}</span><span class="sb-money">${fmtMoney(r.score)}</span></div>`).join('')}</div>`;
  }
  const full = html + board;
  const el = $('#ladder');
  if (el.dataset.html !== full) { el.innerHTML = full; el.dataset.html = full; const cur = $('.rung.cur', el); if (cur) cur.scrollIntoView({ block: 'nearest' }); }
}

function renderLifelines(st) {
  const g = st.game;
  if (g.comp) {
    const P = g.me;
    const html = Object.keys(P ? P.life : {}).filter(role => ROLES[role]).map(role => {
      const R = ROLES[role];
      const used = !P || P.life[role];
      let can = !!P && !used && st.phase === 'voting' && g.playing && !P.c;
      if (role === 'crono' && !st.settings.time) can = false;
      if (role === 'suertudo' && P && P.dbl) can = false;
      const active = role === 'suertudo' && P && P.dbl;
      return `<button class="life mine ${used ? 'used' : ''} ${active ? 'active' : ''}" data-role="${role}" ${can ? '' : 'disabled'} title="${esc(R.desc)}">
        <span class="li">${R.icon}</span><span><b>${R.power}</b><small>${active ? '¡activo!' : used ? 'usado' : 'Tu comodín'}</small></span><span></span></button>`;
    }).join('');
    const el = $('#lifelines');
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    return;
  }
  const html = Object.entries(g.life).map(([role, L]) => {
    const R = ROLES[role];
    if (!R) return '';
    const owner = st.players.find(p => p.id === L.owner);
    const ownerOnline = owner && owner.online;
    const mine = L.owner === me.id;
    let can = !L.used && st.phase === 'voting' && mine;
    if (role === 'crono' && !st.settings.time) can = false;
    if (role === 'suertudo' && g.dbl) can = false;
    const active = role === 'suertudo' && g.dbl;
    const tip = `${R.desc}${mine ? ' · Solo tú puedes usarlo' : owner ? ` · Solo lo puede usar ${owner.name}${ownerOnline ? '' : ' (desconectado)'}` : ''}`;
    return `<button class="life ${L.used ? 'used' : ''} ${active ? 'active' : ''} ${mine ? 'mine' : 'notmine'}" data-role="${role}" ${can ? '' : 'disabled'} title="${esc(tip)}">
      <span class="li">${R.icon}</span><span><b>${R.power}</b><small>${esc(owner ? (mine ? 'Tu comodín' : owner.name) : '')}${active ? ' · ¡activo!' : ''}</small></span>
      ${owner ? `<img src="${thumb(owner.av, 64)}" alt="">` : '<span></span>'}
    </button>`;
  }).join('');
  const el = $('#lifelines');
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

function renderQuestion(st, qChanged) {
  const g = st.game;
  const q = g.q;
  const answersEl = $('#answers');
  if (!q) return;
  if (qChanged) {
    const cat = CAT_BY_ID[q.cat] || { name: 'Pregunta personalizada', icon: '✏️' };
    $('#q-meta').textContent = `${cat.icon} ${cat.name} · ${'★'.repeat(q.d)}${'☆'.repeat(5 - q.d)}`;
    $('#question').textContent = q.text;
    answersEl.classList.remove('intro');
    void answersEl.offsetWidth;
    if (st.phase === 'intro') answersEl.classList.add('intro');
  }
  // Al terminar la entrada se quita la clase para que puedan sonar las animaciones de acierto/fallo.
  if (st.phase !== 'intro') answersEl.classList.remove('intro');
  const myVote = g.votes[me.id];
  const isVoting = st.phase === 'voting';
  $$('.answer', answersEl).forEach((b, i) => {
    b.style.setProperty('--i', i);
    $('.txt', b).textContent = q.opts[i];
    const removed = g.removed.includes(i);
    b.classList.toggle('removed', removed);
    b.classList.toggle('mine', !!myVote && myVote.o === i && isVoting);
    b.classList.toggle('confirmed', !!myVote && myVote.o === i && myVote.c && isVoting);
    b.classList.toggle('picked', st.phase === 'locked' && g.picked === i);
    const revealed = (st.phase === 'reveal' || st.phase === 'over') && g.answer != null;
    b.classList.toggle('correct', revealed && g.answer === i);
    b.classList.toggle('wrong', (st.phase === 'reveal' && g.result === 'retry' && g.picked === i) || (revealed && g.picked === i && g.answer !== i));
    b.disabled = !isVoting || removed || (!!g.comp && (!g.playing || !!(g.me && g.me.c)));
    $('.pct', b).textContent = g.poll && !removed ? `${g.poll[i]}%` : '';
    const tap = $('.tap', b);
    const minePick = isVoting && !!myVote && myVote.o === i;
    tap.textContent = minePick ? (myVote.c ? '🔒 Confirmada' : '👆 Toca otra vez para confirmar') : '';
    tap.classList.toggle('ok', minePick && !!myVote.c);
    b.setAttribute('aria-label', `Respuesta ${LETTERS[i]}: ${q.opts[i]}`);
  });
  const extra = [];
  if (g.hint) extra.push(`📚 La Profesora: «Creo que es la ${LETTERS[g.hint.idx]}, estoy ${g.hint.conf}% segura».`);
  if (g.poll) extra.push('📱 Encuesta del público en pantalla.');
  if (g.dbl) extra.push(g.comp ? '🍀 Doble intento activo: si fallas, tienes otra oportunidad.' : '🍀 Doble intento activo: si fallan, tienen otra oportunidad.');
  if (g.comp && g.me && g.me.retry && st.phase === 'voting') extra.push('🍀 No era esa: elige otra.');
  if (g.comp && g.me && g.me.extra) extra.push(`⏱️ +${g.me.extra / 1000} s para ti.`);
  $('#q-extra').textContent = extra.join(' ');
  const walk = $('#btn-walk');
  const cur = g.n > 0 ? g.ladder[g.n - 1] : 0;
  const walkMine = isVoting && !!myVote && myVote.o === 4;
  $('.walk-txt', walk).textContent = walkMine ? (myVote.c ? '🔒 Confirmado: plantarse' : '👆 Toca otra vez para plantarse') : `🏳️ Plantarse con ${fmtMoney(cur)}`;
  walk.disabled = !isVoting;
  walk.classList.toggle('hidden', !!g.comp);
  walk.classList.toggle('mine', !!myVote && myVote.o === 4 && isVoting);
}

function renderVotes(st) {
  const g = st.game;
  const online = st.players.filter(p => p.online);
  if (g.comp) {
    const C = g.comp;
    const reveal = st.phase === 'reveal' || st.phase === 'over';
    const myQ = g.q && g.q.id;
    const by = { 0: [], 1: [], 2: [], 3: [] };
    for (const p of online) {
      const P = C.p[p.id];
      if (!P || P.o == null) continue;
      const theirQ = (P.q || g.sharedQ || {}).id;
      if (p.id === me.id || (reveal && theirQ === myQ)) by[P.o].push(p);
    }
    $$('.answer').forEach((b, i) => { $('.voters', b).innerHTML = by[i].map(p => imgThumb(p.av, p.name, 64)).join(''); });
    $('#btn-walk .voters').innerHTML = '';
    if (!stage) return;
    const inPlay = new Set(C.sd || g.roster.map(r => r.id));
    for (const p of online) {
      const P = C.p[p.id];
      if (!P || !inPlay.has(p.id)) { stage.setSign(p.id, null, colorOf(p.av)); continue; }
      if (st.phase === 'voting') {
        stage.setSign(p.id, P.c ? '✔' : null, colorOf(p.av)); stage.setAnim(p.id, P.c ? 'vote' : 'think');
        stage.setPodiumState?.(p.id, S.waitIds.includes(p.id) ? 'waiting' : P.c ? 'confirmed' : P.o != null ? 'voted' : 'idle');
      } else if (st.phase === 'locked') stage.setSign(p.id, '✔', colorOf(p.av));
      else if (st.phase === 'reveal') {
        stage.setSign(p.id, P.o != null ? LETTERS[P.o] : '⏰', colorOf(p.av));
        stage.setAnim(p.id, P.res === 'ok' ? 'happy' : 'sad');
        stage.setPodiumState?.(p.id, P.res === 'ok' ? 'correct' : 'wrong');
      } else { stage.setSign(p.id, null, colorOf(p.av)); if (st.phase === 'intro') stage.setPodiumState?.(p.id, 'idle'); }
    }
    return;
  }
  const showVotes = st.phase === 'voting' || st.phase === 'locked' || st.phase === 'reveal';
  const by = { 0: [], 1: [], 2: [], 3: [], 4: [] };
  if (showVotes) for (const p of online) { const v = g.votes[p.id]; if (v && by[v.o]) by[v.o].push(p); }
  const chip = p => { const v = g.votes[p.id]; return imgThumb(p.av, `${p.name}${v && v.c ? ' · confirmó' : ' · eligió, falta confirmar'}`, 64, v && v.c ? 'ok' : 'pending'); };
  $$('.answer').forEach((b, i) => { $('.voters', b).innerHTML = by[i].map(chip).join(''); });
  $('#btn-walk .voters').innerHTML = by[4].map(chip).join('');
  if (!stage) return;
  for (const p of online) {
    const v = showVotes ? g.votes[p.id] : null;
    stage.setSign(p.id, v ? (v.o === 4 ? '🏳️' : LETTERS[v.o]) + (v.c ? ' ✓' : '') : null, colorOf(p.av));
    if (st.phase === 'voting') {
      stage.setAnim(p.id, v ? 'vote' : 'think');
      stage.setPodiumState?.(p.id, S.waitIds.includes(p.id) ? 'waiting' : v ? (v.c ? 'confirmed' : 'voted') : 'idle');
    } else if (st.phase === 'reveal' && g.result !== 'retry' && g.answer != null) {
      stage.setPodiumState?.(p.id, v && v.o === g.answer ? 'correct' : 'wrong');
    } else if (st.phase === 'reveal' && g.result === 'retry') {
      stage.setPodiumState?.(p.id, v && v.o === g.picked ? 'wrong' : 'idle');
    } else if (st.phase === 'intro') stage.setPodiumState?.(p.id, 'idle');
  }
}

function renderStatus(st) {
  const g = st.game;
  const online = st.players.filter(p => p.online);
  if (g.comp) {
    const C = g.comp, P = g.me;
    const inPlay = online.filter(p => C.p[p.id] && (!C.sd || C.sd.includes(p.id)));
    const ready = inPlay.filter(p => C.p[p.id].c).length;
    let text = '';
    switch (st.phase) {
      case 'intro': text = C.sd ? '⚔️ Muerte súbita: lee bien…' : '👀 Lee bien la pregunta…'; break;
      case 'voting':
        if (!g.playing) text = C.sd ? '⚔️ Muerte súbita entre los empatados' : 'Estás viendo la partida';
        else if (P.c) text = '🔒 Confirmaste. Esperando a los demás…';
        else if (P.o != null) text = `👆 Elegiste la ${LETTERS[P.o]}: tócala otra vez para confirmar`;
        else text = 'Toca una respuesta y luego confírmala con otro toque';
        text += ` · ${ready}/${inPlay.length} confirmados`;
        break;
      case 'locked': text = '🥁 Respuestas fijadas…'; break;
      case 'reveal': text = !P || !g.playing ? '' : { ok: '🎉 ¡Correcto!', bad: '😢 Incorrecto', timeout: '⏰ Sin tiempo' }[P.res] || ''; break;
      case 'over': text = '🏁 Fin de la partida'; break;
      default: break;
    }
    $('#status-line').textContent = text;
    return;
  }
  const solo = online.length === 1;
  const v = g.votes[me.id];
  let text = '';
  switch (st.phase) {
    case 'intro': text = '👀 Lean bien la pregunta…'; break;
    case 'voting': {
      const confirmed = online.filter(p => g.votes[p.id] && g.votes[p.id].c).length;
      if (v && v.c) text = solo ? '🔒 Confirmada' : '🔒 Confirmaste. Esperando al equipo…';
      else if (v) text = `👆 Elegiste ${v.o === 4 ? 'plantarse' : 'la ' + LETTERS[v.o]}: tócala otra vez para confirmar`;
      else text = solo ? 'Toca una respuesta y luego confírmala con otro toque' : 'Toca una respuesta y confírmala con otro toque · gana la mayoría';
      if (!solo) text += ` · ${confirmed}/${online.length} confirmados`;
      break;
    }
    case 'locked': text = '🥁 Respuesta fijada…'; break;
    case 'reveal': text = { ok: '🎉 ¡Correcto!', retry: '🍀 ¡Otra oportunidad!', bad: '😢 Incorrecto', timeout: '⏰ Sin tiempo' }[g.result] || ''; break;
    case 'over': text = '🏁 Fin de la partida'; break;
    default: break;
  }
  $('#status-line').textContent = text;
}

function renderOver(st) {
  const g = st.game;
  const o = g.outcome;
  if (!o) return;
  if (o.kind === 'comp') { renderCompOver(st); return; }
  const isHost = st.hostId === me.id;
  const inRoster = g.roster.some(p => p.id === me.id);
  // Estadísticas y desbloqueos (una vez por partida)
  if (S.recorded !== g.id && inRoster) {
    S.recorded = g.id;
    S.unlocks = recordGame({ level: o.level, len: g.len, prize: o.prize, won: o.kind === 'win', walked: o.kind === 'walk', correct: g.correct, teamSize: g.roster.length });
    addSeen(g.asked);
    if (S.unlocks.length) setTimeout(() => audio.sfx('unlock'), 1800);
  }
  const titles = {
    win: '¡SON MILLONARIOS!',
    walk: 'Se plantaron',
    lose: o.level === 0 ? '¡Fuera a la primera!' : '¡Casi!',
  };
  const sub = {
    win: 'Subieron toda la escalera. ¡Leyendas!',
    walk: 'Decisión inteligente: se llevan lo ganado.',
    lose: o.prize > 0 ? 'El punto seguro los salvó.' : 'Esta vez no hubo premio.',
  };
  const ans = g.q && g.answer != null && o.kind !== 'win' ? `<p class="over-sub">La respuesta correcta era la <b>${LETTERS[g.answer]}</b>: ${esc(g.q.opts[g.answer])}</p>` : '';
  const eligible = !g.custom && o.prize > 0;
  const key = g.id + (isHost ? 'h' : 'g');
  if (S.overShown === key) return;
  S.overShown = key;
  const ps = g.ps || {};
  const ranked = [...g.roster].sort((a, b) => ((ps[b.id] || {}).ok || 0) - ((ps[a.id] || {}).ok || 0));
  const medal = i => ['🥇', '🥈', '🥉'][i] || '🏅';
  const el = $('#over');
  el.innerHTML = `<div class="over-box card">
    <div class="ob-head"><div><p class="over-sub">${esc(sub[o.kind])}</p><h2 class="over-title">${titles[o.kind]}</h2></div><div class="over-prize">${fmtMoney(o.prize)}</div></div>
    <p class="over-sub">${esc(g.team || '')} · superaron ${o.level} de ${g.len} preguntas</p>
    ${ans}
    <div class="team-rank" aria-label="Aciertos de cada jugador">${ranked.map((p, i) => `<div class="tr-item ${p.id === me.id ? 'me' : ''}"><span class="tr-medal">${medal(i)}</span>${imgThumb(p.av, p.name, 64)}<span class="tr-name">${esc(p.name)}</span><span class="tr-ok">✓ ${(ps[p.id] || {}).ok || 0}</span></div>`).join('')}</div>
    <div class="unlocks">${S.recorded === g.id ? S.unlocks.map((u, i) => `<div class="unlock" style="animation-delay:${1.2 + i * 0.3}s">🎁 ¡Desbloqueaste ${esc(u.kind.toLowerCase())}: ${u.icon} ${esc(u.name)}!</div>`).join('') : ''}</div>
    <p class="fame-note" id="fame-note">${eligible ? '' : (g.custom ? 'Las partidas con preguntas personalizadas no entran al Salón de la fama.' : '')}</p>
    <div class="over-actions">
      ${isHost ? '<button class="btn btn-go btn-big" id="btn-again">Jugar otra vez</button>' : '<p class="muted" style="width:100%">Esperando a que el anfitrión vuelva a la sala…</p>'}
      <button class="btn" id="btn-over-leave">Salir</button>
      <button class="btn btn-ghost btn-small" id="btn-report">⚑ Reportar la última pregunta</button>
    </div>
  </div>`;
  el.classList.remove('hidden');
  const again = $('#btn-again', el);
  if (again) again.addEventListener('click', () => act({ t: 'lobby' }));
  $('#btn-over-leave', el).addEventListener('click', () => leaveRoom(false));
  $('#btn-report', el).addEventListener('click', () => openReportModal(g.q));
  if (eligible) {
    setTimeout(async () => {
      const rank = await fameRank(o.prize).catch(() => null);
      const note = $('#fame-note');
      if (note && rank) note.textContent = `🏆 Puesto #${rank} en el Salón de la fama`;
    }, 2200);
  }
}

function renderCompOver(st) {
  const g = st.game, o = g.outcome, rank = (g.comp && g.comp.rank) || [];
  const isHost = st.hostId === me.id;
  const mine = rank.find(r => r.id === me.id);
  if (S.recorded !== g.id && mine) {
    S.recorded = g.id;
    S.unlocks = recordGame({ level: mine.correct, len: g.len, prize: mine.score, won: mine.correct >= g.len, walked: false, correct: mine.correct, teamSize: g.roster.length });
    addSeen(g.asked);
    if (S.unlocks.length) setTimeout(() => audio.sfx('unlock'), 1800);
  }
  const key = g.id + (isHost ? 'h' : 'g');
  if (S.overShown === key) return;
  S.overShown = key;
  const winner = rank[0];
  const iWon = winner && winner.id === me.id;
  const secs = ms => (ms / 1000).toFixed(1) + ' s';
  const medal = i => ['🥇', '🥈', '🥉'][i] || `${i + 1}.º`;
  const el = $('#over');
  el.innerHTML = `<div class="over-box card">
    <p class="over-sub">⚔️ Modo competitivo${o.sdRounds ? ` · se definió en muerte súbita (${o.sdRounds} ronda${o.sdRounds > 1 ? 's' : ''})` : ''}</p>
    <h2 class="over-title">${iWon ? '¡GANASTE!' : `¡Ganó ${esc(winner ? winner.name : '')}!`}</h2>
    <div class="over-prize">${fmtMoney(winner ? winner.score : 0)}</div>
    <div class="comp-rank">${rank.map((r, i) => `<div class="cr-row ${r.id === me.id ? 'me' : ''}"><span class="cr-pos">${medal(i)}</span>${imgThumb(r.av, r.name, 64)}<span class="cr-name">${esc(r.name)}</span><span class="cr-info">${r.correct}/${g.len} aciertos · ${secs(r.timeMs)}</span><span class="cr-money">${fmtMoney(r.score)}</span></div>`).join('')}</div>
    <div class="unlocks">${S.recorded === g.id ? S.unlocks.map((u, i) => `<div class="unlock" style="animation-delay:${1.2 + i * 0.3}s">🎁 ¡Desbloqueaste ${esc(u.kind.toLowerCase())}: ${u.icon} ${esc(u.name)}!</div>`).join('') : ''}</div>
    <p class="fame-note">Las partidas competitivas no entran al Salón de la fama.</p>
    <div class="over-actions">
      ${isHost ? '<button class="btn btn-go btn-big" id="btn-again">Jugar otra vez</button>' : '<p class="muted" style="width:100%">Esperando a que el anfitrión vuelva a la sala…</p>'}
      <button class="btn" id="btn-over-leave">Salir</button>
      <button class="btn btn-ghost btn-small" id="btn-report">⚑ Reportar la última pregunta</button>
    </div>
  </div>`;
  el.classList.remove('hidden');
  const again = $('#btn-again', el);
  if (again) again.addEventListener('click', () => act({ t: 'lobby' }));
  $('#btn-over-leave', el).addEventListener('click', () => leaveRoom(false));
  $('#btn-report', el).addEventListener('click', () => openReportModal(g.q));
}

function hostOver(st) {
  const g = st.game;
  const o = g.outcome;
  if (!o || g.comp || g.custom || o.prize <= 0) return;
  submitFame({
    team_name: (g.team || 'Equipo').slice(0, 32),
    players: g.roster.slice(0, 4).map(p => ({ n: String(p.name).slice(0, 16), c: p.av.color, e: p.av.eyes, m: p.av.mouth, h: p.av.hat })),
    level_reached: o.level, ladder_length: g.len, prize: o.prize, difficulty: st.settings.diff, won: o.kind === 'win',
  }).catch(e => console.warn('Salón de la fama:', e));
}

// ---- Frases rápidas: globo sobre el avatar + línea en el chat ----
function showSay(player, text) {
  if (stage) stage.say?.(player.id, text, colorOf(player.av));
  addChat({ name: player.name, c: player.av.color, text: '🗨️ ' + text });
  audio.sfx('chat');
}
function sendSay(k) {
  const text = QUICK_PHRASES[k];
  if (!text || !S.room || !S.state) return;
  const now = Date.now();
  if (now - S.lastSay < 1200) return;
  S.lastSay = now;
  S.room.send('say', { k });
  const mine = S.state.players.find(x => x.id === me.id) || { id: me.id, name: me.name, av: me.av };
  showSay(mine, text);
}
function initPhrases() {
  const panel = $('#phrases');
  panel.innerHTML = QUICK_PHRASES.map((t, k) => `<button type="button" class="chip" data-k="${k}" role="menuitem">${esc(t)}</button>`).join('');
  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    sendSay(Number(b.dataset.k));
    panel.classList.add('hidden');
  });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'say-btn';
  btn.title = 'Frases rápidas';
  btn.setAttribute('aria-label', 'Frases rápidas');
  btn.textContent = '🗨️';
  $('#reactions').prepend(btn);
  btn.addEventListener('click', e => { e.stopPropagation(); panel.classList.toggle('hidden'); });
  document.addEventListener('click', e => {
    if (!panel.classList.contains('hidden') && !e.target.closest('#phrases') && !e.target.closest('.say-btn')) panel.classList.add('hidden');
  });
}

// ---- «Todos esperan a…»: cuando la mayoría ya confirmó y falta alguien ----
const WAIT_DELAY = 2500;
function pendingConfirm(st) {
  const g = st && st.game;
  if (!g || st.phase !== 'voting') return [];
  const online = st.players.filter(p => p.online);
  let all, isDone;
  if (g.comp) {
    const C = g.comp;
    all = online.filter(p => C.p[p.id] && (!C.sd || C.sd.includes(p.id)));
    isDone = p => C.p[p.id].c;
  } else {
    all = online;
    isDone = p => !!(g.votes[p.id] && g.votes[p.id].c);
  }
  const done = all.filter(isDone).length;
  if (all.length < 2 || done === 0 || done === all.length) return [];
  return all.filter(p => !isDone(p));
}
function updateWaiting(now) {
  if (S.screen !== 'game') { if (S.waitKey) { S.waitKey = ''; clearWaiting(); } return; }
  const pending = pendingConfirm(S.state);
  const key = pending.map(p => p.id).join(',');
  if (key !== S.waitKey) {
    const wasShown = S.waitShown;
    S.waitKey = key;
    S.waitShown = false;
    if (!key) { S.waitSince = 0; clearWaiting(); return; }
    // si ya se mostraba y alguien confirmó, se actualiza al instante
    S.waitSince = wasShown ? now - WAIT_DELAY : now;
  }
  if (key && !S.waitShown && now - S.waitSince >= WAIT_DELAY) { S.waitShown = true; showWaiting(pending); }
}
function showWaiting(pending) {
  S.waitIds = pending.map(p => p.id);
  const meWaiting = S.waitIds.includes(me.id);
  const others = pending.filter(p => p.id !== me.id).map(p => p.name);
  const list = n => n.length > 1 ? n.slice(0, -1).join(', ') + ' y ' + n[n.length - 1] : n[0];
  const text = meWaiting
    ? (others.length ? `⏳ Faltan tú y ${list(others)}: ¡confirmen!` : '⏳ ¡Todos te esperan! Toca otra vez tu respuesta para confirmar')
    : (pending.length === 1 ? `⏳ ¡Todos esperan a ${pending[0].name}!` : `⏳ Esperando a ${list(pending.map(p => p.name))}`);
  const el = $('#wait-banner');
  el.textContent = text;
  el.classList.toggle('me', meWaiting);
  el.classList.remove('hidden');
  if (meWaiting) { audio.sfx('tick'); try { navigator.vibrate && navigator.vibrate(140); } catch { /* sin vibración */ } }
  if (stage) stage.focus?.(pending.length === 1 ? pending[0].id : null);
  if (S.state && S.state.game) renderVotes(viewOf(S.state));
}
function clearWaiting() {
  const had = S.waitIds.length;
  S.waitIds = [];
  $('#wait-banner').classList.add('hidden');
  if (stage && had) stage.focus?.(null);
  if (had && S.state && S.state.game && S.screen === 'game') renderVotes(viewOf(S.state));
}

// Reloj de la pregunta.
function timerLoop() {
  if (S.screen === 'game' && S.state && S.state.game) {
    const now = performance.now();
    const ph = S.state.phase;
    const num = $('#timer-num');
    const bar = $('#timer-bar');
    const timer = $('#timer');
    if (ph === 'voting' && S.deadline) {
      const left = Math.max(0, S.deadline - now);
      const secs = Math.ceil(left / 1000);
      num.textContent = secs;
      bar.style.strokeDashoffset = String(276.46 * (1 - left / Math.max(1, S.total)));
      timer.classList.toggle('warn', secs <= 10 && secs > 5);
      timer.classList.toggle('danger', secs <= 5);
      if (secs <= 5 && secs > 0 && secs !== S.lastTick) { S.lastTick = secs; audio.sfx('tick'); }
    } else {
      num.textContent = ph === 'voting' ? '∞' : ph === 'intro' ? '…' : '·';
      bar.style.strokeDashoffset = '0';
      timer.classList.remove('warn', 'danger');
      S.lastTick = -1;
    }
  }
  requestAnimationFrame(timerLoop);
}

function initGameUI() {
  $('#answers').addEventListener('click', e => {
    const b = e.target.closest('.answer');
    if (!b || b.disabled) return;
    audio.sfx('vote');
    act({ t: 'vote', o: Number(b.dataset.i) });
  });
  $('#btn-walk').addEventListener('click', () => { audio.sfx('vote'); act({ t: 'vote', o: 4 }); });
  $('#lifelines').addEventListener('click', e => {
    const b = e.target.closest('.life');
    if (!b || b.disabled) return;
    act({ t: 'life', role: b.dataset.role });
  });
  $('#btn-ladder').addEventListener('click', () => $('#ladder').classList.toggle('open'));
  $('#btn-exit').addEventListener('click', () => {
    openModal(`<h2>¿Salir de la partida?</h2><p>Tu equipo seguirá jugando sin ti.</p>
      <div class="over-actions"><button class="btn" id="m-stay">Quedarme</button><button class="btn btn-alt" id="m-go">Salir</button></div>`, box => {
      $('#m-stay', box).onclick = closeModal;
      $('#m-go', box).onclick = () => { closeModal(); leaveRoom(false); };
    });
  });
  $('#reactions').innerHTML = REACTIONS.map(e => `<button type="button" data-e="${e}" aria-label="Reacción ${e}">${e}</button>`).join('');
  $('#reactions').addEventListener('click', e => {
    const b = e.target.closest('button[data-e]');
    if (!b || !S.room) return;
    const now = Date.now();
    if (now - S.lastReact < 500) return;
    S.lastReact = now;
    S.room.send('react', { e: b.dataset.e });
    if (stage) stage.react(me.id, b.dataset.e);
    audio.sfx('react');
  });
  document.addEventListener('keydown', e => {
    if (S.screen !== 'game' || !S.state || S.state.phase !== 'voting') return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName)) return;
    const map = { 1: 0, 2: 1, 3: 2, 4: 3, a: 0, b: 1, c: 2, d: 3 };
    const k = e.key.toLowerCase();
    if (k in map) { const b = $$('.answer')[map[k]]; if (b && !b.disabled) b.click(); }
  });
  bindSettings($('#settings-form'));
  $('#btn-leave').addEventListener('click', () => leaveRoom(false));
  $('#btn-start').addEventListener('click', () => act({ t: 'start' }));
  $('#btn-copy').addEventListener('click', async () => {
    const url = inviteUrl(S.room.code);
    try { await navigator.clipboard.writeText(url); toast('🔗 Link copiado. ¡Compártelo con tus amigos!'); } catch { prompt('Copia este link:', url); }
  });
  $('#lobby-list').addEventListener('click', e => {
    const b = e.target.closest('[data-kick]');
    if (b) act({ t: 'kick', id: b.dataset.kick });
  });
  $('#role-picker').addEventListener('click', e => {
    const b = e.target.closest('.role');
    if (!b || b.disabled) return;
    audio.sfx('click');
    act({ t: 'role', role: b.dataset.role });
  });
  const qa = $('#qa');
  new ResizeObserver(() => { document.body.style.setProperty('--qa-h', qa.offsetHeight + 'px'); updateFraming(); }).observe(qa);
  window.addEventListener('resize', updateFraming);
  requestAnimationFrame(timerLoop);
}

// Ajusta el encuadre 3D para que los podios queden en la zona libre de la interfaz.
function updateFraming() {
  if (!stage) return;
  const w = window.innerWidth, h = window.innerHeight;
  if (S.screen === 'home') {
    if (w >= 1000) stage.setFraming(0.15, -0.07); else stage.setFraming(0, 0);
  } else if (S.screen === 'lobby') {
    stage.setFraming(0, 0);
  } else {
    const top = 84;
    const ob = S.state && S.state.phase === 'over' ? $('#over:not(.hidden) .over-box') : null;
    let bottom = ob ? ob.getBoundingClientRect().top : $('#qa').getBoundingClientRect().top;
    if (!ob && w < 1100) { const l = $('#lifelines').getBoundingClientRect(); if (l.height) bottom = Math.min(bottom, l.top); }
    const center = (top + bottom) / 2;
    stage.setFraming(0, Math.max(0, Math.min(0.42, (h / 2 - center) / h)));
  }
}

// ====================================================================
// chat
// ====================================================================
function initChat() {
  $('#chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim().slice(0, 140);
    if (!text || !S.room) return;
    const now = Date.now();
    if (now - S.lastChat < 700) { toast('Más despacio 🙂', 1200); return; }
    S.lastChat = now;
    const msg = { name: me.name, c: me.av.color, text };
    S.room.send('chat', msg);
    addChat(msg);
    input.value = '';
  });
  const btn = document.createElement('button');
  btn.className = 'icon-btn';
  btn.id = 'btn-chat';
  btn.title = 'Chat';
  btn.setAttribute('aria-label', 'Abrir chat');
  btn.textContent = '💬';
  $('.hud-right').insertBefore(btn, $('#btn-ladder'));
  btn.addEventListener('click', () => {
    const c = $('#chat-slot-game');
    c.classList.toggle('open');
    btn.classList.remove('unread');
    if (c.classList.contains('open')) $('#chat-input').focus();
  });
}
function clearChat() { $('#chat-log').innerHTML = ''; }
function initLobbyChatButton() {
  const btn = $('#btn-chat-lobby');
  btn.addEventListener('click', () => {
    const c = $('#chat-slot-lobby');
    c.classList.toggle('open');
    btn.classList.remove('unread');
    if (c.classList.contains('open')) $('#chat-input').focus();
  });
}
function pushChatLi(li) {
  const log = $('#chat-log');
  log.appendChild(li);
  while (log.children.length > 120) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  if (S.screen === 'game' && !$('#chat-slot-game').classList.contains('open')) $('#btn-chat')?.classList.add('unread');
  if (S.screen === 'lobby' && !$('#chat-slot-lobby').classList.contains('open')) $('#btn-chat-lobby')?.classList.add('unread');
}
function addChat(m) {
  const li = document.createElement('li');
  const col = AVATAR.colors[(m.c | 0) % AVATAR.colors.length];
  li.innerHTML = `<b style="color:${col}">${esc(String(m.name || '').slice(0, 16))}:</b> ${esc(String(m.text || '').slice(0, 140))}`;
  pushChatLi(li);
}
function addSys(text, cls = '') {
  const li = document.createElement('li');
  li.className = 'sys ' + cls;
  li.textContent = text;
  pushChatLi(li);
}

// ====================================================================
// modales
// ====================================================================
function openModal(html, onMount) {
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
  if (onMount) onMount($('#modal-body'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-body').innerHTML = ''; }

function initModals() {
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-open]');
    if (!b) return;
    audio.unlock();
    audio.sfx('click');
    ({ howto: openHowto, fame: openFame, collection: openCollection, settings: openSettings })[b.dataset.open]?.();
  });
}

function openHowto() {
  openModal(`<h2>❓ Cómo se juega</h2>
    <p><b>El Gran Millón</b> es un concurso de preguntas en equipo. Hasta 4 amigos suben juntos una escalera de 10, 15 o 20 preguntas, cada una más difícil, hasta el premio mayor de <b>$1,000,000</b>.</p>
    <h3>Responder</h3>
    <ul>
      <li>Cada pregunta trae 4 opciones (A, B, C, D). Todos votan y <b>gana la mayoría</b>.</li>
      <li>Si hay empate, gana la opción que llegó primero a ese número de votos.</li>
      <li><b>Doble toque:</b> el primer toque elige tu respuesta y el segundo la confirma. Cuando todos confirman, se fija la respuesta del equipo. Si se acaba el tiempo, cuentan los votos que haya.</li>
      <li>También pueden votar <b>🏳️ Plantarse</b> para llevarse lo ganado hasta ahora.</li>
      <li>Atajos: teclas 1-4 o A-D.</li>
    </ul>
    <h3>Puntos seguros 🛡️</h3>
    <p>Si fallan, se llevan el premio del último punto seguro que hayan pasado. En «Todo o nada» no hay red.</p>
    <h3>Roles y comodines</h3>
    <ul>${Object.values(ROLES).map(r => `<li>${r.icon} <b>${r.name}</b> · ${r.power}: ${r.desc}${r.unlock ? ` <i class="muted">(se desbloquea: ${r.unlock.text})</i>` : ''}</li>`).join('')}</ul>
    <p class="muted">Cada jugador tiene un solo comodín: el de su rol, y solo él puede usarlo, una vez por partida. Si no eliges rol, te toca uno al azar.</p>
    <h3>Desbloqueos 🎁</h3>
    <p>Jugando desbloqueas estilos visuales, sombreros y roles. Si eres el anfitrión, tus amigos ven la partida con el estilo que tú elijas.</p>`);
}

async function openFame() {
  const render = async (kind) => {
    const list = $('#fame-list');
    if (!list) return;
    list.innerHTML = '<li class="muted">Cargando…</li>';
    try {
      const rows = await fetchFame(kind);
      if (!rows.length) { list.innerHTML = '<li class="muted">Todavía no hay equipos. ¡Sé el primero!</li>'; return; }
      list.innerHTML = rows.map((r, i) => {
        const dots = (Array.isArray(r.players) ? r.players : []).map(p => `<i style="background:${AVATAR.colors[(p.c | 0) % 12]}" title="${esc(p.n)}"></i>`).join('');
        const date = new Date(r.created_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
        return `<li><span class="rank">${kind === 'top' ? (i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1) : '•'}</span>
          <span class="tm"><b>${esc(r.team_name)} <span class="dots">${dots}</span></b>
          <small>${(Array.isArray(r.players) ? r.players : []).map(p => esc(p.n)).join(', ')} · pregunta ${r.level_reached}/${r.ladder_length} · ${esc(DIFFICULTIES.find(d => d.id === r.difficulty)?.name || '')} · ${date}</small></span>
          <span class="pz">${r.won ? '👑 ' : ''}${fmtMoney(r.prize)}</span></li>`;
      }).join('');
    } catch (e) {
      list.innerHTML = '<li class="muted">No se pudo cargar el ranking. Inténtalo más tarde.</li>';
    }
  };
  openModal(`<h2>🏆 Salón de la fama</h2>
    <div class="tabs seg"><button class="on" data-k="top">Mejores</button><button data-k="recent">Recientes</button></div>
    <ul class="fame-list" id="fame-list"></ul>`, box => {
    box.querySelector('.tabs').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('.tabs button', box).forEach(x => x.classList.toggle('on', x === b));
      render(b.dataset.k);
    });
  });
  render('top');
}

function openCollection() {
  const s = profile.stats;
  const stat = (v, l) => `<div class="stat"><b>${v}</b>${l}</div>`;
  openModal(`<h2>🎁 Colección</h2>
    <div class="stats">
      ${stat(s.games, 'partidas')}${stat(s.wins, 'millones ganados')}${stat(s.correct, 'aciertos')}
      ${stat(s.bestLevel, 'mejor escalón')}${stat(fmtMoney(s.total), 'ganado en total')}${stat(s.teamGames, 'en equipo')}
    </div>
    <h3>Estilos visuales <span class="muted small">· toca uno para usarlo cuando seas anfitrión</span></h3>
    <div class="grid-unlock" id="col-themes">${Object.entries(THEMES).map(([id, t]) => {
      const ok = isThemeUnlocked(id);
      return `<button class="unl ${ok ? '' : 'locked'} ${profile.theme === id ? 'on' : ''}" data-theme="${id}" ${ok ? '' : 'disabled'}><b>${t.icon} ${t.name}</b><small>${ok ? t.desc : '🔒 ' + t.unlock.text}</small></button>`;
    }).join('')}</div>
    <h3>Roles</h3>
    <div class="grid-unlock">${Object.values(ROLES).map(r => {
      const ok = !r.unlock || r.unlock.test(profile);
      return `<div class="unl ${ok ? '' : 'locked'}"><b>${r.icon} ${r.name}</b><small>${ok ? r.power + ': ' + r.desc : '🔒 ' + r.unlock.text}</small></div>`;
    }).join('')}</div>
    <h3>Sombreros</h3>
    <div class="grid-unlock">${AVATAR.hats.map((h, i) => {
      if (i === 0) return '';
      const u = HAT_UNLOCKS[h];
      const ok = isHatUnlocked(i);
      return `<div class="unl ${ok ? '' : 'locked'}"><b>${AVATAR.hatNames[i]}</b><small>${ok ? 'Disponible' : '🔒 ' + u.text}</small></div>`;
    }).join('')}</div>`, box => {
    $('#col-themes', box).addEventListener('click', e => {
      const b = e.target.closest('[data-theme]');
      if (!b || b.disabled) return;
      profile.theme = b.dataset.theme;
      saveProfile();
      $$('#col-themes .unl', box).forEach(x => x.classList.toggle('on', x === b));
      if (S.screen === 'home') { document.body.dataset.theme = profile.theme; stage && stage.setTheme(profile.theme); setHomePlayers(); }
      audio.sfx('whoosh');
    });
  });
}

function openSettings() {
  const st = profile.settings;
  openModal(`<h2>⚙️ Ajustes</h2>
    <label class="set-row">🎵 Música <input type="range" class="range" id="s-music" min="0" max="1" step="0.05" value="${st.music}"></label>
    <label class="set-row">🔊 Efectos <input type="range" class="range" id="s-sfx" min="0" max="1" step="0.05" value="${st.sfx}"></label>
    <div class="set-row">🖥️ Calidad gráfica
      <div class="seg" id="s-quality">${[['auto', 'Automática'], ['alta', 'Alta'], ['media', 'Media'], ['baja', 'Baja']].map(([v, l]) => `<button data-v="${v}" class="${st.quality === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <small class="muted">Si el juego va lento en tu celular, usa Baja.</small>
    </div>
    <label class="set-row" style="grid-template-columns:auto 1fr;align-items:center;display:grid;gap:8px"><input type="checkbox" id="s-motion" ${st.reduceMotion ? 'checked' : ''}> Reducir animaciones y destellos</label>`, box => {
    const save = () => { saveProfile(); audio.setVolumes({ music: st.music, sfx: st.sfx }); };
    $('#s-music', box).addEventListener('input', e => { st.music = Number(e.target.value); save(); });
    $('#s-sfx', box).addEventListener('input', e => { st.sfx = Number(e.target.value); save(); });
    $('#s-sfx', box).addEventListener('change', () => audio.sfx('coin'));
    $('#s-quality', box).addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      st.quality = b.dataset.v; save();
      $$('#s-quality button', box).forEach(x => x.classList.toggle('on', x === b));
      if (stage) { stage.setQuality(st.quality); if (S.state) stage.setPlayers(S.state.players.filter(p => p.online)); else setHomePlayers(); }
    });
    $('#s-motion', box).addEventListener('change', e => {
      st.reduceMotion = e.target.checked; save();
      document.body.classList.toggle('reduce-motion', st.reduceMotion);
      if (stage) stage.reduceMotion = st.reduceMotion;
    });
  });
}

function openCustomModal() {
  const example = '# Una pregunta por línea: Pregunta | Correcta | Incorrecta | Incorrecta | Incorrecta | dificultad (1-5, opcional)\n¿Quién llega siempre tarde al grupo? | Carlos | Ana | Luis | Sofía | 1\n¿En qué ciudad fue nuestro primer viaje juntos? | Cusco | Lima | Arequipa | Puno | 2';
  openModal(`<h2>✏️ Preguntas personalizadas</h2>
    <p class="muted">Escribe una pregunta por línea separando con <b>|</b>: pregunta, respuesta correcta, tres incorrectas y, opcional, la dificultad del 1 al 5. Máximo ${CUSTOM_MAX}.</p>
    <textarea class="input" id="c-text" placeholder="${esc(example)}" spellcheck="false">${esc(S.custom.text)}</textarea>
    <p class="muted small" id="c-count"></p>
    <div class="errors" id="c-errors"></div>
    <div class="over-actions"><button class="btn" id="c-clear">Borrar todo</button><button class="btn btn-go" id="c-save">Guardar</button></div>`, box => {
    const ta = $('#c-text', box);
    const check = () => {
      const { list, errors } = parseCustom(ta.value);
      $('#c-count', box).textContent = `${list.length} pregunta(s) válida(s).`;
      $('#c-errors', box).innerHTML = errors.slice(0, 8).map(esc).join('<br>');
      return list;
    };
    ta.addEventListener('input', check);
    check();
    $('#c-clear', box).onclick = () => { ta.value = ''; check(); };
    $('#c-save', box).onclick = () => {
      const list = check();
      S.custom = { text: ta.value.slice(0, 30000), list };
      if (S.engine) S.engine.setCustom(S.custom);
      if (S.room) S.room.send('custom', S.custom);
      if (list.length && S.state && S.state.settings.customMode === 'off') act({ t: 'settings', patch: { customMode: 'mix' } });
      closeModal();
      toast(list.length ? `✏️ ${list.length} pregunta(s) personalizada(s) listas.` : 'Preguntas personalizadas borradas.');
    };
  });
}

function openReportModal(q) {
  if (!q) return;
  if (q.custom) { toast('Las preguntas personalizadas las escribió el anfitrión: no se reportan.'); return; }
  const reasons = [['incorrecta', 'La respuesta es incorrecta'], ['confusa', 'Está confusa o tiene dos respuestas válidas'], ['repetida', 'Me salió repetida'], ['ofensiva', 'Es ofensiva'], ['otra', 'Otro motivo']];
  openModal(`<h2>⚑ Reportar pregunta</h2>
    <p><b>${esc(q.text)}</b></p>
    <div class="seg" id="r-reason">${reasons.map(([v, l], i) => `<button data-v="${v}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join('')}</div>
    <p><textarea class="input" id="r-note" maxlength="300" placeholder="Cuéntanos qué está mal (opcional)" style="min-height:80px;font-family:inherit"></textarea></p>
    <div class="over-actions"><button class="btn btn-go" id="r-send">Enviar reporte</button></div>`, box => {
    let reason = 'incorrecta';
    $('#r-reason', box).addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      reason = b.dataset.v;
      $$('#r-reason button', box).forEach(x => x.classList.toggle('on', x === b));
    });
    $('#r-send', box).onclick = async () => {
      try { await reportQuestion(q.id, reason, $('#r-note', box).value.trim()); toast('¡Gracias! Revisaremos esa pregunta.'); closeModal(); }
      catch { toast('No se pudo enviar el reporte. Inténtalo más tarde.'); }
    };
  });
}

// ====================================================================
// arranque
// ====================================================================
async function boot() {
  document.body.classList.toggle('reduce-motion', !!profile.settings.reduceMotion);
  try {
    stage = new Stage($('#stage'), { quality: profile.settings.quality });
    stage.reduceMotion = !!profile.settings.reduceMotion;
  } catch (e) {
    console.error(e);
    toast('Tu navegador no pudo iniciar los gráficos 3D. El juego funciona igual, pero sin escenario.', 6000);
  }
  try { studio = new AvatarStudio(); } catch (e) { console.error(e); }
  if (new URLSearchParams(location.search).has('debug')) window.egm = { stage, S, me };
  audio.setVolumes({ music: profile.settings.music, sfx: profile.settings.sfx });
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  bank.load().then(() => { if (S.state && S.state.phase === 'lobby') renderLobby(S.state); });
  initHome();
  initChat();
  initLobbyChatButton();
  initGameUI();
  initPhrases();
  setInterval(() => updateWaiting(performance.now()), 250);
  initModals();
  try { await Promise.race([document.fonts && document.fonts.ready, new Promise(r => setTimeout(r, 1500))]); } catch { /* ignore */ }
  goHome();
  if (stage) stage.setScreen({ top: '¡Bienvenidos a', big: 'EL GRAN MILLÓN', bottom: 'Preguntas en equipo' });
  setTimeout(hideLoader, 250);
  window.addEventListener('pagehide', () => { if (S.room) S.room.leave(); });
}

boot();
