// Escenario 3D low-poly: estudio, podios con avatares, torre de premios, efectos y 4 estilos visuales.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildAvatar, setAvatarAnim, updateAvatar, disposeAvatar } from './avatar.js';
import { AVATAR } from './config.js';

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, k) => a + (b - a) * k;

// ---------- utilidades de materiales y texturas ----------
function canvasTex(w, h, draw, { repeat = null } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.anisotropy = 4;
  return t;
}
const flat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.6, metalness: 0.05, ...o });
const neon = (color, k = 2.2, o = {}) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), toneMapped: true, ...o });
function gradientBg(stops) {
  return canvasTex(4, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    stops.forEach(([p, c]) => gr.addColorStop(p, c));
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}
function radialTex(inner, outer, size = 512) {
  return canvasTex(size, size, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, inner); gr.addColorStop(1, outer);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}
let dotTexCache = null;
function dotTex() {
  if (!dotTexCache) dotTexCache = canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
  return dotTexCache;
}
function disposeTree(obj) {
  obj.traverse(o => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (m.userData && m.userData.shared) continue;
      for (const k of ['map', 'alphaMap', 'emissiveMap']) if (m[k] && m[k] !== dotTexCache) m[k].dispose();
      m.dispose();
    }
  });
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
const FONT = '"Baloo 2", "Nunito", system-ui, sans-serif';

function textSprite(text, { bg = '#ffffff', fg = '#1a1033', size = 64, pad = 24, height = 0.42, radius = 30, border = null } = {}) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `800 ${size}px ${FONT}`;
  const tw = Math.ceil(probe.measureText(text).width);
  const w = tw + pad * 2, h = size + pad;
  const tex = canvasTex(w, h, (g) => {
    roundRect(g, 2, 2, w - 4, h - 4, radius);
    g.fillStyle = bg; g.fill();
    if (border) { g.lineWidth = 5; g.strokeStyle = border; g.stroke(); }
    g.font = `800 ${size}px ${FONT}`; g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + size * 0.06);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(height * (w / h), height, 1);
  return sp;
}

const emojiCache = new Map();
function emojiTex(e) {
  if (!emojiCache.has(e)) {
    emojiCache.set(e, canvasTex(128, 128, (g) => {
      g.font = '96px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(e, 64, 72);
    }));
  }
  return emojiCache.get(e);
}

// ---------- estilos ----------
const THEME_DEF = {
  gala: {
    bg: () => gradientBg([[0, '#05020f'], [0.55, '#140733'], [1, '#05020f']]),
    fog: [0x0a0520, 0.024], hemi: [0x8a7cff, 0x1a0b2e, 0.55], key: [0xfff0e0, 1.5], rim: [0xff3fbf, 1.6],
    bloom: [0.55, 0.5, 0.8], exposure: 0.95, accent: [0xff2fb3, 0x21e6e0, 0xffc93c], screen: 'neon', audience: true, coin: true,
  },
  juguete: {
    bg: () => gradientBg([[0, '#7ccfff'], [0.6, '#bfe7ff'], [1, '#ffd9ef']]),
    fog: [0xd6ecff, 0.012], hemi: [0xffffff, 0xffd6ec, 1.25], key: [0xfff3d6, 2.1], rim: [0xa0d8ff, 0.8],
    bloom: [0.22, 0.4, 0.92], exposure: 1.05, accent: [0xff5fa2, 0x3ab0ff, 0xffc300], screen: 'candy', audience: true, coin: true,
  },
  synth: {
    bg: () => gradientBg([[0, '#08001a'], [0.45, '#2a0650'], [0.62, '#5a0f6e'], [0.66, '#12002b'], [1, '#05000f']]),
    fog: [0x12002b, 0.016], hemi: [0x7a3cff, 0x0a0018, 0.6], key: [0xff6ad5, 1.2], rim: [0x05d9e8, 1.8],
    bloom: [0.85, 0.55, 0.66], exposure: 1.0, accent: [0xff2a6d, 0x05d9e8, 0xffd319], screen: 'neon', audience: false, coin: true,
  },
  torre: {
    bg: () => gradientBg([[0, '#4fb3ff'], [0.55, '#9ad8ff'], [1, '#ffe9c2']]),
    fog: [0xcde9ff, 0.009], hemi: [0xdff3ff, 0x8a6a3a, 1.15], key: [0xffe2b0, 2.3], rim: [0x9fd6ff, 0.7],
    bloom: [0.3, 0.45, 0.88], exposure: 1.05, accent: [0x2a9d8f, 0xe76f51, 0xf4a261], screen: null, audience: false, coin: false,
  },
};

