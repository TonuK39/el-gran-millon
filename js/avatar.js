// Avatares 3D low-poly de El Gran Millón: construcción, animación y estudio de miniaturas.
// API: buildAvatar(cfg), setAvatarAnim(av, name), updateAvatar(av, dt, t), disposeAvatar(av), AvatarStudio.
// El origen del avatar está a los pies (y = 0), mira hacia +Z y mide ≈ 2,1 de alto sin sombrero.
import * as THREE from 'three';
import { AVATAR } from './config.js';

const TAU = Math.PI * 2;
const PI = Math.PI;
const S = Math.sin;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- proporciones ----------
const HEAD_R = 0.56;
const HIP_Y = 0.14;
const TORSO_H = 0.95, TORSO_RT = 0.36, TORSO_RB = 0.48;
const HEAD_C = 0.42;                       // centro de la cabeza sobre el cuello (tope del torso)
const SHOULDER_X = 0.36, SHOULDER_Y = 0.86;
const UPPER = 0.3, FORE = 0.3, HAND_R = 0.12;
const FOOT_X = 0.2, FOOT_Y = 0.075, FOOT_Z = 0.08;
const EYE_X = 0.205, EYE_Y = -0.01, MOUTH_Y = -0.235, BLUSH_X = 0.335, BLUSH_Y = -0.17;
const HEAD_IN_HIPS = TORSO_H + HEAD_C;    // altura del centro de la cabeza en el espacio de la cadera

// Color de acento (sombreros) elegido para contrastar con cada color de cuerpo.
const ACCENTS = ['#3a86ff', '#2a9df4', '#ff4d6d', '#ff5d8f', '#ff8a3d', '#ff4d6d', '#ffd23f', '#2ec4b6', '#2ec4b6', '#ff4d6d', '#ffd23f', '#ff8a3d'];

const ANIMS = ['idle', 'think', 'happy', 'sad', 'wave', 'dance', 'vote'];
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const WHITE = new THREE.Color(1, 1, 1);

// ---------- configuración ----------
function wrapIdx(v, n) {
  const k = Math.trunc(Number(v));
  if (!Number.isFinite(k)) return 0;
  return ((k % n) + n) % n;
}
function normCfg(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return {
    color: wrapIdx(c.color, AVATAR.colors.length),
    eyes: wrapIdx(c.eyes, AVATAR.eyes.length),
    mouth: wrapIdx(c.mouth, AVATAR.mouths.length),
    hat: wrapIdx(c.hat, AVATAR.hats.length),
  };
}
const cfgKey = c => `${c.color}.${c.eyes}.${c.mouth}.${c.hat}`;

// ---------- geometrías compartidas (caché a nivel de módulo; nunca se liberan) ----------
const GEO = new Map();
function geo(key, make) {
  let g = GEO.get(key);
  if (!g) { g = make(); GEO.set(key, g); }
  return g;
}
const unitSphere = () => geo('sph', () => new THREE.SphereGeometry(1, 20, 14));
const unitIco = () => geo('ico1', () => new THREE.IcosahedronGeometry(1, 1));
const headGeo = () => geo('head', () => new THREE.IcosahedronGeometry(HEAD_R, 1));

// Curva una geometría plana (en XY, grosor en Z) para que abrace la esfera de la cabeza.
function bend(g, r = HEAD_R) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    p.setZ(i, p.getZ(i) - (x * x + y * y) / (2 * r));
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
function extrude(shapes, depth, curveSegments = 10) {
  const g = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments });
  g.translate(0, 0, -depth / 2);
  return bend(g);
}

// ---------- formas 2D ----------
function ellipseShape(cx, cy, rx, ry) {
  const s = new THREE.Shape();
  s.absellipse(cx, cy, rx, ry, 0, TAU, false);
  return s;
}
function roundRect(cx, cy, w, h, r, rb = r) {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  const s = new THREE.Shape();
  s.moveTo(x0 + rb, y0);
  s.lineTo(x1 - rb, y0);
  s.absarc(x1 - rb, y0 + rb, rb, -PI / 2, 0, false);
  s.lineTo(x1, y1 - r);
  s.absarc(x1 - r, y1 - r, r, 0, PI / 2, false);
  s.lineTo(x0 + r, y1);
  s.absarc(x0 + r, y1 - r, r, PI / 2, PI, false);
  s.lineTo(x0, y0 + rb);
  s.absarc(x0 + rb, y0 + rb, rb, PI, PI * 1.5, false);
  return s;
}
// Trazo grueso en arco con puntas redondeadas (sonrisas, ojos cerrados).
function arcStroke(cx, cy, r, a0, a1, w) {
  const s = new THREE.Shape();
  s.absarc(cx, cy, r + w / 2, a0, a1, false);
  s.absarc(cx + r * Math.cos(a1), cy + r * Math.sin(a1), w / 2, a1, a1 + PI, false);
  s.absarc(cx, cy, r - w / 2, a1, a0, true);
  s.absarc(cx + r * Math.cos(a0), cy + r * Math.sin(a0), w / 2, a0 + PI, a0 + TAU, false);
  return s;
}
// Boca en forma de «D»: borde superior casi recto y fondo redondo.
function dShape(w, h, top, curve = 0) {
  const s = new THREE.Shape();
  s.moveTo(-w, top);
  if (curve) s.quadraticCurveTo(0, top - curve, w, top); else s.lineTo(w, top);
  s.absellipse(0, top, w, h, 0, PI, true);
  return s;
}
// Lengua dentro de una boca en «D», por debajo de yCut.
function tongueInD(w, h, top, yCut, dip) {
  const a = w - 0.022, b = h - 0.022;
  const tR = Math.asin(clamp((yCut - top) / b, -1, 0));
  const tL = -PI - tR;
  const s = new THREE.Shape();
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const t = tR + (tL - tR) * i / N;
    const x = a * Math.cos(t), y = top + b * Math.sin(t);
    if (i) s.lineTo(x, y); else s.moveTo(x, y);
  }
  const xl = a * Math.cos(tL), y0 = top + b * Math.sin(tL);
  s.quadraticCurveTo(xl * 0.5, y0 + dip * 0.7, 0, y0 - dip * 0.3);
  s.quadraticCurveTo(-xl * 0.5, y0 + dip * 0.7, -xl, y0);
  return s;
}
function starShape(ro, ri) {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = PI / 2 + i * PI / 5, r = i % 2 ? ri : ro;
    if (i) s.lineTo(Math.cos(a) * r, Math.sin(a) * r); else s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  return s;
}

