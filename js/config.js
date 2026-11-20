// Configuración general de El Gran Millón.
// La clave publicable de Supabase es pública por diseño: la seguridad la ponen las políticas RLS.
export const SUPABASE_URL = 'https://bejwavjtinwxfhhxwepc.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_dm8Q2WACLEGgqhGVVe5cOQ_x7gJzw3j';

export const MAX_PLAYERS = 4;
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const CATEGORIES = [
  { id: 'gen', name: 'Cultura general', icon: '💡' },
  { id: 'his', name: 'Historia', icon: '🏛️' },
  { id: 'geo', name: 'Geografía', icon: '🌎' },
  { id: 'cie', name: 'Ciencia y naturaleza', icon: '🔬' },
  { id: 'cin', name: 'Cine y series', icon: '🎬' },
  { id: 'mus', name: 'Música', icon: '🎵' },
  { id: 'dep', name: 'Deportes', icon: '⚽' },
  { id: 'vid', name: 'Videojuegos', icon: '🎮' },
  { id: 'tec', name: 'Tecnología e internet', icon: '💻' },
  { id: 'art', name: 'Arte y literatura', icon: '🎨' },
  { id: 'com', name: 'Comida y bebida', icon: '🍕' },
  { id: 'lat', name: 'Latinoamérica', icon: '🌮' },
];
export const CAT_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

// Escaleras de premios (monedas ficticias).
export const LADDERS = {
  10: [500, 1000, 2500, 5000, 10000, 25000, 50000, 125000, 400000, 1000000],
  15: [100, 250, 500, 1000, 2500, 5000, 10000, 20000, 40000, 75000, 125000, 250000, 400000, 600000, 1000000],
  20: [100, 200, 300, 500, 1000, 2000, 3500, 5000, 7500, 10000, 15000, 25000, 40000, 60000, 90000, 150000, 250000, 400000, 650000, 1000000],
};

// Devuelve los índices (0-based) de los escalones seguros.
export function safeLevels(len, mode) {
  if (mode === 'ninguno') return [];
  if (mode === 'uno') return [Math.floor(len / 2) - 1];
  return [Math.floor(len / 3) - 1, Math.floor((2 * len) / 3) - 1];
}

export const TIME_OPTIONS = [15, 30, 45, 60, 0]; // 0 = sin límite
export const DIFFICULTIES = [
  { id: 'facil', name: 'Fácil' },
  { id: 'normal', name: 'Normal' },
  { id: 'dificil', name: 'Difícil' },
];
export const SAFE_MODES = [
  { id: 'clasico', name: '2 seguros' },
  { id: 'uno', name: '1 seguro' },
  { id: 'ninguno', name: 'Todo o nada' },
];

// Dificultad (1-5) de la pregunta según el escalón.
export function levelDifficulty(i, len, diff) {
  let d = 1 + Math.floor((i * 5) / len);
  if (diff === 'facil' && i >= len / 3) d -= 1;
  if (diff === 'dificil' && i >= 2) d += 1;
  return Math.max(1, Math.min(5, d));
}

export const BASE_ROLES = ['sabio', 'influencer', 'hacker', 'suertudo'];
export const ROLES = {
  sabio: { name: 'El Sabio', icon: '🦉', power: 'Mitad', desc: 'Elimina dos respuestas incorrectas.' },
  influencer: { name: 'La Influencer', icon: '📱', power: 'Encuesta', desc: 'El público vota y ven los porcentajes.' },
  hacker: { name: 'El Hacker', icon: '🕶️', power: 'Cambiar pregunta', desc: 'Cambia la pregunta por otra del mismo nivel.' },
  suertudo: { name: 'El Suertudo', icon: '🍀', power: 'Doble intento', desc: 'Actívalo antes de responder: si fallan, tienen otra oportunidad.' },
  profesora: {
    name: 'La Profesora', icon: '📚', power: 'Pista experta', desc: 'Dice qué respuesta cree correcta y qué tan segura está.',
    unlock: { text: 'Acumula $500,000 en total', test: p => p.stats.total >= 500000 },
  },
  crono: {
    name: 'El Cronometrista', icon: '⏱️', power: 'Tiempo extra', desc: 'Suma 30 segundos al reloj.',
    unlock: { text: 'Llega a la pregunta 7 en una partida', test: p => p.stats.bestLevel >= 7 },
  },
};

export const THEMES = {
  gala: { name: 'Gala neón', icon: '✨', desc: 'Estudio de TV nocturno con focos y confeti.' },
  juguete: {
    name: 'Juguetería', icon: '🧸', desc: 'Plató de colores caramelo, globos y nubes.',
    unlock: { text: 'Completa 3 partidas', test: p => p.stats.games >= 3 },
  },
  synth: {
    name: 'Arcade synthwave', icon: '🕹️', desc: 'Rejilla neón, sol retro y montañas de los 80.',
    unlock: { text: 'Llega a 2/3 de la escalera', test: p => p.stats.bestFrac >= 2 / 3 },
  },
  torre: {
    name: 'Torre del tesoro', icon: '🏝️', desc: 'Isla flotante y una torre que suben piso a piso.',
    unlock: { text: 'Gana el millón o acumula $3,000,000', test: p => p.stats.wins > 0 || p.stats.total >= 3000000 },
  },
};