export class Stage {
  constructor(el, { quality = 'auto' } = {}) {
    this.el = el;
    this.quality = Stage.resolveQuality(quality);
    this.renderer = new THREE.WebGLRenderer({ antialias: this.quality !== 'baja', powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(this.pixelRatio());
    el.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x222244, 1);
    this.key = new THREE.DirectionalLight(0xffffff, 1.5);
    this.key.position.set(5, 11, 9);
    this.rim = new THREE.DirectionalLight(0x88aaff, 1);
    this.rim.position.set(-7, 7, -9);
    this.scene.add(this.hemi, this.key, this.rim);

    this.world = new THREE.Group();
    this.podiumGroup = new THREE.Group();
    this.towerGroup = new THREE.Group();
    this.fxGroup = new THREE.Group();
    this.scene.add(this.world, this.podiumGroup, this.towerGroup, this.fxGroup);

    this.podiums = [];
    this.playersKey = '';
    this.ladder = { len: 15, level: 0, safe: [], shown: 0 };
    this.mode = 'home';
    this.shot = 'wide';
    this.cam = { pos: new V3(0, 5, 16), look: new V3(0, 2.2, 0), shake: 0 };
    this.framing = { x: 0, y: 0, tx: 0, ty: 0 };
    this.mood = 'idle';
    this.moodT = 0;
    this.time = 0;
    this.updaters = [];
    this.floaters = [];
    this.bursts = [];
    this.reduceMotion = false;

    this.initConfetti();
    this.setTheme('gala');
    this.setupComposer();

    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(el);
    window.addEventListener('resize', this.resize);
    this.resize();
    this.clock = new THREE.Clock();
    this.loop = this.loop.bind(this);
    this.renderer.setAnimationLoop(this.loop);
  }

  static resolveQuality(q) {
    if (q !== 'auto') return q;
    const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || Math.min(screen.width, screen.height) < 600;
    return mobile ? 'baja' : (navigator.hardwareConcurrency || 4) <= 4 ? 'media' : 'alta';
  }
  pixelRatio() { return Math.min(window.devicePixelRatio || 1, this.quality === 'alta' ? 2 : this.quality === 'media' ? 1.5 : 1); }

  setupComposer() {
    if (this.composer) { this.composer.dispose?.(); this.composer = null; }
    if (this.quality === 'baja') return;
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const b = THEME_DEF[this.theme].bloom;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x || 800, size.y || 600), b[0], b[1], b[2]);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.setPixelRatio(this.pixelRatio());
    this.composer.setSize(size.x || 800, size.y || 600);
  }

  setQuality(q) {
    const nq = Stage.resolveQuality(q);
    if (nq === this.quality) return;
    this.quality = nq;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.setupComposer();
    const t = this.theme; this.theme = null; this.setTheme(t);
    this.resize();
  }

  resize() {
    const w = this.el.clientWidth || window.innerWidth, h = this.el.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    if (this.composer) this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // En pantallas verticales alejamos la cámara para que quepan los 4 podios.
    this.portrait = w / h < 0.9;
    this.camera.fov = this.portrait ? 58 : 42;
    this.applyFraming();
  }

  applyFraming() {
    const w = this.el.clientWidth || window.innerWidth, h = this.el.clientHeight || window.innerHeight;
    const f = this.framing;
    if (Math.abs(f.x) < 0.001 && Math.abs(f.y) < 0.001) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, f.x * w, f.y * h, w, h);
    this.camera.updateProjectionMatrix();
  }

  // Desplaza el encuadre (fracciones de pantalla) para dejar sitio a la interfaz.
  setFraming(x, y) { this.framing.tx = x; this.framing.ty = y; }

  // ---------- estilos ----------
  setTheme(id) {
    if (!THEME_DEF[id]) id = 'gala';
    if (id === this.theme) return;
    this.theme = id;
    const T = THEME_DEF[id];
    disposeTree(this.world);
    this.world.clear();
    this.updaters = [];
    if (this.scene.background && this.scene.background.isTexture) this.scene.background.dispose();
    this.scene.background = T.bg();
    this.scene.fog = new THREE.FogExp2(T.fog[0], T.fog[1]);
    this.hemi.color.set(T.hemi[0]); this.hemi.groundColor.set(T.hemi[1]); this.hemi.intensity = T.hemi[2];
    this.key.color.set(T.key[0]); this.key.intensity = T.key[1];
    this.rim.color.set(T.rim[0]); this.rim.intensity = T.rim[1];
    this.renderer.toneMappingExposure = T.exposure;
    if (this.bloom) { this.bloom.strength = T.bloom[0]; this.bloom.radius = T.bloom[1]; this.bloom.threshold = T.bloom[2]; }
    this.stageTop = 0.36;
    ({ gala: this.buildGala, juguete: this.buildToy, synth: this.buildSynth, torre: this.buildTorre })[id].call(this, T);
    if (T.screen) this.buildScreen(T.screen);
    else this.screen = null;
    if (T.audience && this.quality !== 'baja') this.buildAudience(T);
    else this.audience = null;
    this.buildCoin(T.coin);
    // Reconstruye podios y torre con el estilo nuevo.
    const players = this.lastPlayers || [];
    this.playersKey = '';
    this.setPlayers(players);
    this.buildTower();
    if (this.screenLines) this.setScreen(this.screenLines);
  }

  podiumMesh(colorHex) {
    const c = new THREE.Color(colorHex);
    const g = new THREE.Group();
    const t = this.theme;
    if (t === 'gala') {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.92, 1.1, 6), flat(0x1c1242, { roughness: 0.25, metalness: 0.6 }));
      base.position.y = 0.55;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.86, 0.12, 6, 1, true), neon(c, 2.4));
      band.position.y = 0.78;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.84, 0.8, 0.08, 6), neon(c, 1.4));
      top.position.y = 1.12;
      g.add(base, band, top);
    } else if (t === 'juguete') {
      const pastel = c.clone().lerp(new THREE.Color(0xffffff), 0.35);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.9, 1.0, 12), flat(pastel, { roughness: 0.45 }));
      base.position.y = 0.5;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.84, 0.13, 6, 16), flat(0xffffff, { roughness: 0.3 }));
      rim.rotation.x = Math.PI / 2; rim.position.y = 1.02;
      const dots = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.06, 4, 12), flat(0xffd23f));
      dots.rotation.x = Math.PI / 2; dots.position.y = 0.2;
      g.add(base, rim, dots);
    } else if (t === 'synth') {
      const box = new THREE.BoxGeometry(1.3, 1.1, 1.1);
      const base = new THREE.Mesh(box, flat(0x12002a, { roughness: 0.35, metalness: 0.4 }));
      base.position.y = 0.55;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: c.clone().multiplyScalar(2.5) }));
      edges.position.y = 0.55;
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.08), neon(c, 2.6));
      stripe.position.set(0, 0.75, 0.56);
      g.add(base, edges, stripe);
    } else {
      const wood = flat(0x9c6b3c, { roughness: 0.85 });
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.74, 0.74, 1.1, 10), wood);
      base.position.y = 0.55;
      for (const y of [0.22, 0.88]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.76, 0.05, 4, 14), flat(0x4a3424, { metalness: 0.4 }));
        ring.rotation.x = Math.PI / 2; ring.position.y = y; g.add(ring);
      }
      const cloth = new THREE.Mesh(new THREE.CylinderGeometry(0.77, 0.77, 0.16, 10, 1, true), flat(c));
      cloth.position.y = 0.55;
      g.add(base, cloth);
    }
    return g;
  }

  buildStageDisc(color, edgeColor, k = 2.2, segs = 40) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(6, 6.4, this.stageTop, segs), flat(color, { roughness: 0.3, metalness: 0.5 }));
    disc.position.y = this.stageTop / 2;
    this.world.add(disc);
    if (edgeColor != null) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(6.02, 0.06, 6, 96), neon(edgeColor, k));
      ring.rotation.x = Math.PI / 2; ring.position.y = this.stageTop;
      this.world.add(ring);
      return ring;
    }
    return null;
  }

  buildGala(T) {
    const floor = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardMaterial({ map: radialTex('#3a1170', '#05020f'), roughness: 0.35, metalness: 0.4 }));
    floor.rotation.x = -Math.PI / 2;
    this.world.add(floor);
    this.buildStageDisc(0x1a0e3d, T.accent[0]);
    const rings = [];
    [[4.4, T.accent[1]], [2.8, T.accent[2]]].forEach(([r, c]) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.035, 4, 80), neon(c, 1.8));
      m.rotation.x = Math.PI / 2; m.position.y = this.stageTop + 0.01;
      this.world.add(m); rings.push(m);
    });
    // Estrella central
    const star = new THREE.Mesh(new THREE.CircleGeometry(1.4, 5), neon(T.accent[2], 1.3, { transparent: true, opacity: 0.5 }));
    star.rotation.x = -Math.PI / 2; star.position.y = this.stageTop + 0.012;
    this.world.add(star);
    // Paneles LED detrás
    const n = 26;
    const panelGeo = new THREE.BoxGeometry(1.25, 8, 0.25);
    const panels = new THREE.InstancedMesh(panelGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), n);
    const dummy = new THREE.Object3D();
    const cols = [];
    for (let i = 0; i < n; i++) {
      const a = (i / (n - 1) - 0.5) * Math.PI * 1.05;
      dummy.position.set(Math.sin(a) * 15, 4, -Math.cos(a) * 15 + 2);
      dummy.rotation.set(0, -a, 0);
      dummy.updateMatrix();
      panels.setMatrixAt(i, dummy.matrix);
      panels.setColorAt(i, new THREE.Color(0x000000));
      cols.push(a);
    }
    this.world.add(panels);
    const ca = new THREE.Color(T.accent[0]), cb = new THREE.Color(T.accent[1]), tmp = new THREE.Color();
    // Conos de luz
    const coneTex = canvasTex(4, 128, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    const cones = [];
    const coneColors = [T.accent[0], T.accent[1], T.accent[2], T.accent[1], T.accent[0]];
    coneColors.forEach((c, i) => {
      const geo = new THREE.ConeGeometry(2.3, 14, 20, 1, true);
      geo.translate(0, -7, 0);
      const mat = new THREE.MeshBasicMaterial({ color: c, alphaMap: coneTex, transparent: true, opacity: 0.075, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const cone = new THREE.Mesh(geo, mat);
      cone.position.set((i - 2) * 3.4, 13.5, -2);
      this.world.add(cone);
      const pool = new THREE.Mesh(new THREE.CircleGeometry(1.9, 24), new THREE.MeshBasicMaterial({ color: c, map: dotTex(), transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
      pool.rotation.x = -Math.PI / 2;
      this.world.add(pool);
      cones.push({ cone, pool, ph: i * 1.3 });
    });
    const sparkles = this.makeSparkles(this.quality === 'baja' ? 120 : 360, 0xffd27a, [-16, 16], [0, 12], [-14, 6]);
    this.updaters.push((t) => {
      for (let i = 0; i < n; i++) {
        const v = 0.5 + 0.5 * Math.sin(t * 2.2 - cols[i] * 4 + (this.mood === 'cheer' ? t * 6 : 0));
        tmp.copy(ca).lerp(cb, 0.5 + 0.5 * Math.sin(t * 0.6 + i * 0.3)).multiplyScalar(0.06 + v * (this.mood === 'tense' ? 0.18 : 0.36));
        panels.setColorAt(i, tmp);
      }
      panels.instanceColor.needsUpdate = true;
      for (const c of cones) {
        const sweep = this.mood === 'tense' ? 0.12 : 0.38;
        c.cone.rotation.z = Math.sin(t * 0.7 + c.ph) * sweep;
        c.cone.rotation.x = Math.cos(t * 0.5 + c.ph) * sweep * 0.6;
        const dir = new V3(0, -1, 0).applyEuler(c.cone.rotation);
        const k = (c.cone.position.y - 0.4) / Math.max(0.2, -dir.y);
        c.pool.position.set(c.cone.position.x + dir.x * k, this.stageTop + 0.02, c.cone.position.z + dir.z * k);
      }
      rings[0].rotation.z = t * 0.15; rings[1].rotation.z = -t * 0.25;
      star.rotation.z = t * 0.2;
      sparkles.rotation.y = t * 0.02;
    });
  }

  makeSparkles(count, color, xr, yr, zr) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { pos[i * 3] = rand(...xr); pos[i * 3 + 1] = rand(...yr); pos[i * 3 + 2] = rand(...zr); }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 0.14, map: dotTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.world.add(pts);
    this.updaters.push((t, dt) => {
      const a = geo.attributes.position.array;
      for (let i = 0; i < count; i++) { a[i * 3 + 1] += dt * 0.25; if (a[i * 3 + 1] > yr[1]) a[i * 3 + 1] = yr[0]; }
      geo.attributes.position.needsUpdate = true;
    });
    return pts;
  }

  buildToy(T) {
    const floorTex = canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#b8ecc9'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#d6f7e1';
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { g.beginPath(); g.arc(x * 64 + (y % 2) * 32 + 16, y * 64 + 32, 12, 0, TAU); g.fill(); }
    }, { repeat: [14, 14] });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(60, 48), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    this.world.add(floor);
    // Escenario tipo pastel
    const cake = new THREE.Mesh(new THREE.CylinderGeometry(6, 6.3, this.stageTop, 32), flat(0xff8fc4, { roughness: 0.5 }));
    cake.position.y = this.stageTop / 2;
    const icing = new THREE.Mesh(new THREE.TorusGeometry(6.05, 0.16, 6, 48), flat(0xffffff, { roughness: 0.35 }));
    icing.rotation.x = Math.PI / 2; icing.position.y = this.stageTop;
    this.world.add(cake, icing);
    const sprinkleCols = [0xffd23f, 0x3ab0ff, 0x7bd389, 0xff6b6b, 0xb388ff];
    for (let i = 0; i < 40; i++) {
      const s = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.16, 2, 4), flat(sprinkleCols[i % 5]));
      const a = rand(0, TAU), r = rand(5.2, 5.85);
      s.position.set(Math.cos(a) * r, this.stageTop + 0.03, Math.sin(a) * r);
      s.rotation.set(Math.PI / 2, 0, rand(0, TAU));
      this.world.add(s);
    }
    // Arcoíris
    const rainbow = [0xff5a5f, 0xff9f1c, 0xffd23f, 0x7bd389, 0x3ab0ff, 0x9b5de5];
    rainbow.forEach((c, i) => {
      const arc = new THREE.Mesh(new THREE.TorusGeometry(11 - i * 0.55, 0.28, 6, 40, Math.PI), flat(c, { roughness: 0.5 }));
      arc.position.set(0, 0, -12);
      this.world.add(arc);
    });
    // Nubes
    const clouds = [];
    for (let i = 0; i < 9; i++) {
      const cl = new THREE.Group();
      for (let k = 0; k < 5; k++) {
        const b = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(0.8, 1.5), 0), flat(0xffffff, { roughness: 0.9 }));
        b.position.set(k * 1.1 - 2.2, rand(-0.2, 0.4), rand(-0.4, 0.4));
        cl.add(b);
      }
      cl.position.set(rand(-26, 26), rand(8, 14), rand(-30, -12));
      cl.userData.v = rand(0.3, 0.8);
      this.world.add(cl); clouds.push(cl);
    }
    // Globos
    const balloons = [];
    for (let i = 0; i < 12; i++) {
      const col = sprinkleCols[i % 5];
      const b = new THREE.Group();
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshStandardMaterial({ color: col, roughness: 0.2, metalness: 0.1 }));
      ball.scale.y = 1.2;
      const knot = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.16, 6), flat(col));
      knot.position.y = -0.62; knot.rotation.x = Math.PI;
      const str = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 2.4, 3), flat(0xffffff));
      str.position.y = -1.9;
      b.add(ball, knot, str);
      const side = i % 2 ? 1 : -1;
      b.position.set(side * rand(7.5, 12), rand(3.5, 7), rand(-6, 2));
      b.userData.ph = rand(0, TAU);
      this.world.add(b); balloons.push(b);
    }
    // Bloques de juguete
    const letters = ['A', 'B', 'C', 'D', '?', '★'];
    const blockCols = ['#ff5a5f', '#3ab0ff', '#ffd23f', '#7bd389', '#b388ff', '#ff9f1c'];
    const blocks = [[-8.5, 0, 1], [-7.4, 0, 0.2], [-8, 1, 0.6], [8.3, 0, 0.8], [7.2, 0, -0.2], [7.8, 1, 0.3]];
    blocks.forEach(([x, row, z], i) => {
      const tex = canvasTex(128, 128, (g) => {
        g.fillStyle = blockCols[i]; g.fillRect(0, 0, 128, 128);
        g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 10; g.strokeRect(8, 8, 112, 112);
        g.fillStyle = '#fff'; g.font = `800 84px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(letters[i], 64, 70);
      });
      const blk = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }));
      blk.position.set(x, 0.55 + row * 1.1, z);
      blk.rotation.y = rand(-0.4, 0.4);
      this.world.add(blk);
    });
    this.updaters.push((t, dt) => {
      for (const c of clouds) { c.position.x += c.userData.v * dt; if (c.position.x > 30) c.position.x = -30; }
      for (const b of balloons) { b.position.y += Math.sin(t * 1.2 + b.userData.ph) * dt * 0.3; b.rotation.z = Math.sin(t + b.userData.ph) * 0.12; }
    });
  }

  buildSynth(T) {
    const gridTex = canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = '#0b0018'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#ff2a6d'; g.lineWidth = 4; g.strokeRect(0, 0, w, h);
    }, { repeat: [80, 80] });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshBasicMaterial({ map: gridTex, color: 0xbbbbbb }));
    floor.rotation.x = -Math.PI / 2;
    this.world.add(floor);
    // Sol retro con franjas
    const sunTex = canvasTex(512, 512, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, '#ffe45e'); gr.addColorStop(0.5, '#ff8c42'); gr.addColorStop(1, '#ff2a8d');
      g.fillStyle = gr; g.beginPath(); g.arc(w / 2, h / 2, w / 2, 0, TAU); g.fill();
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 9; i++) { const y = h * 0.52 + i * i * 2.6 + i * 14; g.fillRect(0, y, w, 4 + i * 2.2); }
    });
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(44, 44), new THREE.MeshBasicMaterial({ map: sunTex, transparent: true, fog: false, color: new THREE.Color(1.6, 1.6, 1.6) }));
    sun.position.set(0, 11, -110);
    this.world.add(sun);
    // Montañas con malla neón
    for (const side of [-1, 1]) {
      const geo = new THREE.PlaneGeometry(90, 22, 30, 6);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i);
        const k = (y + 11) / 22;
        p.setY(i, y + (k > 0.05 ? Math.abs(Math.sin(x * 0.21 + side) * 7 + Math.sin(x * 0.53) * 3) * k : 0));
        p.setZ(i, rand(-1.5, 1.5) * k);
      }
      geo.computeVertexNormals();
      const solid = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x14002e, fog: false }));
      const wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0x05d9e8).multiplyScalar(1.6), wireframe: true, fog: false, transparent: true, opacity: 0.55 }));
      for (const m of [solid, wire]) { m.position.set(side * 48, 9, -90); this.world.add(m); }
    }
    const ring = this.buildStageDisc(0x150030, 0x05d9e8, 2.6, 6);
    const inner = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.04, 4, 6), neon(0xff2a6d, 2.4));
    inner.rotation.x = Math.PI / 2; inner.position.y = this.stageTop + 0.01;
    this.world.add(inner);
    // Figuras flotantes
    const shapes = [];
    const geos = [new THREE.TetrahedronGeometry(0.9), new THREE.OctahedronGeometry(0.8), new THREE.IcosahedronGeometry(0.8, 0), new THREE.TorusGeometry(0.8, 0.08, 3, 3)];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(geos[i % 4], new THREE.MeshBasicMaterial({ color: new THREE.Color(i % 2 ? 0xff2a6d : 0x05d9e8).multiplyScalar(2), wireframe: true }));
      const side = i % 2 ? 1 : -1;
      m.position.set(side * rand(8, 13), rand(2.5, 8), rand(-8, 2));
      m.userData.ph = rand(0, TAU);
      this.world.add(m); shapes.push(m);
    }
    const sparkles = this.makeSparkles(this.quality === 'baja' ? 80 : 220, 0x05d9e8, [-20, 20], [0, 14], [-30, 6]);
    sparkles.material.size = 0.1;
    this.updaters.push((t, dt) => {
      gridTex.offset.y += dt * (this.mood === 'tense' ? 0.12 : 0.6);
      for (const s of shapes) { s.rotation.x += dt * 0.4; s.rotation.y += dt * 0.6; s.position.y += Math.sin(t + s.userData.ph) * dt * 0.4; }
      inner.rotation.z = t * 0.3;
      if (ring) ring.material.color.setHSL((t * 0.05) % 1, 1, 0.55).multiplyScalar(2.2);
    });
  }

  buildTorre(T) {
    // Mar
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(260, 260, 44, 44), new THREE.MeshStandardMaterial({ color: 0x1597b8, flatShading: true, roughness: 0.25, metalness: 0.15 }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -1.6;
    this.world.add(sea);
    const sp = sea.geometry.attributes.position;
    const base = Float32Array.from(sp.array);
    // Isla
    const islandGeo = new THREE.CylinderGeometry(10, 7.5, 3.4, 14, 2);
    const ip = islandGeo.attributes.position;
    for (let i = 0; i < ip.count; i++) { if (ip.getY(i) < 1.6) { ip.setX(i, ip.getX(i) * rand(0.9, 1.1)); ip.setZ(i, ip.getZ(i) * rand(0.9, 1.1)); } }
    islandGeo.computeVertexNormals();
    const island = new THREE.Mesh(islandGeo, flat(0xe9cf98, { roughness: 0.95 }));
    island.position.y = -1.7;
    const grass = new THREE.Mesh(new THREE.CylinderGeometry(9.4, 9.9, 0.4, 14), flat(0x6fc276, { roughness: 0.9 }));
    grass.position.y = -0.05;
    this.world.add(island, grass);
    this.buildStageDisc(0xd9cbb0, null, 1, 12);
    // Palmeras
    const palm = (x, z, s) => {
      const g = new THREE.Group();
      let px = 0, py = 0;
      for (let i = 0; i < 6; i++) {
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.18 - i * 0.015, 0.22 - i * 0.015, 0.75, 6), flat(i % 2 ? 0x8a5a2b : 0x9c6b3c));
        px += 0.07 * i; py += 0.7;
        seg.position.set(px, py, 0); seg.rotation.z = -0.08 * i;
        g.add(seg);
      }
      for (let k = 0; k < 7; k++) {
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.35, 2.6, 4), flat(k % 2 ? 0x3fa34d : 0x58b85f));
        leaf.position.set(px, py + 0.35, 0);
        leaf.rotation.set(0, (k / 7) * TAU, 0);
        leaf.rotateZ(1.75);
        leaf.translateY(1.1);
        leaf.scale.z = 0.25;
        g.add(leaf);
      }
      g.position.set(x, 0, z); g.scale.setScalar(s); g.rotation.y = rand(0, TAU);
      this.world.add(g);
      return g;
    };
    const palms = [palm(-8, 2.5, 1.1), palm(8.2, 1.5, 1.2), palm(-7, -4.5, 1), palm(7.4, -4, 0.95)];
    for (let i = 0; i < 10; i++) {
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(rand(0.3, 0.8), 0), flat(0x9aa3a8, { roughness: 0.9 }));
      const a = rand(0, TAU), d = rand(8.4, 9.6);
      r.position.set(Math.cos(a) * d, 0.1, Math.sin(a) * d);
      this.world.add(r);
    }
    // Nubes y gaviotas
    const clouds = [];
    for (let i = 0; i < 7; i++) {
      const cl = new THREE.Group();
      for (let k = 0; k < 4; k++) {
        const b = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(1, 2), 0), flat(0xffffff, { roughness: 1 }));
        b.position.set(k * 1.5 - 2, rand(-0.3, 0.5), rand(-0.5, 0.5));
        cl.add(b);
      }
      cl.position.set(rand(-40, 40), rand(14, 22), rand(-60, -25));
      cl.userData.v = rand(0.4, 1);
      this.world.add(cl); clouds.push(cl);
    }
    const birds = [];
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Group();
      const wl = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.04, 0.18), flat(0xffffff));
      const wr = wl.clone();
      wl.position.x = -0.35; wr.position.x = 0.35;
      b.add(wl, wr);
      b.userData = { r: rand(10, 16), h: rand(9, 13), ph: rand(0, TAU), sp: rand(0.15, 0.3), wl, wr };
      this.world.add(b); birds.push(b);
    }
    this.updaters.push((t, dt) => {
      const a = sp.array;
      for (let i = 0; i < sp.count; i++) {
        const x = base[i * 3], y = base[i * 3 + 1];
        a[i * 3 + 2] = Math.sin(x * 0.18 + t * 1.1) * 0.35 + Math.cos(y * 0.22 + t * 0.8) * 0.3;
      }
      sp.needsUpdate = true;
      for (const c of clouds) { c.position.x += c.userData.v * dt; if (c.position.x > 50) c.position.x = -50; }
      for (const b of birds) {
        const u = b.userData, ang = t * u.sp + u.ph;
        b.position.set(Math.cos(ang) * u.r, u.h + Math.sin(t + u.ph) * 0.5, Math.sin(ang) * u.r - 4);
        b.rotation.y = -ang;
        const f = Math.sin(t * 9 + u.ph) * 0.5;
        u.wl.rotation.z = f; u.wr.rotation.z = -f;
      }
      palms.forEach((p, i) => { p.rotation.z = Math.sin(t * 0.8 + i) * 0.03; });
    });
  }

  buildScreen(style) {
    const W = 1024, H = 440;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const g = new THREE.Group();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 3.6), new THREE.MeshBasicMaterial({ map: tex, color: style === 'neon' ? new THREE.Color(1.25, 1.25, 1.25) : 0xffffff, fog: false }));
    g.add(plane);
    if (style === 'neon') {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(8.8, 4, 0.2), flat(0x0c0620, { metalness: 0.6, roughness: 0.3 }));
      frame.position.z = -0.12;
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(8.6, 3.8)), new THREE.LineBasicMaterial({ color: new THREE.Color(THEME_DEF[this.theme].accent[1]).multiplyScalar(2.4) }));
      edge.position.z = 0.01;
      g.add(frame, edge);
    } else {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(9, 4.2, 0.4), flat(0xffffff, { roughness: 0.4 }));
      frame.position.z = -0.22;
      const legs = [-3.2, 3.2].map(x => { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 6, 8), flat(0xff8fc4)); l.position.set(x, -3.8, -0.3); return l; });
      g.add(frame, ...legs);
    }
    g.position.set(0, 6.6, -9);
    this.world.add(g);
    this.screen = { canvas, tex, style };
  }

  setScreen(lines) {
    this.screenLines = lines;
    if (!this.screen) return;
    const { canvas, tex, style } = this.screen;
    const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    const T = THEME_DEF[this.theme];
    const neonStyle = style === 'neon';
    const bg = g.createLinearGradient(0, 0, 0, H);
    if (neonStyle) { bg.addColorStop(0, '#120634'); bg.addColorStop(1, '#05020f'); } else { bg.addColorStop(0, '#fff7fb'); bg.addColorStop(1, '#e6f6ff'); }
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const hex = c => '#' + new THREE.Color(c).getHexString();
    if (lines.top) { g.font = `700 52px ${FONT}`; g.fillStyle = neonStyle ? hex(T.accent[1]) : '#3ab0ff'; g.fillText(lines.top, W / 2, 82); }
    if (lines.big) {
      g.font = `800 ${lines.big.length > 14 ? 96 : 128}px ${FONT}`;
      g.shadowColor = neonStyle ? hex(T.accent[0]) : 'rgba(0,0,0,.15)'; g.shadowBlur = neonStyle ? 30 : 6;
      g.fillStyle = neonStyle ? '#ffd76a' : '#ff5fa2';
      g.fillText(lines.big, W / 2, H / 2 + 8);
      g.shadowBlur = 0;
    }
    if (lines.bottom) { g.font = `700 46px ${FONT}`; g.fillStyle = neonStyle ? '#e9ddff' : '#5a4f86'; g.fillText(lines.bottom, W / 2, H - 70); }
    tex.needsUpdate = true;
  }

  buildAudience(T) {
    const rows = 4, perRow = 11;
    const count = rows * perRow * 2;
    const bodyGeo = new THREE.CylinderGeometry(0.28, 0.36, 0.7, 6);
    const headGeo = new THREE.IcosahedronGeometry(0.3, 0);
    const toy = this.theme === 'juguete';
    const bodies = new THREE.InstancedMesh(bodyGeo, flat(0xffffff, { roughness: 0.8 }), count);
    const heads = new THREE.InstancedMesh(headGeo, flat(0xffffff, { roughness: 0.8 }), count);
    const palette = toy ? [0xff8fab, 0x8fd3ff, 0xffd166, 0xa0e8af, 0xcdb4ff] : [0x5b3fa0, 0x3c2a7a, 0x7a2f8a, 0x2f4a9a, 0x4b3a8f];
    const seats = [];
    const steps = [];
    for (const side of [-1, 1]) {
      for (let r = 0; r < rows; r++) {
        const R = 11 + r * 1.35, y = 0.35 + r * 0.75;
        for (let k = 0; k < perRow; k++) {
          const a = side * (0.95 + (k / (perRow - 1)) * 0.95);
          seats.push({ x: Math.sin(a) * R, z: -Math.cos(a) * R + 3, y, a, ph: rand(0, TAU), amp: rand(0.6, 1.2) });
        }
        for (let s = 0; s < 6; s++) {
          const a = side * (0.92 + (s / 5) * 1.0);
          const box = new THREE.BoxGeometry(2.3, y, 1.3);
          box.rotateY(-a);
          box.translate(Math.sin(a) * R, y / 2 - 0.35, -Math.cos(a) * R + 3);
          steps.push(box);
        }
      }
    }
    const tiers = new THREE.Mesh(mergeGeometries(steps), flat(toy ? 0xffffff : 0x1a1036, { roughness: 0.6, metalness: toy ? 0 : 0.3 }));
    this.world.add(tiers);
    const c = new THREE.Color();
    seats.forEach((s, i) => {
      c.set(palette[i % palette.length]);
      bodies.setColorAt(i, c);
      heads.setColorAt(i, c.offsetHSL(0, 0, toy ? 0.05 : 0.08));
    });
    this.world.add(bodies, heads);
    const dummy = new THREE.Object3D();
    this.audience = { seats, bodies, heads };
    this.updaters.push((t) => {
      const mood = this.mood;
      seats.forEach((s, i) => {
        let jump = Math.sin(t * 2 + s.ph) * 0.03;
        let lean = 0;
        if (mood === 'cheer') jump = Math.abs(Math.sin(t * 9 * s.amp + s.ph)) * 0.45;
        else if (mood === 'sad') { jump = -0.08; lean = 0.35; }
        else if (mood === 'tense') jump = Math.sin(t * 6 + s.ph) * 0.015;
        dummy.position.set(s.x, s.y + 0.35 + jump, s.z);
        dummy.rotation.set(0, -s.a + Math.PI, 0);
        dummy.updateMatrix();
        bodies.setMatrixAt(i, dummy.matrix);
        dummy.position.y += 0.55;
        dummy.rotation.x = lean;
        dummy.updateMatrix();
        heads.setMatrixAt(i, dummy.matrix);
      });
      bodies.instanceMatrix.needsUpdate = true;
      heads.instanceMatrix.needsUpdate = true;
    });
  }

  buildCoin(show) {
    if (!show) { this.coin = null; return; }
    const faceTex = canvasTex(256, 256, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2);
      gr.addColorStop(0, '#ffe8a3'); gr.addColorStop(0.7, '#f5b82e'); gr.addColorStop(1, '#b77a0a');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#a86d06'; g.lineWidth = 10; g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 20, 0, TAU); g.stroke();
      g.fillStyle = '#9a6205'; g.font = `800 112px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('1M', w / 2, h / 2 + 8);
    });
    const gold = new THREE.MeshStandardMaterial({ color: 0xf2b632, metalness: 1, roughness: 0.28 });
    const face = new THREE.MeshStandardMaterial({ map: faceTex, metalness: 0.75, roughness: 0.32 });
    const coin = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.24, 32), [gold, face, face]);
    coin.rotation.x = Math.PI / 2;
    const holder = new THREE.Group();
    holder.add(coin);
    holder.position.set(0, 5.2, -2.5);
    this.world.add(holder);
    this.coin = holder;
  }

  // ---------- torre de premios ----------
  setLadder(len, level, safe) {
    const changed = len !== this.ladder.len || JSON.stringify(safe) !== JSON.stringify(this.ladder.safe);
    this.ladder.len = len; this.ladder.level = level; this.ladder.safe = safe || [];
    if (changed) this.buildTower();
  }

  buildTower() {
    disposeTree(this.towerGroup);
    this.towerGroup.clear();
    const { len, safe } = this.ladder;
    const T = THEME_DEF[this.theme];
    const slabs = [];
    if (this.theme === 'torre') {
      const totalH = 10, h = totalH / len;
      for (let i = 0; i < len; i++) {
        const r = 2.3 - (i / len) * 0.9;
        const floor = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.08, h * 0.86, 8), flat(0xd8c4a0, { roughness: 0.9 }));
        floor.position.y = i * h + h * 0.43;
        const win = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.03, r + 0.03, h * 0.34, 8, 1, true), new THREE.MeshStandardMaterial({ color: 0x3a2a1a, emissive: 0xffb347, emissiveIntensity: 0, flatShading: true }));
        win.position.y = floor.position.y + h * 0.05;
        const ledge = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.16, r + 0.16, 0.08, 8), flat(safe.includes(i) ? 0xe76f51 : 0x9c8a6e));
        ledge.position.y = i * h + h * 0.9;
        this.towerGroup.add(floor, win, ledge);
        if (safe.includes(i)) {
          for (let k = 0; k < 4; k++) {
            const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32), flat(0xe76f51, { side: THREE.DoubleSide }));
            const a = (k / 4) * TAU + 0.4;
            flag.position.set(Math.cos(a) * (r + 0.25), ledge.position.y + 0.25, Math.sin(a) * (r + 0.25));
            flag.rotation.y = -a;
            this.towerGroup.add(flag);
          }
        }
        slabs.push({ mat: win.material, y: floor.position.y, safe: safe.includes(i) });
      }
      // Cofre del tesoro en la cima
      const chest = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.7, 0.8), flat(0x8b5a2b));
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.2, 8, 1, false, 0, Math.PI), flat(0x9c6b3c));
      lid.rotation.z = Math.PI / 2; lid.position.y = 0.35;
      const bands = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.12, 0.84), new THREE.MeshStandardMaterial({ color: 0xf2b632, metalness: 1, roughness: 0.3 }));
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd76a, map: dotTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(2.2); glow.position.y = 0.6;
      chest.add(box, lid, bands, glow);
      chest.position.y = totalH + 0.35;
      this.towerGroup.add(chest);
      // Bandera del equipo que sube piso a piso
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 5), flat(0x5a4632));
      pole.position.y = 0.7;
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.45), flat(0xffd23f, { side: THREE.DoubleSide }));
      cloth.position.set(0.37, 1.15, 0);
      const marker = new THREE.Group();
      marker.add(pole, cloth);
      marker.position.set(0, 0, 2.5);
      this.towerGroup.add(marker);
      this.towerGroup.position.set(0, 0, -7.5);
      this.tower = { slabs, marker, h, cloth, chest, kind: 'torre' };
    } else {
      const h = 0.34;
      const slabGeo = new THREE.CylinderGeometry(0.72, 0.72, 0.2, 6);
      for (let i = 0; i < len; i++) {
        const mat = new THREE.MeshStandardMaterial({ color: 0x241a48, emissive: 0x000000, metalness: 0.4, roughness: 0.4, flatShading: true });
        if (this.theme === 'juguete') mat.color.set(0xffffff);
        const s = new THREE.Mesh(slabGeo, mat);
        s.position.y = 0.3 + i * h;
        this.towerGroup.add(s);
        if (safe.includes(i)) {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.035, 4, 6), neon(T.accent[1], 2));
          ring.rotation.x = Math.PI / 2; ring.position.y = s.position.y;
          this.towerGroup.add(ring);
        }
        slabs.push({ mat, y: s.position.y, safe: safe.includes(i), mesh: s });
      }
      const topCoin = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.1, 24), new THREE.MeshStandardMaterial({ color: 0xf2b632, metalness: 1, roughness: 0.25, emissive: 0x5a3a00 }));
      topCoin.rotation.x = Math.PI / 2;
      topCoin.position.y = 0.3 + len * h + 0.5;
      this.towerGroup.add(topCoin);
      this.towerGroup.position.set(7.6, this.stageTop - 0.36, -3.2);
      this.tower = { slabs, h, topCoin, kind: 'side' };
    }
    this.ladder.shown = -1;
  }

  updateTower(t) {
    const tw = this.tower;
    if (!tw) return;
    const { level } = this.ladder;
    const T = THEME_DEF[this.theme];
    const gold = new THREE.Color(T.accent[2]), cur = new THREE.Color(0xffffff), safeC = new THREE.Color(T.accent[1]);
    tw.slabs.forEach((s, i) => {
      if (tw.kind === 'torre') {
        s.mat.emissiveIntensity = i < level ? 1.4 : i === level ? 0.6 + Math.sin(t * 5) * 0.5 : 0;
      } else {
        if (i < level) { s.mat.emissive.copy(s.safe ? safeC : gold); s.mat.emissiveIntensity = 1.3; }
        else if (i === level && this.mode === 'game') { s.mat.emissive.copy(cur); s.mat.emissiveIntensity = 0.5 + Math.sin(t * 5) * 0.35; }
        else { s.mat.emissive.set(0x000000); s.mat.emissiveIntensity = 0; }
      }
    });
    if (tw.kind === 'torre') {
      const ty = Math.min(level, this.ladder.len) * tw.h;
      tw.marker.position.y = lerp(tw.marker.position.y, ty, 0.06);
      tw.cloth.rotation.y = Math.sin(t * 4) * 0.25;
      tw.chest.rotation.y = Math.sin(t * 0.6) * 0.2;
    } else if (tw.topCoin) {
      tw.topCoin.rotation.z = t * 1.5;
    }
  }

  // ---------- podios y avatares ----------
  setPlayers(players) {
    this.lastPlayers = players;
    const list = players.slice(0, 4);
    const key = this.theme + '|' + list.map(p => `${p.id}:${p.av.color}.${p.av.eyes}.${p.av.mouth}.${p.av.hat}:${p.name}`).join(',');
    if (key === this.playersKey) return;
    this.playersKey = key;
    const prevAnims = new Map(this.podiums.map(p => [p.id, p.anim]));
    for (const p of this.podiums) { p.group.remove(p.avatar); disposeAvatar(p.avatar); disposeTree(p.group); }
    this.podiumGroup.clear();
    this.podiums = [];
    const n = list.length;
    list.forEach((pl, i) => {
      const x = (i - (n - 1) / 2) * 2.7;
      const z = 1.2 - Math.abs(x) * 0.22;
      const color = AVATAR.colors[pl.av.color % AVATAR.colors.length] || '#ffffff';
      const group = new THREE.Group();
      group.position.set(x, this.stageTop, z);
      group.rotation.y = -x * 0.05;
      const pod = this.podiumMesh(color);
      group.add(pod);
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.75, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, map: dotTex(), depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2; shadow.position.y = 1.13;
      group.add(shadow);
      const avatar = buildAvatar(pl.av);
      avatar.position.y = 1.12;
      group.add(avatar);
      const tag = textSprite(pl.name || 'Jugador', { bg: color, fg: this.readableOn(color), size: 56, height: 0.42 });
      tag.position.set(0, 0.5, 1.05);
      group.add(tag);
      this.podiumGroup.add(group);
      const anim = prevAnims.get(pl.id) || 'idle';
      setAvatarAnim(avatar, anim);
      this.podiums.push({ id: pl.id, group, avatar, tag, sign: null, signKey: '', anim, color });
    });
  }

  readableOn(hex) {
    const c = new THREE.Color(hex);
    const l = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    return l > 0.6 ? '#1a1033' : '#ffffff';
  }

  setAnim(id, anim) {
    const p = this.podiums.find(x => x.id === id);
    if (p && p.anim !== anim) { p.anim = anim; setAvatarAnim(p.avatar, anim); }
  }
  setAllAnim(anim) { for (const p of this.podiums) this.setAnim(p.id, anim); }

  // Cartelito sobre la cabeza con la letra votada.
  setSign(id, text, color = '#ffffff') {
    const p = this.podiums.find(x => x.id === id);
    if (!p) return;
    const key = text ? text + color : '';
    if (key === p.signKey) return;
    p.signKey = key;
    if (p.sign) { p.group.remove(p.sign); p.sign.material.map.dispose(); p.sign.material.dispose(); p.sign = null; }
    if (!text) return;
    const sp = textSprite(text, { bg: color, fg: this.readableOn(color), size: 72, height: 0.62, radius: 40, border: '#ffffff' });
    sp.position.set(0, 4.0, 0);
    sp.userData.born = this.time;
    p.group.add(sp);
    p.sign = sp;
  }

  react(id, emoji) {
    const p = this.podiums.find(x => x.id === id);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTex(emoji), transparent: true, depthWrite: false }));
    const base = p ? p.group.position.clone().add(new V3(rand(-0.3, 0.3), 3.6, 0.2)) : new V3(rand(-3, 3), 4, 1);
    sp.position.copy(base);
    sp.scale.setScalar(0.01);
    this.fxGroup.add(sp);
    this.floaters.push({ sp, t: 0, base, drift: rand(-0.4, 0.4) });
  }

  // ---------- efectos ----------
  initConfetti() {
    const n = this.quality === 'baja' ? 140 : 320;
    const geo = new THREE.PlaneGeometry(0.16, 0.09);
    this.conf = { mesh: new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), n), parts: [], active: false };
    const pal = [0xff2fb3, 0x21e6e0, 0xffc93c, 0x7bd389, 0xffffff, 0x8b5cf6];
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      this.conf.parts.push({ p: new V3(0, -10, 0), v: new V3(), r: new THREE.Euler(), w: new V3(rand(-6, 6), rand(-6, 6), rand(-6, 6)), live: false, ph: rand(0, TAU) });
      this.conf.mesh.setColorAt(i, c.set(pal[i % pal.length]));
    }
    this.conf.mesh.frustumCulled = false;
    this.fxGroup.add(this.conf.mesh);
    this.conf.dummy = new THREE.Object3D();
    this.hideConfetti();
  }
  hideConfetti() {
    const d = this.conf.dummy;
    d.scale.setScalar(0); d.updateMatrix();
    for (let i = 0; i < this.conf.parts.length; i++) { this.conf.mesh.setMatrixAt(i, d.matrix); this.conf.parts[i].live = false; }
    this.conf.mesh.instanceMatrix.needsUpdate = true;
  }
  confetti(power = 1) {
    if (this.reduceMotion) return;
    for (const pt of this.conf.parts) {
      pt.p.set(rand(-7, 7), rand(8, 12), rand(-3, 3));
      pt.v.set(rand(-1, 1), rand(-1.5, 1) * power, rand(-0.6, 0.8));
      pt.live = true;
    }
    this.conf.active = true;
  }
  updateConfetti(dt, t) {
    if (!this.conf.active) return;
    const d = this.conf.dummy;
    let alive = 0;
    this.conf.parts.forEach((pt, i) => {
      if (!pt.live) return;
      pt.v.y -= 2.2 * dt;
      pt.v.multiplyScalar(0.985);
      pt.p.addScaledVector(pt.v, dt);
      pt.p.x += Math.sin(t * 3 + pt.ph) * dt * 0.8;
      pt.r.x += pt.w.x * dt; pt.r.y += pt.w.y * dt; pt.r.z += pt.w.z * dt;
      if (pt.p.y < 0) { pt.live = false; d.scale.setScalar(0); } else { alive++; d.scale.setScalar(1); }
      d.position.copy(pt.p); d.rotation.copy(pt.r); d.updateMatrix();
      this.conf.mesh.setMatrixAt(i, d.matrix);
    });
    this.conf.mesh.instanceMatrix.needsUpdate = true;
    if (!alive) this.conf.active = false;
  }

  fireworks(count = 6) {
    if (this.reduceMotion) return;
    const pal = THEME_DEF[this.theme].accent.concat([0xffffff, 0x7bd389]);
    for (let k = 0; k < count; k++) {
      setTimeout(() => {
        const n = this.quality === 'baja' ? 50 : 110;
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(n * 3);
        const vel = [];
        const origin = new V3(rand(-8, 8), rand(7, 11), rand(-6, -1));
        for (let i = 0; i < n; i++) {
          pos.set([origin.x, origin.y, origin.z], i * 3);
          const v = new V3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(3, 5.5));
          vel.push(v);
        }
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({ color: new THREE.Color(pal[k % pal.length]).multiplyScalar(2), size: 0.22, map: dotTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
        const pts = new THREE.Points(geo, mat);
        this.fxGroup.add(pts);
        this.bursts.push({ pts, vel, t: 0 });
      }, k * 380);
    }
  }
  updateBursts(dt) {
    this.bursts = this.bursts.filter(b => {
      b.t += dt;
      const a = b.pts.geometry.attributes.position.array;
      b.vel.forEach((v, i) => { v.y -= 2.5 * dt; v.multiplyScalar(0.97); a[i * 3] += v.x * dt; a[i * 3 + 1] += v.y * dt; a[i * 3 + 2] += v.z * dt; });
      b.pts.geometry.attributes.position.needsUpdate = true;
      b.pts.material.opacity = Math.max(0, 1 - b.t / 1.8);
      if (b.t > 1.8) { this.fxGroup.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); return false; }
      return true;
    });
  }
  updateFloaters(dt) {
    this.floaters = this.floaters.filter(f => {
      f.t += dt;
      const k = f.t / 2.2;
      f.sp.position.set(f.base.x + Math.sin(f.t * 3) * 0.15 + f.drift * k, f.base.y + k * 1.6, f.base.z);
      const s = Math.min(1, f.t * 6) * 0.8 * (1 - Math.max(0, k - 0.7) / 0.3);
      f.sp.scale.setScalar(Math.max(0.001, s));
      if (k >= 1) { this.fxGroup.remove(f.sp); f.sp.material.dispose(); return false; }
      return true;
    });
  }

  shake(a = 0.4) { if (!this.reduceMotion) this.cam.shake = Math.max(this.cam.shake, a); }
  setMood(m) { this.mood = m; this.moodT = 0; }
  setMode(m) { this.mode = m; }
  cameraShot(s) { this.shot = s; this.shotT = 0; }

  cameraTarget(t) {
    const pos = new V3(), look = new V3(0, 2.5, 0);
    const far = this.portrait ? 1.35 : 1;
    if (this.mode === 'home') {
      const a = t * 0.07;
      pos.set(Math.sin(a) * 15.5 * far, 5.6, Math.cos(a) * 15.5 * far);
      look.set(0, 3, 0);
    } else if (this.mode === 'lobby') {
      pos.set(Math.sin(t * 0.15) * 1.6, 4.1, 12.6 * far);
      look.set(0, 2.6, 0);
    } else {
      switch (this.shot) {
        case 'lock': pos.set(Math.sin(t * 0.3) * 0.6, 3.5, 9.6 * far); look.set(0, 2.7, 0); break;
        case 'reveal': pos.set(0, 4.6, 11.2 * far); look.set(0, 2.9, 0); break;
        case 'over': { const a = t * 0.12; pos.set(Math.sin(a) * 13 * far, 5.4, Math.cos(a) * 13 * far); look.set(0, 3, 0); break; }
        case 'tower': pos.set(this.theme === 'torre' ? 3 : 3.5, 6, 11 * far); look.set(this.theme === 'torre' ? 0 : 5, 5, -4); break;
        default: pos.set(Math.sin(t * 0.18) * 1.4, 4.4, 12.4 * far); look.set(0, 2.7, 0);
      }
    }
    return { pos, look };
  }

  loop() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    const t = this.time;
    // Cámara suave
    const { pos, look } = this.cameraTarget(t);
    const k = 1 - Math.pow(0.02, dt);
    this.cam.pos.lerp(pos, k);
    this.cam.look.lerp(look, k);
    this.camera.position.copy(this.cam.pos);
    if (this.cam.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.cam.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.cam.shake;
      this.cam.shake *= Math.pow(0.04, dt);
    }
    this.camera.lookAt(this.cam.look);
    const f = this.framing;
    if (Math.abs(f.x - f.tx) > 0.0005 || Math.abs(f.y - f.ty) > 0.0005) {
      f.x = lerp(f.x, f.tx, k); f.y = lerp(f.y, f.ty, k);
      this.applyFraming();
    }
    for (const u of this.updaters) u(t, dt);
    for (const p of this.podiums) {
      updateAvatar(p.avatar, dt, t);
      if (p.sign) {
        const age = t - p.sign.userData.born;
        const s = Math.min(1, age * 5);
        p.sign.position.y = 4.0 + Math.sin(t * 3) * 0.05;
        p.sign.material.opacity = s;
      }
    }
    if (this.coin) {
      this.coin.visible = this.mode !== 'game';
      this.coin.rotation.y = t * 1.2;
      this.coin.position.y = 5.2 + Math.sin(t * 1.4) * 0.22;
    }
    this.updateTower(t);
    this.updateConfetti(dt, t);
    this.updateBursts(dt);
    this.updateFloaters(dt);
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