// Reordena triángulos en dos grupos de material (rayas de sombreros).
function stripeGroups(g0, fn) {
  const g = g0.index ? g0.toNonIndexed() : g0;
  const pos = g.attributes.position;
  const nTri = pos.count / 3;
  const lists = [[], []];
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let t = 0; t < nTri; t++) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(v.fromBufferAttribute(pos, t * 3 + k));
    c.divideScalar(3);
    lists[fn(c) ? 1 : 0].push(t);
  }
  const out = new Float32Array(pos.count * 3);
  let o = 0;
  for (const list of lists) for (const t of list) for (let k = 0; k < 3; k++) {
    const i = t * 3 + k;
    out[o++] = pos.getX(i); out[o++] = pos.getY(i); out[o++] = pos.getZ(i);
  }
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.BufferAttribute(out, 3));
  ng.addGroup(0, lists[0].length * 3, 0);
  ng.addGroup(lists[0].length * 3, lists[1].length * 3, 1);
  ng.computeVertexNormals();
  return ng;
}
// Colores de vértice en escala de grises por triángulo (tejido acanalado).
function shadeFaces(g0, fn) {
  const g = g0.index ? g0.toNonIndexed() : g0;
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let t = 0; t < pos.count / 3; t++) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(v.fromBufferAttribute(pos, t * 3 + k));
    c.divideScalar(3);
    const f = fn(c);
    for (let k = 0; k < 9; k++) col[t * 9 + k] = f;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// ---------- superficie de la cabeza ----------
let HEAD_TRIS = null;
const _ray = new THREE.Ray();
const _hit = new THREE.Vector3();
function headDist(dir) {
  if (!HEAD_TRIS) {
    const g = headGeo(), p = g.attributes.position, idx = g.index;
    const n = idx ? idx.count : p.count;
    HEAD_TRIS = [];
    for (let i = 0; i < n; i += 3) {
      const tri = [];
      for (let k = 0; k < 3; k++) tri.push(new THREE.Vector3().fromBufferAttribute(p, idx ? idx.getX(i + k) : i + k));
      HEAD_TRIS.push(tri);
    }
  }
  _ray.origin.set(0, 0, 0);
  _ray.direction.copy(dir);
  for (const [a, b, c] of HEAD_TRIS) if (_ray.intersectTriangle(a, b, c, false, _hit)) return _hit.length();
  return HEAD_R;
}
function dirFor(x, y) {
  return new THREE.Vector3(x, y, Math.sqrt(Math.max(1e-4, HEAD_R * HEAD_R - x * x - y * y))).normalize();
}
// Coloca un grupo sobre la superficie real de la cabeza (en coordenadas del centro de la cabeza),
// orientado hacia fuera. Con hw/hh calcula cuánto elevarlo para que una pieza curvada no se hunda.
function placeOnHead(obj, x, y, hw = 0, hh = 0) {
  const n = dirFor(x, y);
  const C = n.clone().multiplyScalar(headDist(n));
  obj.quaternion.setFromUnitVectors(Z_AXIS, n);
  let lift = 0;
  if (hw > 0) {
    const t1 = new THREE.Vector3(1, 0, 0).applyQuaternion(obj.quaternion);
    const t2 = new THREE.Vector3(0, 1, 0).applyQuaternion(obj.quaternion);
    const P = new THREE.Vector3(), D = new THREE.Vector3();
    for (const [u, v] of [[hw, 0], [-hw, 0], [0, hh], [0, -hh], [hw * 0.7, hh * 0.7], [-hw * 0.7, hh * 0.7], [hw * 0.7, -hh * 0.7], [-hw * 0.7, -hh * 0.7], [hw * 0.5, 0], [-hw * 0.5, 0]]) {
      P.copy(C).addScaledVector(t1, u).addScaledVector(t2, v);
      D.copy(P).normalize();
      const s = headDist(D);
      const h = D.multiplyScalar(s).sub(C).dot(n);   // altura de la superficie respecto al plano tangente
      const back = -(u * u + v * v) / (2 * HEAD_R);    // dónde queda la pieza curvada
      lift = Math.max(lift, h - back);
    }
  }
  obj.position.copy(C).addScaledVector(n, lift);
  return obj;
}

// ---------- materiales por avatar ----------
function lumaOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
function materialSet(ci) {
  const list = [];
  const made = {};
  const hex = AVATAR.colors[ci];
  const base = new THREE.Color(hex);
  const dark = lumaOf(hex) < 0.36;
  const headCol = base.clone().lerp(WHITE, 0.12);
  const accent = new THREE.Color(ACCENTS[ci % ACCENTS.length]);
  const accentIsYellow = ACCENTS[ci % ACCENTS.length] === '#ffd23f';
  const std = p => { const m = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0, flatShading: true, ...p }); list.push(m); return m; };
  const smooth = p => std({ flatShading: false, ...p });
  const basic = color => { const m = new THREE.MeshBasicMaterial({ color }); list.push(m); return m; };
  const defs = {
    body: () => std({ color: base }),
    head: () => std({ color: headCol }),
    hand: () => std({ color: headCol }),
    foot: () => std({ color: base.clone().multiplyScalar(dark ? 0.8 : 0.72) }),
    belly: () => std({ color: base.clone().lerp(new THREE.Color('#fff6e4'), dark ? 0.22 : 0.42) }),
    blush: () => smooth({ color: headCol.clone().lerp(new THREE.Color('#ff5c8a'), dark ? 0.4 : 0.5), roughness: 0.85 }),
    ink: () => smooth({ color: dark ? '#fff4ea' : '#2b1d36', roughness: 0.5 }),
    eyeLine: () => smooth({ color: '#1d1630', roughness: 0.5 }),
    sclera: () => smooth({ color: '#ffffff', roughness: 0.3 }),
    pupil: () => smooth({ color: '#151022', roughness: 0.25 }),
    shine: () => basic('#ffffff'),
    lid: () => smooth({ color: headCol, side: THREE.DoubleSide }),
    mouth: () => smooth({ color: '#6e1027', roughness: 0.6 }),
    tongue: () => smooth({ color: '#ff6f86', roughness: 0.55 }),
    tongueLine: () => smooth({ color: '#d4415f', roughness: 0.55 }),
    teeth: () => smooth({ color: '#ffffff', roughness: 0.35 }),
    lens: () => smooth({ color: '#14121c', roughness: 0.22, metalness: 0.35 }),
    accent: () => std({ color: accent }),
    accentDark: () => std({ color: accent.clone().multiplyScalar(0.6) }),
    accentKnit: () => std({ color: accent, vertexColors: true, roughness: 0.85 }),
    cuffKnit: () => std({ color: accent.clone().lerp(WHITE, 0.3), vertexColors: true, roughness: 0.85 }),
    partyB: () => std({ color: accentIsYellow ? '#ffffff' : '#ffe066' }),
    pompom: () => std({ color: '#fffaf0', roughness: 0.9 }),
    topHat: () => std({ color: '#25232f', roughness: 0.42 }),
    hatBand: () => std({ color: '#e63946' }),
    wizard: () => std({ color: '#4b2ca0', roughness: 0.65 }),
    gold: () => std({ color: '#ffc83d', metalness: 0.45, roughness: 0.3, emissive: '#6b4300', emissiveIntensity: 0.35 }),
    goldDouble: () => std({ color: '#ffc83d', metalness: 0.45, roughness: 0.3, emissive: '#6b4300', emissiveIntensity: 0.35, side: THREE.DoubleSide }),
    gemR: () => std({ color: '#ff2e63', roughness: 0.15, emissive: '#5a0016', emissiveIntensity: 0.4 }),
    gemB: () => std({ color: '#2f80ff', roughness: 0.15, emissive: '#00205a', emissiveIntensity: 0.4 }),
    gemG: () => std({ color: '#21d07a', roughness: 0.15, emissive: '#004a22', emissiveIntensity: 0.4 }),
    phones: () => std({ color: '#2b2d42', roughness: 0.5 }),
    phoneCap: () => std({ color: '#f4f4f4', roughness: 0.5 }),
  };
  const get = k => made[k] || (made[k] = defs[k]());
  return { get, list, dark };
}

