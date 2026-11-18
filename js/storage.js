// Perfil local del jugador: nombre, avatar, ajustes, progreso, desbloqueos y preguntas ya vistas.
import { AVATAR, THEMES, ROLES, HAT_UNLOCKS } from './config.js';

const KEY = 'egm.profile.v1';
const SEEN_KEY = 'egm.seen.v1';
const SEEN_MAX = 1400;

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* modo privado */ } }

const rnd = n => Math.floor(Math.random() * n);

function defaults() {
  return {
    name: '',
    avatar: { color: rnd(AVATAR.colors.length), eyes: rnd(4), mouth: rnd(4), hat: rnd(4) },
    theme: 'gala',
    role: null,
    settings: { music: 0.6, sfx: 0.8, quality: 'auto', reduceMotion: false },
    stats: { games: 0, teamGames: 0, wins: 0, walks: 0, correct: 0, total: 0, bestLevel: 0, bestFrac: 0, bestPrize: 0 },
  };
}

export const profile = (() => {
  const base = defaults();
  try {
    const saved = JSON.parse(safeGet(KEY) || 'null');
    if (saved && typeof saved === 'object') {
      return {
        ...base, ...saved,
        avatar: { ...base.avatar, ...(saved.avatar || {}) },
        settings: { ...base.settings, ...(saved.settings || {}) },
        stats: { ...base.stats, ...(saved.stats || {}) },
      };
    }
  } catch { /* perfil dañado: se usa el por defecto */ }
  return base;
})();

export function saveProfile() { safeSet(KEY, JSON.stringify(profile)); }

// ---- Desbloqueos -------------------------------------------------------
export function isThemeUnlocked(id, p = profile) { const t = THEMES[id]; return !!t && (!t.unlock || t.unlock.test(p)); }
export function isRoleUnlocked(id, p = profile) { const r = ROLES[id]; return !!r && (!r.unlock || r.unlock.test(p)); }
export function isHatUnlocked(idx, p = profile) {
  const id = AVATAR.hats[idx];
  const u = HAT_UNLOCKS[id];
  return !u || u.test(p);
}

function unlockSnapshot(p) {
  return {
    themes: Object.keys(THEMES).filter(id => isThemeUnlocked(id, p)),
    roles: Object.keys(ROLES).filter(id => isRoleUnlocked(id, p)),
    hats: AVATAR.hats.map((_, i) => i).filter(i => isHatUnlocked(i, p)),
  };
}

// Registra el final de una partida y devuelve la lista de cosas recién desbloqueadas.
export function recordGame({ level, len, prize, won, walked, correct, teamSize }) {
  const before = unlockSnapshot(profile);
  const s = profile.stats;
  s.games += 1;
  if (teamSize > 1) s.teamGames += 1;
  if (won) s.wins += 1;
  if (walked) s.walks += 1;
  s.correct += correct;
  s.total += prize;
  s.bestLevel = Math.max(s.bestLevel, level);
  s.bestFrac = Math.max(s.bestFrac, len ? level / len : 0);
  s.bestPrize = Math.max(s.bestPrize, prize);
  saveProfile();
  const after = unlockSnapshot(profile);
  const fresh = [];
  after.themes.filter(x => !before.themes.includes(x)).forEach(id => fresh.push({ kind: 'Estilo', icon: THEMES[id].icon, name: THEMES[id].name }));
  after.roles.filter(x => !before.roles.includes(x)).forEach(id => fresh.push({ kind: 'Rol', icon: ROLES[id].icon, name: ROLES[id].name }));
  after.hats.filter(x => !before.hats.includes(x)).forEach(i => fresh.push({ kind: 'Sombrero', icon: '🎩', name: AVATAR.hatNames[i] }));
  return fresh;
}

// ---- Preguntas vistas ----------------------------------------------------
let seenCache = null;
export function getSeen() {
  if (!seenCache) {
    try { seenCache = JSON.parse(safeGet(SEEN_KEY) || '[]'); } catch { seenCache = []; }
    if (!Array.isArray(seenCache)) seenCache = [];
  }
  return seenCache;
}
export function addSeen(ids) {
  const seen = getSeen();
  const set = new Set(seen);
  for (const id of ids) if (id && !id.startsWith('cus') && !set.has(id)) { seen.push(id); set.add(id); }
  while (seen.length > SEEN_MAX) seen.shift();
  safeSet(SEEN_KEY, JSON.stringify(seen));
}

// ---- Identidad por pestaña ---------------------------------------------
// sessionStorage: cada pestaña es un jugador distinto, y recargar conserva la identidad.
export function myId() {
  let id = null;
  try { id = sessionStorage.getItem('egm.id'); } catch { /* sin sessionStorage */ }
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 16);
    try { sessionStorage.setItem('egm.id', id); } catch { /* ignore */ }
  }
  return id;
}
