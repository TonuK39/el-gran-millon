// Chat de voz entre jugadores: WebRTC de igual a igual (malla de hasta 4 personas).
// La señalización viaja por el canal de Supabase de la sala; el audio va directo entre
// navegadores y no pasa por ningún servidor. Funciona igual en PC y celular.
import { ICE_SERVERS } from './config.js';

const SPEAK_ON = 0.04;   // nivel RMS para empezar a marcar «hablando»
const SPEAK_OFF = 0.022; // nivel para dejar de marcarlo (histéresis)
const rid = () => Math.random().toString(36).slice(2, 10);

export class Voice {
  constructor({ meId, send, onChange }) {
    this.meId = meId;
    this.send = send;
    this.onChange = onChange || (() => {});
    this.on = false;
    this.muted = false;
    this.stream = null;
    this.track = null;
    this.sid = null;          // sesión de voz propia (cambia en cada entrada)
    this.peers = new Map();   // id → { pc, audio, pendingIce, state, initiator, localMute, remoteSid }
    this.meters = new Map();  // id → { an, src, data, level, speaking }
    this.members = [];
    this.ctx = null;
    this.timer = null;
    this.needsGesture = false;
  }

  static supported() {
    return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  get listenOnly() { return this.on && !this.track; }

  // Entrar al chat de voz. Si no hay permiso de micrófono, entra solo a escuchar.
  async join({ fake = false } = {}) {
    if (this.on) return { listenOnly: !this.track };
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = this.ctx || (AC ? new AC() : null);
      if (this.ctx) await this.ctx.resume().catch(() => {});
    } catch { this.ctx = null; }
    let error = null;
    try {
      this.stream = fake && this.ctx ? this.fakeStream() : await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
      this.track = this.stream.getAudioTracks()[0] || null;
    } catch (e) {
      error = e;
      this.stream = null;
      this.track = null;
    }
    this.on = true;
    this.muted = false;
    this.sid = rid();
    if (this.stream) this.addMeter(this.meId, this.stream);
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 120);
    this.sync(this.members);
    this.onChange();
    return { listenOnly: !this.track, error };
  }

  // Tono de prueba en lugar del micrófono (solo con ?debug&fakemic).
  fakeStream() {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = 260 + Math.random() * 300;
    gain.gain.value = 0.25;
    const dest = this.ctx.createMediaStreamDestination();
    osc.connect(gain); gain.connect(dest);
    osc.start();
    return dest.stream;
  }

  leave() {
    if (!this.on) return;
    this.on = false;
    for (const id of [...this.peers.keys()]) this.dropPeer(id, true);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    for (const m of this.meters.values()) { try { m.src.disconnect(); } catch { /* ya desconectado */ } }
    this.meters.clear();
    this.stream = null;
    this.track = null;
    this.muted = false;
    this.needsGesture = false;
    clearInterval(this.timer);
    this.timer = null;
    this.onChange();
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.track) this.track.enabled = !this.muted;
    this.onChange();
  }

  // Silenciar a otra persona solo para mí.
  setPeerMuted(id, m) {
    const p = this.peers.get(id);
    if (!p) return;
    p.localMute = !!m;
    if (p.audio) p.audio.muted = p.localMute;
    this.onChange();
  }

  // Presencia de la sala → conectar con quien esté en la voz y soltar al resto.
  sync(members) {
    this.members = members || [];
    if (!this.on) return;
    const want = new Set(this.members.filter(m => m.voice && m.id !== this.meId).map(m => m.id));
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.dropPeer(id);
    for (const id of want) if (!this.peers.has(id)) this.makePeer(id);
  }

  makePeer(id) {
    const initiator = this.meId < id; // regla fija: nunca ofertan los dos a la vez
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { id, pc, initiator, audio: null, pendingIce: [], state: 'connecting', localMute: false, remoteSid: null, restarts: 0 };
    this.peers.set(id, peer);
    if (this.track) pc.addTrack(this.track, this.stream);
    else if (initiator) pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.onicecandidate = e => { if (e.candidate) this.signal(id, { kind: 'ice', cand: e.candidate.toJSON() }); };
    pc.ontrack = e => this.attach(peer, (e.streams && e.streams[0]) || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (this.peers.get(id) !== peer) return;
      const s = pc.connectionState;
      peer.state = s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : s === 'disconnected' ? 'reconnecting' : s === 'closed' ? 'closed' : 'connecting';
      if (s === 'failed' && peer.initiator && peer.restarts < 2) { peer.restarts++; this.offer(peer, true); }
      this.onChange();
    };
    if (initiator) this.offer(peer, false);
    this.onChange();
    return peer;
  }

  async offer(peer, restart) {
    try {
      const o = await peer.pc.createOffer(restart ? { iceRestart: true } : undefined);
      await peer.pc.setLocalDescription(o);
      this.signal(peer.id, { kind: 'offer', sdp: peer.pc.localDescription.sdp });
    } catch (e) { console.warn('voz: oferta', e); }
  }

  signal(to, msg) { this.send('rtc', { to, sid: this.sid, ...msg }); }

  async onSignal(from, msg) {
    if (!this.on || !msg || msg.to !== this.meId || from === this.meId) return;
    let peer = this.peers.get(from);
    // Si la otra persona recargó la página, llega una sesión nueva: se rehace la conexión.
    if (peer && msg.sid && peer.remoteSid && peer.remoteSid !== msg.sid) {
      if (msg.kind !== 'offer') return;
      this.dropPeer(from);
      peer = null;
    }
    if (!peer) {
      if (msg.kind !== 'offer') return;
      peer = this.makePeer(from);
    }
    if (msg.sid && !peer.remoteSid) peer.remoteSid = msg.sid;
    const pc = peer.pc;
    try {
      if (msg.kind === 'offer') {
        if (pc.signalingState !== 'stable' && peer.initiator) return;
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        await this.flushIce(peer);
        const a = await pc.createAnswer();
        await pc.setLocalDescription(a);
        this.signal(from, { kind: 'answer', sdp: pc.localDescription.sdp });
      } else if (msg.kind === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          await this.flushIce(peer);
        }
      } else if (msg.kind === 'ice' && msg.cand) {
        if (pc.remoteDescription) await pc.addIceCandidate(msg.cand).catch(() => {});
        else peer.pendingIce.push(msg.cand);
      }
    } catch (e) { console.warn('voz: señal', msg.kind, e); }
  }

  async flushIce(peer) {
    const list = peer.pendingIce.splice(0);
    for (const c of list) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  attach(peer, stream) {
    if (!peer.audio) {
      const a = document.createElement('audio');
      a.autoplay = true;
      a.playsInline = true;
      a.setAttribute('playsinline', '');
      a.className = 'voice-audio';
      document.body.appendChild(a);
      peer.audio = a;
    }
    peer.audio.srcObject = stream;
    peer.audio.muted = peer.localMute;
    const p = peer.audio.play();
    if (p && p.catch) p.catch(() => { this.needsGesture = true; this.onChange(); });
    const old = this.meters.get(peer.id);
    if (old) { try { old.src.disconnect(); } catch { /* nada */ } }
    this.addMeter(peer.id, stream);
  }

  // Algunos navegadores (sobre todo iPhone) solo reproducen audio tras un toque.
  resumeAudio() {
    this.needsGesture = false;
    if (this.ctx) this.ctx.resume().catch(() => {});
    for (const p of this.peers.values()) {
      if (!p.audio) continue;
      const r = p.audio.play();
      if (r && r.catch) r.catch(() => { this.needsGesture = true; this.onChange(); });
    }
    this.onChange();
  }

  addMeter(id, stream) {
    if (!this.ctx) return;
    try {
      const src = this.ctx.createMediaStreamSource(stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.meters.set(id, { an, src, data: new Float32Array(an.fftSize), level: 0, speaking: false });
    } catch (e) { console.warn('voz: medidor', e); }
  }

  dropPeer(id, quiet = false) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try { p.pc.close(); } catch { /* nada */ }
    if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
    const m = this.meters.get(id);
    if (m) { try { m.src.disconnect(); } catch { /* nada */ } }
    this.meters.delete(id);
    if (!quiet) this.onChange();
  }

  tick() {
    let changed = false;
    for (const [id, m] of this.meters) {
      m.an.getFloatTimeDomainData(m.data);
      let sum = 0;
      for (let i = 0; i < m.data.length; i++) sum += m.data[i] * m.data[i];
      const rms = Math.sqrt(sum / m.data.length);
      m.level = m.level * 0.55 + rms * 0.45;
      const silenced = id === this.meId ? this.muted : false;
      const sp = !silenced && (m.speaking ? m.level > SPEAK_OFF : m.level > SPEAK_ON);
      if (sp !== m.speaking) { m.speaking = sp; changed = true; }
    }
    if (changed) this.onChange();
  }

  isSpeaking(id) { const m = this.meters.get(id); return !!(m && m.speaking); }
  level(id) { const m = this.meters.get(id); return m ? m.level : 0; }
  peerState(id) { const p = this.peers.get(id); return p ? p.state : null; }
  peerMuted(id) { const p = this.peers.get(id); return !!(p && p.localMute); }
}