function mesh(g, m) {
  const o = new THREE.Mesh(g, m);
  o.castShadow = true;
  return o;
}
function ell(m, rx, ry, rz, x = 0, y = 0, z = 0) {
  const o = mesh(unitSphere(), m);
  o.scale.set(rx, ry, rz);
  o.position.set(x, y, z);
  return o;
}

// ---------- ojos ----------
function openEye(parent, M, R, o) {
  const eye = new THREE.Group();
  parent.add(eye);
  eye.add(ell(M.get('eyeLine'), o.rx + 0.02, o.ry + 0.02, o.rz * 0.7, 0, 0, -0.012));
  eye.add(ell(M.get('sclera'), o.rx, o.ry, o.rz));
  const pg = new THREE.Group();
  pg.position.set(0, o.py0, 0);
  eye.add(pg);
  const pz = o.rz * 0.78;
  pg.add(ell(M.get('pupil'), o.prx, o.pry, o.prz, 0, 0, pz));
  pg.add(ell(M.get('shine'), o.sh, o.sh, o.sh * 0.5, o.prx * 0.4, o.pry * 0.42, pz + o.prz * 0.85));
  R.pupils.push({ obj: pg, x: 0, y: o.py0, mx: o.mx, my: o.my });
  R.blinkers.push(eye);
  return eye;
}
const EYE_NORMAL = { rx: 0.095, ry: 0.118, rz: 0.054, prx: 0.062, pry: 0.074, prz: 0.03, py0: -0.012, sh: 0.024, mx: 0.026, my: 0.03 };
const EYE_BIG = { rx: 0.128, ry: 0.134, rz: 0.058, prx: 0.042, pry: 0.046, prz: 0.024, py0: 0, sh: 0.016, mx: 0.055, my: 0.055 };
const EYE_SLEEPY = { rx: 0.1, ry: 0.105, rz: 0.06, prx: 0.058, pry: 0.055, prz: 0.028, py0: -0.045, sh: 0.016, mx: 0.03, my: 0.004 };

function closedArc(M, r = 0.078) {
  return mesh(geo('arcEye' + r, () => extrude(arcStroke(0, -0.03, r, 0.28, PI - 0.28, 0.034), 0.04)), M.get('ink'));
}

function buildEyes(kind, M, R) {
  const g = new THREE.Group();
  if (kind === 'lentes') { buildGlasses(g, M); return g; }
  for (const side of [-1, 1]) {
    const k = kind === 'guino' ? (side > 0 ? 'wink' : 'normal') : kind;
    const slot = new THREE.Group();
    g.add(slot);
    if (k === 'feliz' || k === 'wink') {
      placeOnHead(slot, side * EYE_X, EYE_Y, 0.11, 0.07);
      const a = closedArc(M, k === 'wink' ? 0.072 : 0.08);
      if (k === 'wink') a.scale.set(1.05, 0.8, 1);
      slot.add(a);
      continue;
    }
    placeOnHead(slot, side * EYE_X, EYE_Y);
    if (k === 'normal') openEye(slot, M, R, EYE_NORMAL);
    else if (k === 'sorpresa') openEye(slot, M, R, EYE_BIG);
    else if (k === 'dormido') {
      const o = EYE_SLEEPY;
      const eye = openEye(slot, M, R, o);
      const cut = -0.022;
      const lid = mesh(geo('lid', () => new THREE.SphereGeometry(1, 20, 8, 0, TAU, 0, PI / 2)), M.get('lid'));
      lid.scale.set(o.rx + 0.014, o.ry + 0.03, o.rz + 0.034);
      lid.position.y = cut;
      eye.add(lid);
      const lash = mesh(geo('lash', () => extrude(roundRect(0, 0, 2 * (o.rx + 0.02), 0.026, 0.013), 0.03)), M.get('ink'));
      lash.position.set(0, cut, o.rz + 0.026);
      eye.add(lash);
    }
  }
  return g;
}

function buildGlasses(g, M) {
  const lensGeo = geo('lens', () => extrude(roundRect(0, 0, 0.27, 0.18, 0.045, 0.08), 0.036));
  const rimGeo = geo('lensRim', () => extrude(roundRect(0, 0, 0.305, 0.215, 0.06, 0.095), 0.03));
  const glintGeo = geo('glint', () => extrude([
    new THREE.Shape([new THREE.Vector2(-0.072, 0.064), new THREE.Vector2(-0.044, 0.064), new THREE.Vector2(-0.082, -0.02), new THREE.Vector2(-0.11, -0.02)]),
    new THREE.Shape([new THREE.Vector2(-0.032, 0.064), new THREE.Vector2(-0.02, 0.064), new THREE.Vector2(-0.046, 0.006), new THREE.Vector2(-0.058, 0.006)]),
  ], 0.012));
  for (const side of [-1, 1]) {
    const slot = new THREE.Group();
    placeOnHead(slot, side * 0.2, EYE_Y + 0.005, 0.15, 0.1);
    g.add(slot);
    if (M.dark) { const rim = mesh(rimGeo, M.get('ink')); rim.position.z = -0.006; slot.add(rim); }
    slot.add(mesh(lensGeo, M.get('lens')));
    const gl = mesh(glintGeo, M.get('shine'));
    gl.position.z = 0.02;
    slot.add(gl);
  }
  const bridge = new THREE.Group();
  placeOnHead(bridge, 0, EYE_Y + 0.045, 0.08, 0.02);
  bridge.add(mesh(geo('bridge', () => extrude(roundRect(0, 0, 0.17, 0.036, 0.018), 0.03)), M.get('lens')));
  g.add(bridge);
  // patillas hacia las orejas
  const armGeo = geo('glassArm', () => new THREE.TorusGeometry(HEAD_R - 0.006, 0.018, 5, 8, 0.8));
  for (const side of [-1, 1]) {
    const piv = new THREE.Group();
    piv.position.y = EYE_Y + 0.05;
    piv.rotation.y = side > 0 ? -0.13 : -(PI - 0.93);
    const a = mesh(armGeo, M.get('lens'));
    a.rotation.x = PI / 2;
    piv.add(a);
    g.add(piv);
  }
}

