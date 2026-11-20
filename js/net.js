// Tiempo real con Supabase: una sala = un canal (presencia + broadcast). Sin tablas para jugar.
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, CODE_CHARS } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  realtime: { params: { eventsPerSecond: 30 } },
});

export function newCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
export const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

const EVENTS = ['hello', 'state', 'custom', 'act', 'chat', 'react', 'kick', 'say'];

export class Room {
  constructor(code, me, { onMembers, onMessage, onStatus }) {
    this.code = code;
    this.me = me; // {id, name, av}
    this.joinedAt = Date.now();
    this.onMembers = onMembers;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.members = [];
    this.channel = null;
    this.closed = false;
  }

  connect(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const ch = sb.channel(`egm-room-${this.code}`, {
        config: { broadcast: { self: false, ack: false }, presence: { key: this.me.id } },
      });
      this.channel = ch;
      ch.on('presence', { event: 'sync' }, () => {
        const st = ch.presenceState();
        const list = [];
        for (const key of Object.keys(st)) {
          const metas = st[key];
          if (!metas || !metas.length) continue;
          const m = metas[metas.length - 1];
          if (m && m.id) list.push({ id: m.id, name: m.name, av: m.av, joinedAt: m.joinedAt || 0 });
        }
        list.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
        this.members = list;
        this.onMembers(list);
      });
      for (const ev of EVENTS) {
        ch.on('broadcast', { event: ev }, ({ payload }) => {
          if (!payload || payload._from === this.me.id) return;
          this.onMessage(ev, payload, payload._from);
        });
      }
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('timeout')); } }, timeoutMs);
      ch.subscribe(async (status) => {
        this.onStatus(status);
        if (status === 'SUBSCRIBED') {
          await ch.track({ id: this.me.id, name: this.me.name, av: this.me.av, joinedAt: this.joinedAt });
          if (!settled) { settled = true; clearTimeout(timer); resolve(); }
        } else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !settled) {
          settled = true; clearTimeout(timer); reject(new Error(status));
        }
      });
    });
  }

  send(event, payload = {}) {
    if (!this.channel || this.closed) return;
    this.channel.send({ type: 'broadcast', event, payload: { ...payload, _from: this.me.id } }).catch(() => {});
  }

  async leave() {
    this.closed = true;
    if (this.channel) {
      try { await this.channel.untrack(); } catch { /* ignore */ }
      try { await sb.removeChannel(this.channel); } catch { /* ignore */ }
      this.channel = null;
    }
  }
}

// ---- Salas públicas («Jugar»): los anfitriones se anuncian en un canal de vestíbulo -----
export function findPublicRooms(timeoutMs = 2600) {
  return new Promise(resolve => {
    const ch = sb.channel('egm-lobby', { config: { presence: { key: 'q' + Math.random().toString(36).slice(2, 10) } } });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const rooms = [];
      try {
        const st = ch.presenceState();
        for (const k of Object.keys(st)) {
          const m = st[k][st[k].length - 1];
          if (m && m.code && Date.now() - (m.at || 0) < 6 * 3600e3) rooms.push(m);
        }
      } catch { /* ignore */ }
      sb.removeChannel(ch).catch(() => {});
      resolve(rooms);
    };
    ch.on('presence', { event: 'sync' }, () => setTimeout(finish, 500));
    ch.subscribe(s => { if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') finish(); });
    setTimeout(finish, timeoutMs);
  });
}

export class LobbyAd {
  constructor() { this.ch = null; this.info = null; this.ready = null; }
  async set(info) {
    if (!info) return this.stop();
    if (!this.ch) {
      this.ch = sb.channel('egm-lobby', { config: { presence: { key: 'r-' + info.code } } });
      this.ready = new Promise(res => this.ch.subscribe(s => { if (s === 'SUBSCRIBED') res(); }));
    }
    await this.ready;
    const key = JSON.stringify(info);
    if (key !== this.info && this.ch) { this.info = key; try { await this.ch.track({ ...info, at: Date.now() }); } catch { /* ignore */ } }
  }
  stop() {
    if (this.ch) { const ch = this.ch; this.ch = null; this.info = null; sb.removeChannel(ch).catch(() => {}); }
  }
}

// ---- Salón de la fama y reportes ----------------------------------------
export async function submitFame(entry) {
  const { error } = await sb.from('hall_of_fame').insert(entry);
  if (error) throw error;
}
export async function fetchFame(kind = 'top') {
  let q = sb.from('hall_of_fame').select('team_name,players,level_reached,ladder_length,prize,difficulty,won,created_at');
  q = kind === 'top'
    ? q.order('prize', { ascending: false }).order('level_reached', { ascending: false }).order('created_at', { ascending: true })
    : q.order('created_at', { ascending: false });
  const { data, error } = await q.limit(50);
  if (error) throw error;
  return data || [];
}
export async function fameRank(prize) {
  const { count, error } = await sb.from('hall_of_fame').select('id', { count: 'exact', head: true }).gt('prize', prize);
  if (error) return null;
  return (count || 0) + 1;
}
export async function reportQuestion(question_id, reason, note) {
  const { error } = await sb.from('question_reports').insert({ question_id, reason, note: note || null });
  if (error) throw error;
}
