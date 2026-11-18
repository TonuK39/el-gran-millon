// Banco de preguntas: carga, selección sin repetir y preguntas personalizadas.
import { CATEGORIES } from './config.js';

const shuffle = arr => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

export class Bank {
  constructor() {
    this.items = []; // {id, cat, d, text, correct, wrong:[3]}
    this.byId = new Map();
    this.loaded = false;
    this.loading = null;
  }

  load() {
    if (this.loading) return this.loading;
    const base = new URL('../data/q/', import.meta.url);
    this.loading = Promise.all(CATEGORIES.map(async c => {
      try {
        const res = await fetch(new URL(`${c.id}.json`, base));
        if (!res.ok) return;
        const data = await res.json();
        (data.q || []).forEach((q, i) => {
          const item = { id: `${c.id}${i}`, cat: c.id, d: q[0], text: q[1], correct: q[2], wrong: [q[3], q[4], q[5]] };
          this.items.push(item);
          this.byId.set(item.id, item);
        });
      } catch (e) { console.warn('No se pudo cargar el tema', c.id, e); }
    })).then(() => { this.loaded = true; return this; });
    return this.loading;
  }

  countFor(cats) {
    const s = new Set(cats);
    return this.items.filter(q => s.has(q.cat)).length;
  }

  // Elige una pregunta de dificultad d evitando las usadas en la partida y las ya vistas por el equipo.
  pick({ cats, d, used, seenCount, lastCat, pool = null }) {
    const source = pool || this.items;
    const catSet = new Set(cats);
    let cands = source.filter(q => (pool || catSet.has(q.cat)) && !used.has(q.id));
    if (!cands.length) return null;
    // Dificultad exacta; si no hay, la más cercana.
    let best = Infinity;
    for (const q of cands) best = Math.min(best, Math.abs(q.d - d));
    cands = cands.filter(q => Math.abs(q.d - d) === best);
    // Menos vistas por el equipo primero.
    let minSeen = Infinity;
    for (const q of cands) minSeen = Math.min(minSeen, seenCount(q.id));
    cands = cands.filter(q => seenCount(q.id) === minSeen);
    // Variedad: evita repetir el tema anterior si hay alternativas.
    const varied = cands.filter(q => q.cat !== lastCat);
    if (varied.length) cands = varied;
    return cands[Math.floor(Math.random() * cands.length)];
  }
}

// Convierte un ítem del banco en la pregunta que se juega: opciones barajadas e índice correcto.
export function toPlayable(item) {
  const opts = shuffle([item.correct, ...item.wrong]);
  return {
    q: { id: item.id, text: item.text, opts, cat: item.cat, d: item.d, custom: item.id.startsWith('cus') },
    answer: opts.indexOf(item.correct),
  };
}

// Formato: «Pregunta | Correcta | Incorrecta 1 | Incorrecta 2 | Incorrecta 3 | dificultad(1-5, opcional)»
export const CUSTOM_MAX = 120;
export function parseCustom(text) {
  const list = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 5) { errors.push(`Línea ${n + 1}: faltan opciones (usa 5 partes separadas por |)`); return; }
    const [q, c, w1, w2, w3, dRaw] = parts;
    if (!q || !c || !w1 || !w2 || !w3) { errors.push(`Línea ${n + 1}: hay un campo vacío`); return; }
    if (new Set([c, w1, w2, w3].map(s => s.toLowerCase())).size < 4) { errors.push(`Línea ${n + 1}: opciones repetidas`); return; }
    let d = parseInt(dRaw, 10);
    if (!(d >= 1 && d <= 5)) d = 0;
    let text = q.slice(0, 160);
    if (!/[?¿]/.test(text)) text = text + '?';
    if (!text.includes('¿') && text.endsWith('?')) text = '¿' + text;
    list.push({ text, correct: c.slice(0, 60), wrong: [w1, w2, w3].map(s => s.slice(0, 60)), d });
  });
  if (list.length > CUSTOM_MAX) { errors.push(`Máximo ${CUSTOM_MAX} preguntas: se usan las primeras ${CUSTOM_MAX}.`); list.length = CUSTOM_MAX; }
  // Dificultad automática para las que no la traen: reparto en orden de aparición.
  const auto = list.filter(x => !x.d);
  auto.forEach((x, i) => { x.d = 1 + Math.floor((i * 5) / Math.max(1, auto.length)); });
  list.forEach((x, i) => { x.id = `cus${i}`; x.cat = 'cus'; });
  return { list, errors };
}