// ---------- bocas ----------
function buildMouth(kind, M) {
  const slot = new THREE.Group();
  const ink = M.get('ink');
  let hw = 0.13, hh = 0.08;
  const add = (g, m, z = 0) => { const o = mesh(g, m); o.position.z = z; slot.add(o); return o; };
  switch (kind) {
    case 'sonrisa':
      add(geo('m_smile', () => extrude(arcStroke(0, 0.07, 0.11, PI + 0.5, TAU - 0.5, 0.042), 0.04)), ink);
      hw = 0.13; hh = 0.07;
      break;
    case 'abierta': {
      const w = 0.15, h = 0.165, top = 0.07;
      add(geo('m_openOut', () => extrude(dShape(w + 0.024, h + 0.026, top + 0.016, 0.03), 0.034)), ink, -0.006);
      add(geo('m_open', () => extrude(dShape(w, h, top, 0.03), 0.04)), M.get('mouth'));
      add(geo('m_openTongue', () => extrude(tongueInD(w, h, top, top - 0.105, 0.02), 0.04)), M.get('tongue'), 0.006);
      hw = 0.17; hh = 0.12;
      break;
    }
    case 'neutra':
      add(geo('m_flat', () => extrude(roundRect(0, 0.0, 0.17, 0.042, 0.021), 0.04)), ink);
      hw = 0.1; hh = 0.03;
      break;
    case 'lengua': {
      add(geo('m_tongueOut', () => extrude((() => {
        const s = new THREE.Shape();
        const cx = 0.035, wt = 0.058;
        s.moveTo(cx - wt, 0.0);
        s.lineTo(cx - wt, -0.07);
        s.absarc(cx, -0.07, wt, PI, TAU, false);
        s.lineTo(cx + wt, 0.0);
        s.lineTo(cx - wt, 0.0);
        return s;
      })(), 0.06)), M.get('tongue'));
      add(geo('m_tongueLine', () => extrude(roundRect(0.035, -0.08, 0.014, 0.08, 0.007), 0.03)), M.get('tongueLine'), 0.018);
      add(geo('m_smile2', () => extrude(arcStroke(0, 0.075, 0.11, PI + 0.5, TAU - 0.5, 0.042), 0.04)), ink, 0.014);
      hw = 0.13; hh = 0.1;
      break;
    }
    case 'dientes': {
      const w = 0.17, h = 0.135, top = 0.06;
      add(geo('m_grinOut', () => extrude(dShape(w + 0.024, h + 0.026, top + 0.016, 0), 0.034)), ink, -0.006);
      add(geo('m_grin', () => extrude(dShape(w, h, top, 0), 0.04)), M.get('mouth'));
      add(geo('m_grinTongue', () => extrude(tongueInD(w, h, top, top - 0.095, 0.015), 0.04)), M.get('tongue'), 0.006);
      add(geo('m_teeth', () => extrude([-0.096, -0.032, 0.032, 0.096].map(x => roundRect(x, top - 0.034, 0.058, 0.054, 0.008, 0.016)), 0.04)), M.get('teeth'), 0.008);
      hw = 0.19; hh = 0.1;
      break;
    }
    case 'o':
    default:
      add(geo('m_oOut', () => extrude(ellipseShape(0, 0, 0.07, 0.085), 0.034)), ink, -0.004);
      add(geo('m_o', () => extrude(ellipseShape(0, 0, 0.047, 0.061), 0.04)), M.get('mouth'), 0.004);
      hw = 0.075; hh = 0.09;
      break;
  }
  placeOnHead(slot, 0, MOUTH_Y, hw, hh);
  return slot;
}

