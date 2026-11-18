// Valida el banco de preguntas: node tools/validate-questions.mjs [archivo.json ...]
// Sin argumentos valida todos los archivos de data/q/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qdir = path.join(root, 'data', 'q');
const TARGET = { 1: 18, 2: 18, 3: 18, 4: 16, 5: 15 }; // 85 por tema
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]/g, '').replace(/\s+/g, ' ').trim();

const args = process.argv.slice(2);
const all = fs.existsSync(qdir) ? fs.readdirSync(qdir).filter(f => f.endsWith('.json')).map(f => path.join(qdir, f)) : [];
const targets = args.length ? args.map(a => path.resolve(a)) : all;

let errors = 0;
const err = (f, m) => { errors++; console.log(`  ✗ ${path.basename(f)}: ${m}`); };

// Índice global de preguntas para detectar duplicados entre temas.
const global = new Map();
for (const f of all) {
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    (data.q || []).forEach((q, i) => {
      const k = norm(String(q[1] || ''));
      if (!global.has(k)) global.set(k, []);
      global.get(k).push(`${data.id}#${i}`);
    });
  } catch { /* se reporta abajo */ }
}

for (const f of targets) {
  console.log(`• ${path.relative(root, f)}`);
  let data;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { err(f, 'JSON inválido: ' + e.message); continue; }
  if (typeof data.id !== 'string' || data.id.length !== 3) err(f, 'falta "id" de 3 letras');
  if (typeof data.name !== 'string') err(f, 'falta "name"');
  if (!Array.isArray(data.q)) { err(f, 'falta el arreglo "q"'); continue; }
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const seen = new Set();
  data.q.forEach((q, i) => {
    const where = `#${i} (${String(q[1] || '').slice(0, 50)})`;
    if (!Array.isArray(q) || q.length !== 6) return err(f, `${where} debe ser [dificultad, pregunta, correcta, inc1, inc2, inc3]`);
    const [d, text, ...opts] = q;
    if (![1, 2, 3, 4, 5].includes(d)) err(f, `${where} dificultad inválida: ${d}`); else counts[d]++;
    if (typeof text !== 'string' || !text.trim()) return err(f, `${where} pregunta vacía`);
    if (!text.includes('¿') || !text.trim().endsWith('?')) err(f, `${where} la pregunta debe llevar ¿ y terminar en ?`);
    if (text.length > 140) err(f, `${where} pregunta de ${text.length} caracteres (máx. 140)`);
    if (text !== text.trim()) err(f, `${where} espacios sobrantes`);
    opts.forEach((o, j) => {
      if (typeof o !== 'string' || !o.trim()) err(f, `${where} opción ${j} vacía`);
      else if (o.length > 48) err(f, `${where} opción "${o}" de ${o.length} caracteres (máx. 48)`);
      else if (o !== o.trim()) err(f, `${where} opción "${o}" con espacios sobrantes`);
    });
    const n = new Set(opts.map(o => norm(String(o))));
    if (n.size !== 4) err(f, `${where} opciones repetidas`);
    if (opts.some(o => /todas las anteriores|ninguna de las anteriores/i.test(String(o)))) err(f, `${where} no usar «todas/ninguna de las anteriores»`);
    const k = norm(text);
    if (seen.has(k)) err(f, `${where} pregunta duplicada en el mismo tema`);
    seen.add(k);
    const g = global.get(k) || [];
    if (g.some(x => !x.startsWith(data.id + '#'))) err(f, `${where} duplicada en otro tema: ${g.join(', ')}`);
  });
  const total = data.q.length;
  const okCounts = Object.entries(TARGET).every(([d, n]) => counts[d] === n);
  console.log(`  ${total} preguntas · por dificultad 1-5: ${[1, 2, 3, 4, 5].map(d => counts[d]).join('/')} (meta ${Object.values(TARGET).join('/')})`);
  if (!okCounts) err(f, 'el reparto por dificultad no coincide con la meta');
}

console.log(errors ? `\n${errors} problema(s).` : '\nTodo correcto ✓');
process.exit(errors ? 1 : 0);