export const AVATAR = {
  colors: ['#ff4d6d', '#ff8a3d', '#ffd23f', '#7bd389', '#2ec4b6', '#3a86ff', '#8b5cf6', '#f15bb5', '#b5651d', '#f1f1f1', '#454545', '#00c2ff'],
  colorNames: ['Rojo', 'Naranja', 'Amarillo', 'Verde', 'Turquesa', 'Azul', 'Violeta', 'Rosa', 'Café', 'Blanco', 'Gris', 'Celeste'],
  eyes: ['normal', 'feliz', 'sorpresa', 'dormido', 'guino', 'lentes'],
  eyeNames: ['Normales', 'Felices', 'Sorpresa', 'Dormilón', 'Guiño', 'Lentes'],
  mouths: ['sonrisa', 'abierta', 'neutra', 'lengua', 'dientes', 'o'],
  mouthNames: ['Sonrisa', 'Carcajada', 'Seria', 'Lengua', 'Dientes', 'Asombro'],
  hats: ['ninguno', 'fiesta', 'gorra', 'gorro', 'chistera', 'auriculares', 'mago', 'corona'],
  hatNames: ['Sin sombrero', 'Fiesta', 'Gorra', 'Gorro', 'Chistera', 'Audífonos', 'Mago', 'Corona'],
};

export const HAT_UNLOCKS = {
  chistera: { text: 'Alcanza el primer seguro', test: p => p.stats.bestFrac >= 1 / 3 },
  auriculares: { text: 'Juega 3 partidas en equipo', test: p => p.stats.teamGames >= 3 },
  mago: { text: 'Juega 10 partidas', test: p => p.stats.games >= 10 },
  corona: { text: 'Gana el millón', test: p => p.stats.wins > 0 },
};

// Frases rápidas: salen como globo sobre tu avatar (se envía solo el índice).
export const QUICK_PHRASES = [
  '¡Es la A!', '¡Es la B!', '¡Es la C!', '¡Es la D!', 'Ni idea 😅', 'Confía en mí 😎',
  '¡Usemos un comodín!', 'Mejor plantarnos 🏳️', '¡Rápido, confirma! ⏰', '¡Bien jugado! 👏', 'Uy, casi 😬', '¡Vamos por el millón! 💰',
];

export const REACTIONS = ['👏', '😂', '😱', '🤔', '🔥', '😭', '🙏', '💯'];

// Nombres de equipo automáticos: «Los Ajolotes Atómicos», «Las Llamas Listas»…
const TEAM_ANIMALS = [
  ['Búhos', 'm'], ['Llamas', 'f'], ['Tucanes', 'm'], ['Jaguares', 'm'], ['Pulpos', 'm'], ['Capibaras', 'f'], ['Ajolotes', 'm'],
  ['Iguanas', 'f'], ['Panteras', 'f'], ['Ardillas', 'f'], ['Coyotes', 'm'], ['Zorros', 'm'], ['Delfines', 'm'], ['Colibríes', 'm'],
  ['Tortugas', 'f'], ['Abejas', 'f'], ['Tlacuaches', 'm'], ['Quetzales', 'm'], ['Mapaches', 'm'], ['Nutrias', 'f'], ['Gallinas', 'f'],
];
const TEAM_ADJ = [
  ['Sabios', 'Sabias'], ['Listos', 'Listas'], ['Veloces', 'Veloces'], ['Geniales', 'Geniales'], ['Atómicos', 'Atómicas'],
  ['Cósmicos', 'Cósmicas'], ['Galácticos', 'Galácticas'], ['Ingeniosos', 'Ingeniosas'], ['Imparables', 'Imparables'],
  ['Brillantes', 'Brillantes'], ['Legendarios', 'Legendarias'], ['Millonarios', 'Millonarias'], ['Curiosos', 'Curiosas'],
  ['Valientes', 'Valientes'], ['Eléctricos', 'Eléctricas'], ['Turbo', 'Turbo'], ['Furiosos', 'Furiosas'], ['Mágicos', 'Mágicas'],
];
export function randomTeamName() {
  const [animal, g] = TEAM_ANIMALS[Math.floor(Math.random() * TEAM_ANIMALS.length)];
  const adj = TEAM_ADJ[Math.floor(Math.random() * TEAM_ADJ.length)];
  return `${g === 'm' ? 'Los' : 'Las'} ${animal} ${g === 'm' ? adj[0] : adj[1]}`;
}

export function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('es-MX');
}