// ---------- sombreros (en coordenadas del centro de la cabeza) ----------
function buildHat(kind, M) {
  const g = new THREE.Group();
  const piv = new THREE.Group();
  g.add(piv);
  switch (kind) {
    case 'fiesta': {
      piv.rotation.set(-0.1, 0, -0.26);
      const H = 0.62, B = 0.45;
      const cone = mesh(geo('partyCone', () => stripeGroups(new THREE.ConeGeometry(0.27, H, 12, 6), c => Math.floor((c.y + H / 2) / H * 6 + 1e-3) % 2 === 1)), [M.get('accent'), M.get('partyB')]);
      cone.position.y = B + H / 2;
      piv.add(cone);
      const pom = mesh(unitIco(), M.get('partyB'));
      pom.scale.setScalar(0.085);
      pom.position.y = B + H + 0.035;
      piv.add(pom);
      break;
    }
    case 'gorra': {
      piv.rotation.x = -0.07;
      piv.add(mesh(geo('capCrown', () => new THREE.SphereGeometry(0.6, 14, 6, 0, TAU, 0, 1.16)), M.get('accent')));
      const visor = mesh(geo('capVisor', () => {
        const pts = [], A = 0.95, N = 16;
        for (let i = 0; i <= N; i++) { const a = -A + 2 * A * i / N; const r = 0.5 + 0.29 * Math.pow(Math.cos(a / A * PI / 2), 0.6); pts.push(new THREE.Vector2(Math.sin(a) * r, Math.cos(a) * r)); }
        for (let i = N; i >= 0; i--) { const a = -A + 2 * A * i / N; pts.push(new THREE.Vector2(Math.sin(a) * 0.5, Math.cos(a) * 0.5)); }
        const vg = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.04, bevelEnabled: false, curveSegments: 4 });
        vg.rotateX(PI / 2);
        const p = vg.attributes.position;   // visera curvada hacia abajo en los lados y en la punta
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), z = p.getZ(i);
          p.setY(i, p.getY(i) - 0.32 * x * x - 0.12 * Math.max(0, z - 0.5) ** 2);
        }
        vg.computeVertexNormals();
        return vg;
      }), M.get('accentDark'));
      visor.position.y = 0.245;
      visor.rotation.x = 0.06;
      piv.add(visor);
      const btn = mesh(unitIco(), M.get('accentDark'));
      btn.scale.set(0.06, 0.035, 0.06);
      btn.position.y = 0.6;
      piv.add(btn);
      break;
    }
    case 'gorro': {
      piv.rotation.set(-0.05, 0, 0.05);
      const crown = mesh(geo('beanie', () => shadeFaces(new THREE.SphereGeometry(0.6, 16, 6, 0, TAU, 0, 1.14),
        c => (Math.floor((Math.atan2(c.x, c.z) / TAU + 0.5) * 16) % 2 ? 0.84 : 1))), M.get('accentKnit'));
      crown.scale.y = 1.07;
      piv.add(crown);
      const cuff = mesh(geo('beanieCuff', () => {
        const t = new THREE.TorusGeometry(0.55, 0.078, 6, 28);
        t.rotateX(PI / 2);
        return shadeFaces(t, c => (Math.floor((Math.atan2(c.x, c.z) / TAU + 0.5) * 28) % 2 ? 0.82 : 1));
      }), M.get('cuffKnit'));
      cuff.position.y = 0.27;
      piv.add(cuff);
      const pom = mesh(unitIco(), M.get('pompom'));
      pom.scale.setScalar(0.15);
      pom.position.y = 0.6 * 1.07 + 0.1;
      piv.add(pom);
      break;
    }
    case 'chistera': {
      piv.rotation.set(-0.05, 0, -0.13);
      const B = 0.45;
      const brim = mesh(geo('topBrim', () => {
        const b = new THREE.CylinderGeometry(0.5, 0.5, 0.035, 20);
        const p = b.attributes.position;
        for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + 0.22 * p.getX(i) * p.getX(i));
        b.computeVertexNormals();
        return b;
      }), M.get('topHat'));
      brim.position.y = B;
      piv.add(brim);
      const crownT = mesh(geo('topCrown', () => new THREE.CylinderGeometry(0.35, 0.32, 0.55, 16)), M.get('topHat'));
      crownT.position.y = B + 0.275;
      piv.add(crownT);
      const band = mesh(geo('topBand', () => new THREE.CylinderGeometry(0.336, 0.33, 0.1, 16)), M.get('hatBand'));
      band.position.y = B + 0.075;
      piv.add(band);
      break;
    }
    case 'auriculares': {
      piv.position.z = -0.03;
      piv.add(mesh(geo('phoneBand', () => new THREE.TorusGeometry(0.588, 0.045, 6, 22, PI)), M.get('phones')));
      for (const side of [-1, 1]) {
        const cup = mesh(geo('phoneCup', () => new THREE.CylinderGeometry(0.17, 0.17, 0.13, 14).rotateZ(PI / 2)), M.get('accent'));
        cup.position.set(side * 0.575, -0.02, 0);
        piv.add(cup);
        const cap = mesh(geo('phoneCap', () => new THREE.CylinderGeometry(0.105, 0.105, 0.04, 14).rotateZ(PI / 2)), M.get('phoneCap'));
        cap.position.set(side * 0.655, -0.02, 0);
        piv.add(cap);
      }
      break;
    }
    case 'mago': {
      piv.rotation.set(-0.06, 0, 0.07);
      const B = 0.36, H = 0.86, RB = 0.44;
      const brim = mesh(geo('wizBrim', () => {
        const b = new THREE.CylinderGeometry(0.66, 0.66, 0.03, 22, 1);
        const p = b.attributes.position;
        for (let i = 0; i < p.count; i++) { const r2 = p.getX(i) ** 2 + p.getZ(i) ** 2; p.setY(i, p.getY(i) - 0.07 * r2 / 0.4356); }
        b.computeVertexNormals();
        return b;
      }), M.get('wizard'));
      brim.position.y = B;
      piv.add(brim);
      const cone = mesh(geo('wizCone', () => {
        const c = new THREE.ConeGeometry(RB, H, 12, 7);
        const p = c.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const h = clamp((p.getY(i) + H / 2) / H, 0, 1);
          p.setX(i, p.getX(i) + 0.26 * Math.pow(h, 2.4));
          p.setY(i, p.getY(i) - 0.07 * h * h);
        }
        c.computeVertexNormals();
        return c;
      }), M.get('wizard'));
      cone.position.y = B + H / 2;
      piv.add(cone);
      const band = mesh(geo('wizBand', () => new THREE.CylinderGeometry(0.415, 0.44, 0.075, 14)), M.get('gold'));
      band.position.y = B + 0.045;
      piv.add(band);
      const starGeo = geo('star', () => extrude(starShape(0.07, 0.031), 0.022));
      for (const [h, a, s] of [[0.22, 0.35, 1], [0.47, -0.45, 0.8], [0.3, -1.25, 0.9]]) {
        const hh = h * H, r = RB * (1 - h) + 0.008;
        const bx = 0.26 * Math.pow(h, 2.4);
        const st = mesh(starGeo, M.get('gold'));
        st.position.set(Math.sin(a) * r + bx, B + hh - 0.07 * h * h, Math.cos(a) * r);
        const nrm = new THREE.Vector3(Math.sin(a), RB / H, Math.cos(a)).normalize();
        st.quaternion.setFromUnitVectors(Z_AXIS, nrm);
        st.scale.setScalar(s);
        piv.add(st);
      }
      break;
    }
    case 'corona': {
      piv.rotation.set(-0.04, 0, -0.1);
      const B = 0.43;
      const band = mesh(geo('crownBand', () => {
        const c = new THREE.CylinderGeometry(0.34, 0.31, 0.2, 10, 1, true);
        const p = c.attributes.position;
        for (let i = 0; i <= 10; i++) if (i % 2 === 0) p.setY(i, p.getY(i) + 0.15);
        c.computeVertexNormals();
        return c;
      }), M.get('goldDouble'));
      band.position.y = B + 0.1;
      piv.add(band);
      const rim = mesh(geo('crownRim', () => new THREE.TorusGeometry(0.315, 0.032, 5, 20).rotateX(PI / 2)), M.get('gold'));
      rim.position.y = B + 0.01;
      piv.add(rim);
      const gemGeo = geo('gem', () => new THREE.OctahedronGeometry(1));
      const gems = ['gemR', 'gemB', 'gemG', 'gemB', 'gemG'];
      for (let k = 0; k < 5; k++) {
        const a = k * TAU / 5;
        const gm = mesh(gemGeo, M.get(gems[k]));
        gm.position.set(Math.sin(a) * 0.335, B + 0.1, Math.cos(a) * 0.335);
        gm.rotation.y = a;
        gm.scale.set(0.05, 0.06, 0.03);
        piv.add(gm);
      }
      break;
    }
    default: break;
  }
  return g;
}

// ---------- construcción ----------
export function buildAvatar(cfg) {
  const c = normCfg(cfg);
  const M = materialSet(c.color);
  const R = { pupils: [], blinkers: [] };

  const root = new THREE.Group();
  root.name = 'avatar';
  const rig = new THREE.Group();
  root.add(rig);

  // pies
  const feet = [];
  for (const side of [-1, 1]) {
    const f = mesh(unitIco(), M.get('foot'));
    f.scale.set(0.15, 0.085, 0.2);
    f.position.set(side * FOOT_X, FOOT_Y, FOOT_Z);
    f.rotation.y = side * 0.15;
    rig.add(f);
    feet.push(f);
  }

  const hips = new THREE.Group();
  hips.position.y = HIP_Y;
  rig.add(hips);

  const torso = mesh(geo('torso', () => new THREE.CylinderGeometry(TORSO_RT, TORSO_RB, TORSO_H, 7, 1, false, -PI / 7)), M.get('body'));
  torso.position.y = TORSO_H / 2;
  hips.add(torso);
  const by = 0.4;
  const belly = ell(M.get('belly'), 0.2, 0.3, 0.1, 0, by, (TORSO_RB - (TORSO_RB - TORSO_RT) * by / TORSO_H) * Math.cos(PI / 7) - 0.045);
  belly.geometry = geo('bellySph', () => new THREE.SphereGeometry(1, 12, 8));
  belly.rotation.x = -Math.atan((TORSO_RB - TORSO_RT) * Math.cos(PI / 7) / TORSO_H);
  hips.add(belly);

  // brazos: hombro → codo → mano
  const arms = [];
  for (const side of [-1, 1]) {
    const sh = new THREE.Group();
    sh.position.set(side * SHOULDER_X, SHOULDER_Y, 0);
    hips.add(sh);
    const up = mesh(geo('upperArm', () => new THREE.CapsuleGeometry(0.088, 0.17, 3, 7)), M.get('body'));
    up.position.y = -0.15;
    sh.add(up);
    const el = new THREE.Group();
    el.position.y = -UPPER;
    sh.add(el);
    const fo = mesh(geo('foreArm', () => new THREE.CapsuleGeometry(0.08, 0.16, 3, 7)), M.get('body'));
    fo.position.y = -0.15;
    el.add(fo);
    const hand = mesh(unitIco(), M.get('hand'));
    hand.scale.set(HAND_R, HAND_R * 1.04, HAND_R * 0.88);
    hand.position.y = -FORE;
    el.add(hand);
    let finger = null;
    if (side > 0) {
      finger = mesh(geo('finger', () => new THREE.CapsuleGeometry(0.038, 0.09, 3, 6).translate(0, HAND_R + 0.035, 0)), M.get('hand'));
      finger.position.y = -FORE;
      finger.visible = false;
      el.add(finger);
    }
    arms.push({ sh, el, finger, side });
  }

  // cabeza
  const neck = new THREE.Group();
  neck.position.y = TORSO_H;
  hips.add(neck);
  const headG = new THREE.Group();
  headG.position.y = HEAD_C;
  neck.add(headG);
  headG.add(mesh(headGeo(), M.get('head')));

  const eyeKind = AVATAR.eyes[c.eyes];
  headG.add(buildEyes(eyeKind, M, R));
  headG.add(buildMouth(AVATAR.mouths[c.mouth], M));
  const blushGeo = geo('blush', () => extrude(ellipseShape(0, 0, 0.075, 0.042), 0.02));
  for (const side of [-1, 1]) {
    const b = new THREE.Group();
    placeOnHead(b, side * BLUSH_X, BLUSH_Y, 0.08, 0.045);
    b.add(mesh(blushGeo, M.get('blush')));
    headG.add(b);
  }
  headG.add(buildHat(AVATAR.hats[c.hat], M));

  const ud = root.userData;
  ud.isAvatar = true;
  ud.cfg = c;
  ud.anim = 'idle';
  ud.w = { idle: 1 };
  ud.phase = Math.random() * 100;
  ud.speed = 0.93 + Math.random() * 0.14;
  ud.blinkIn = 0.6 + Math.random() * 3;
  ud.blinkT = -1;
  ud.spin = -1;
  ud.spinCD = 2;
  ud.clock = 0;
  ud.pose = { ...REST };
  // Referencias a nodos y materiales: no enumerables para que clone()/toJSON no fallen.
  Object.defineProperty(ud, '_r', { value: { rig, hips, neck, headG, feet, arms, pupils: R.pupils, blinkers: R.blinkers, mats: M.list }, enumerable: false, writable: true, configurable: true });
  applyPose(root, ud.pose, 1);
  return root;
}

// ---------- poses ----------
const REST = {
  y: 0, ry: 0, sy: 1, hy: 0, hx: 0, hz: 0, nx: 0, ny: 0, nz: 0, sh: 0,
  hlx: -0.55, hly: 0.3, hlz: 0.1, plx: -0.6, ply: 0, plz: -1,
  hrx: 0.55, hry: 0.3, hrz: 0.1, prx: 0.6, pry: 0, prz: -1,
  ftl: 0, ftr: 0, px: 0, py: 0, fin: 0, eo: 1,
};
const KEYS = Object.keys(REST);
const pose = o => Object.assign({}, REST, o);

function idlePose(t) {
  const b = S(t * TAU * 0.42), sw = S(t * 1.4), sw2 = S(t * 1.4 + 1.3);
  return pose({
    ry: 0.06 * S(t * 0.31), sy: 1 + 0.016 * b, hy: 0.008 * b, hz: 0.025 * S(t * 0.77),
    nx: 0.04 * S(t * 0.53 + 1), ny: 0.14 * S(t * 0.41), nz: 0.07 * S(t * 0.67 + 2),
    hlx: -0.55 - 0.015 * sw, hly: 0.3 + 0.01 * sw, hlz: 0.1 + 0.07 * sw,
    hrx: 0.55 + 0.015 * sw2, hry: 0.3 + 0.01 * sw2, hrz: 0.1 - 0.07 * sw2,
    px: 0.45 * S(t * 0.41), py: 0.15 * S(t * 0.3),
  });
}
const POSES = {
  idle: idlePose,
  think(t) {
    const s = S(t * 0.9);
    return pose({
      ry: -0.12 + 0.05 * S(t * 0.5), sy: 1 + 0.01 * S(t * TAU * 0.35), hx: 0.05, hz: 0.035 * s,
      nx: -0.04 + 0.03 * S(t * 0.7), ny: 0.12 + 0.06 * S(t * 0.45), nz: -0.16 + 0.04 * s,
      hrx: 0.13, hry: 1.0 + 0.025 * Math.max(0, S(t * 5)), hrz: 0.5, prx: 1, pry: -1.2, prz: 0,
      hlx: -0.06, hly: 0.48, hlz: 0.5, plx: -1, ply: -0.4, plz: 0,
      px: 0.75, py: 0.75, eo: 0.92,
    });
  },
  happy(t, ud) {
    const P = 0.62, q = t / P, p = q - Math.floor(q), air = 4 * p * (1 - p);
    const edge = Math.min(p, 1 - p), land = Math.max(0, 1 - edge / 0.14);
    const w = S(t * TAU * 2.4);
    return pose({
      y: 0.26 * air, sy: 1 - 0.13 * land * land + 0.05 * air, hx: -0.03, hz: 0.05 * S(t * TAU / (2 * P)),
      nx: -0.1 + 0.05 * S(t * TAU / P), nz: 0.08 * S(t * TAU / (2 * P)), sh: 0.06,
      hrx: 0.7 + 0.07 * w, hry: 1.28 + 0.07 * w, hrz: 0.14, prx: 1, pry: -0.3, prz: -0.3,
      hlx: -0.7 - 0.07 * w, hly: 1.28 + 0.07 * w, hlz: 0.14, plx: -1, ply: -0.3, plz: -0.3,
      py: 0.4, eo: 1.06,
    });
  },
  sad(t) {
    const s = S(t * 0.8);
    return pose({
      sy: 0.94 + 0.008 * S(t * TAU * 0.3), hy: -0.015, hx: 0.1, hz: 0.03 * s,
      nx: 0.27 + 0.03 * S(t * 0.6), ny: 0.08 * S(t * 0.4), nz: 0.06 + 0.03 * s, sh: -0.04,
      hrx: 0.5, hry: 0.27, hrz: -0.06 - 0.03 * s, prx: 0.3, pry: 0, prz: -1,
      hlx: -0.5, hly: 0.27, hlz: -0.06 + 0.03 * s, plx: -0.3, ply: 0, plz: -1,
      py: -0.85, eo: 0.78,
    });
  },
  wave(t) {
    const b = idlePose(t), w = S(t * TAU * 1.7);
    return Object.assign(b, {
      hrx: 0.76 + 0.14 * w, hry: 1.3 - 0.04 * Math.abs(w), hrz: 0.15, prx: 1, pry: -0.6, prz: 0,
      nz: 0.08 + 0.03 * w, hz: -0.03 + 0.02 * w, sh: 0.04, px: 0.35, py: 0.25,
    });
  },
  dance(t) {
    const a = S(t * TAU), u = (1 + a) / 2;
    return pose({
      ry: 0.22 * a, sy: 1 + 0.035 * Math.cos(t * TAU * 2), hy: 0.035 * Math.abs(a), hz: 0.13 * a,
      nx: 0.1 * S(t * TAU * 2), ny: -0.1 * a, nz: 0.1 * a, sh: 0.03,
      hrx: 0.62 + 0.08 * u, hry: 0.42 + 0.84 * u, hrz: 0.22, prx: 1, pry: -0.4, prz: 0,
      hlx: -0.62 - 0.08 * (1 - u), hly: 0.42 + 0.84 * (1 - u), hlz: 0.22, plx: -1, ply: -0.4, plz: 0,
      ftl: 0.07 * Math.max(0, -a), ftr: 0.07 * Math.max(0, a), px: 0.3 * a, py: 0.1,
    });
  },
  vote(t) {
    const b = idlePose(t), s = S(t * TAU * 1.3);
    return Object.assign(b, {
      hy: 0.02 * s, sy: 1 + 0.015 * s, nx: -0.07, ny: 0.05, nz: 0.1, hz: -0.03, sh: 0.06,
      hrx: 0.68, hry: 1.36 + 0.03 * s, hrz: 0.12, prx: 1, pry: -0.25, prz: 0,
      px: 0.55, py: 0.7, fin: 1,
    });
  },
};

// ---------- aplicar pose ----------
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const FINGER_DIR = new THREE.Vector3(0.1, 1, 0.08).normalize();

function solveArm(arm, P, hx, hy, hz, px, py, pz) {
  const sx = arm.side * SHOULDER_X, sy = SHOULDER_Y + P.sh;
  arm.sh.position.set(sx, sy, 0);
  _a.set(hx - sx, hy - sy, hz);
  let d = _a.length();
  if (d < 1e-4) { _a.set(0, -1, 0); d = 1; } else _a.divideScalar(d);
  d = clamp(d, 0.08, UPPER + FORE - 1e-3);
  const cosA = clamp((UPPER * UPPER + d * d - FORE * FORE) / (2 * UPPER * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _b.set(px, py, pz);
  _b.addScaledVector(_a, -_b.dot(_a));
  if (_b.lengthSq() < 1e-6) { _b.set(arm.side, -0.2, -0.4); _b.addScaledVector(_a, -_b.dot(_a)); }
  _b.normalize();
  _c.copy(_a).multiplyScalar(cosA).addScaledVector(_b, sinA);              // dirección del brazo
  _b.copy(_a).multiplyScalar(d).addScaledVector(_c, -UPPER).normalize();   // dirección del antebrazo
  arm.sh.quaternion.setFromUnitVectors(DOWN, _c);
  _q.setFromUnitVectors(DOWN, _b);
  _q2.copy(arm.sh.quaternion).invert();
  arm.el.quaternion.copy(_q2).multiply(_q);
  if (arm.finger) {
    const f = P.fin;
    arm.finger.visible = f > 0.02;
    if (arm.finger.visible) {
      arm.finger.scale.setScalar(clamp(f, 0.02, 1));
      _q2.copy(_q).invert();
      arm.finger.quaternion.setFromUnitVectors(UP, FINGER_DIR).premultiply(_q2);
    }
  }
}

function applyPose(av, P, blink) {
  const r = av.userData._r, ud = av.userData;
  const spin = ud.spin >= 0 ? (ud.spin * ud.spin * (3 - 2 * ud.spin)) * TAU : 0;
  r.rig.position.y = P.y;
  r.rig.rotation.y = P.ry + spin;
  const sy = clamp(P.sy, 0.6, 1.4), sxz = 1 / Math.sqrt(sy);
  r.rig.scale.set(sxz, sy, sxz);
  r.hips.position.y = HIP_Y + P.hy;
  r.hips.rotation.set(P.hx, 0, P.hz);
  r.neck.rotation.set(P.nx, P.ny, P.nz);
  solveArm(r.arms[0], P, P.hlx, P.hly, P.hlz, P.plx, P.ply, P.plz);
  solveArm(r.arms[1], P, P.hrx, P.hry, P.hrz, P.prx, P.pry, P.prz);
  r.feet[0].position.y = FOOT_Y + P.ftl;
  r.feet[1].position.y = FOOT_Y + P.ftr;
  const px = clamp(P.px, -1, 1), py = clamp(P.py, -1, 1);
  for (const p of r.pupils) p.obj.position.set(p.x + px * p.mx, p.y + py * p.my, 0);
  const open = clamp(P.eo, 0.1, 1.15) * blink;
  for (const e of r.blinkers) e.scale.y = open;
}

// ---------- API pública ----------
export function setAvatarAnim(avatar, name) {
  const ud = avatar && avatar.userData;
  if (!ud || !ud._r) return;
  const n = ANIMS.includes(name) ? name : 'idle';
  if (ud.anim === n) return;
  ud.anim = n;
  if (!(n in ud.w)) ud.w[n] = 0;
  if (n === 'happy') ud.spinCD = 0.9 + Math.random() * 1.6;
}

const _target = {};
export function updateAvatar(avatar, dt, t) {
  const ud = avatar && avatar.userData;
  if (!ud || !ud._r) return;
  dt = clamp(Number(dt) || 0, 0, 0.1);
  ud.clock += dt;
  const time = (Number.isFinite(t) ? t : ud.clock) * ud.speed + ud.phase;

  // mezcla de animaciones: los pesos se acercan suavemente a 1 (actual) o 0 (resto)
  const k = 1 - Math.exp(-dt * 5);
  let sum = 0;
  for (const n of Object.keys(ud.w)) {
    const target = n === ud.anim ? 1 : 0;
    let w = ud.w[n] + (target - ud.w[n]) * k;
    if (!target && w < 0.003) { delete ud.w[n]; continue; }
    ud.w[n] = w;
    sum += w;
  }
  for (const key of KEYS) _target[key] = 0;
  if (sum < 1e-4) { Object.assign(_target, POSES[ud.anim](time, ud)); }
  else {
    for (const n of Object.keys(ud.w)) {
      const w = ud.w[n] / sum, q = POSES[n](time, ud);
      for (const key of KEYS) _target[key] += q[key] * w;
    }
  }

  // giro completo ocasional al estar feliz
  if (ud.spin < 0 && ud.anim === 'happy') {
    ud.spinCD -= dt;
    if (ud.spinCD <= 0) { ud.spin = 0; ud.spinCD = 2.8 + Math.random() * 3; }
  }
  if (ud.spin >= 0) { ud.spin += dt / 0.75; if (ud.spin >= 1) ud.spin = -1; }

  // parpadeo
  let blink = 1;
  ud.blinkIn -= dt;
  if (ud.blinkT < 0 && ud.blinkIn <= 0) ud.blinkT = 0;
  if (ud.blinkT >= 0) {
    ud.blinkT += dt;
    const p = ud.blinkT / 0.17;
    if (p >= 1) { ud.blinkT = -1; ud.blinkIn = Math.random() < 0.15 ? 0.22 : 2.5 + Math.random() * 2.5; }
    else blink = 1 - 0.92 * Math.sin(PI * p);
  }

  // suavizado final: nunca hay saltos bruscos
  const ks = 1 - Math.exp(-dt * 18);
  const P = ud.pose;
  for (const key of KEYS) P[key] += (_target[key] - P[key]) * ks;
  applyPose(avatar, P, blink);
}

export function disposeAvatar(avatar) {
  const ud = avatar && avatar.userData;
  if (!ud || !ud._r) return;
  for (const m of ud._r.mats) m.dispose();
  ud._r.mats.length = 0;
  if (avatar.parent) avatar.parent.remove(avatar);
}

// ---------- estudio: vista previa y miniaturas ----------
function makeShadowBlob() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.38)');
  grd.addColorStop(0.6, 'rgba(0,0,0,0.16)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -PI / 2;
  m.position.y = 0.002;
  m.renderOrder = -1;
  return m;
}

export class AvatarStudio {
  constructor() {
    this._thumbs = new Map();
    this._key = null;
    this._avatar = null;
    this._lastT = null;
    this.renderer = null;
    try {
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(1);
      this.renderer.setClearColor(0x000000, 0);
    } catch (e) {
      console.warn('AvatarStudio: WebGL no disponible', e);
      this.renderer = null;
    }
    this.scene = new THREE.Scene();
    const hemi = new THREE.HemisphereLight(0xfff4ea, 0x5b6280, 1.6);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 4.5, 5);
    const fill = new THREE.DirectionalLight(0xd6e4ff, 0.8);
    fill.position.set(-4, 2, 3);
    const rim = new THREE.DirectionalLight(0xffffff, 1.2);
    rim.position.set(-1, 3.5, -4);
    this.scene.add(hemi, key, fill, rim);
    this.camera = new THREE.PerspectiveCamera(26, 1, 0.1, 60);
    this._shadow = makeShadowBlob();
    this.scene.add(this._shadow);
  }

  _aim(cy, half, halfW, aspect, elevDeg) {
    const cam = this.camera, fov = cam.fov * PI / 180, tv = Math.tan(fov / 2);
    const d = Math.max(half / tv, halfW / (tv * aspect)) * 1.06;
    const el = elevDeg * PI / 180;
    cam.aspect = aspect;
    cam.position.set(0, cy + Math.sin(el) * d, Math.cos(el) * d);
    cam.lookAt(0, cy, 0);
    cam.updateProjectionMatrix();
  }

  _render(w, h) {
    const r = this.renderer, cv = r.domElement;
    if (cv.width !== w || cv.height !== h) r.setSize(w, h, false);
    r.render(this.scene, this.camera);
  }

  preview(cfg, canvas2d, t, anim = 'idle') {
    if (!this.renderer || !canvas2d) return;
    const c = normCfg(cfg), key = cfgKey(c);
    if (key !== this._key) {
      const prev = this._avatar;
      const av = buildAvatar(c);
      if (prev) {   // conserva el estado de animación para que el cambio no salte
        const a = prev.userData, b = av.userData;
        Object.assign(b, { anim: a.anim, w: { ...a.w }, phase: a.phase, speed: a.speed, spin: a.spin, spinCD: a.spinCD, pose: { ...a.pose } });
        disposeAvatar(prev);
      }
      this._avatar = av;
      this._key = key;
      this.scene.add(av);
    }
    const av = this._avatar;
    av.visible = true;
    setAvatarAnim(av, anim);
    const tt = Number.isFinite(t) ? t : performance.now() / 1000;
    const dt = this._lastT == null ? 1 / 60 : clamp(tt - this._lastT, 0, 0.1);
    this._lastT = tt;
    updateAvatar(av, dt, tt);
    const w = canvas2d.width | 0, h = canvas2d.height | 0;
    if (!w || !h) return;
    // encuadre fijo de cuerpo entero (cabe el sombrero más alto y los saltos)
    this._aim(1.43, 1.5, 0.98, w / h, 8);
    const jump = av.userData._r.rig.position.y;
    this._shadow.visible = true;
    this._shadow.scale.setScalar(clamp(1 - jump * 1.2, 0.55, 1));
    this._render(w, h);
    const ctx = canvas2d.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.renderer.domElement, 0, 0, w, h);
  }

  thumb(cfg, size = 96) {
    const px = clamp(Math.round(Number(size) || 96), 16, 1024);
    const c = normCfg(cfg), key = cfgKey(c) + '@' + px;
    const hit = this._thumbs.get(key);
    if (hit) return hit;
    if (!this.renderer) return '';
    const av = buildAvatar(c);
    const prevVis = this._avatar ? this._avatar.visible : false;
    if (this._avatar) this._avatar.visible = false;
    this._shadow.visible = false;
    this.scene.add(av);
    av.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(av);
    const top = Math.max(2.2, box.max.y + 0.04), bottom = 0.84;
    this._aim((top + bottom) / 2, (top - bottom) / 2, 0.72, 1, 6);
    this._render(px, px);
    const url = this.renderer.domElement.toDataURL('image/png');
    disposeAvatar(av);
    if (this._avatar) this._avatar.visible = prevVis;
    if (this._thumbs.size > 400) this._thumbs.delete(this._thumbs.keys().next().value);
    this._thumbs.set(key, url);
    return url;
  }

  dispose() {
    if (this._avatar) { disposeAvatar(this._avatar); this._avatar = null; }
    this._thumbs.clear();
    this._shadow.geometry.dispose();
    this._shadow.material.map.dispose();
    this._shadow.material.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer = null;
    }
  }
}
