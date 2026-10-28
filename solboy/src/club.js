// Social Lobby: profiles (username, picture, banner, bio), a group chat, direct messages, reactions, shared
// Finder cards and a coin "calls" leaderboard. It lives on the owner's computer (data/club.json); friends join
// through the Share link with a username and password, so it's only on while the owner's SolBoy runs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { file } from './paths.js';

const HOST = 'host';
const MAX_MEMBERS = 100, KEEP_MESSAGES = 400;
const NAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;
const COLORS = ['#ff2d95', '#5ce1ff', '#ffd23f', '#a98bff', '#4ade80', '#ff6bcb', '#ffb020', '#7dd3fc'];
const REACTIONS = ['🔥', '🚀', '😂', '💀', '👀', '💎'];

const isAddress = (a) => { try { return new PublicKey(a).toBase58() === a; } catch { return false; } };
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const str = (x, max) => String(x ?? '').slice(0, max);

export function createClub({ coinInfo, hostStats }) {
  const where = file('data/club.json');
  let db;
  try { db = JSON.parse(fs.readFileSync(where, 'utf8')); } catch { db = {}; }
  db.members ??= {}; db.rooms ??= {}; db.calls ??= []; db.sessions ??= {}; db.nextId ??= 1;
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(where), { recursive: true });
        fs.writeFileSync(`${where}.tmp`, JSON.stringify(db));
        fs.renameSync(`${where}.tmp`, where);
      } catch {}
    }, 300);
  };
  const seen = new Map(); // member id -> last request time (online dots)
  const lastPost = new Map();
  const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

  const hash = (password, salt) => crypto.scryptSync(String(password), salt, 32).toString('hex');
  const byName = (name) => Object.values(db.members).find((m) => m.name.toLowerCase() === String(name).toLowerCase());
  const pub = (m) => ({
    id: m.id, name: m.name, bio: m.bio ?? '', color: m.color, joined: m.joined, host: m.id === HOST,
    avatar: m.avatar ? m.av ?? 1 : 0, banner: m.banner ? m.bv ?? 1 : 0, online: Date.now() - (seen.get(m.id) ?? 0) < 45_000,
    lastSeen: seen.get(m.id) ?? m.lastSeen ?? null,
    calls: db.calls.filter((c) => c.by === m.id).length,
  });
  function newSession(id) {
    const token = crypto.randomBytes(24).toString('base64url');
    db.sessions[token] = { id, at: Date.now() };
    save();
    return token;
  }
  function checkImage(dataUrl, maxBytes) {
    if (dataUrl === null || dataUrl === '') return null;
    const m = IMAGE_RE.exec(String(dataUrl));
    if (!m) throw fail('Pictures must be PNG, JPG or WebP.');
    if ((m[2].length * 3) / 4 > maxBytes) throw fail('That picture is too big.');
    return dataUrl;
  }
  const roomOk = (room, me) => room === 'lounge' || (room.startsWith('dm:') && room.split(':').slice(1).includes(me) && room.split(':').slice(1).every((id) => db.members[id]));
  const dmRoom = (a, b) => `dm:${[a, b].sort().join(':')}`;

  // A shared card (from the Finder, a call, or the host's PnL): only known fields, checked, go in.
  function cleanCard(card, me) {
    if (!card || typeof card !== 'object') return null;
    if (card.type === 'wallet' && isAddress(card.address)) return { type: 'wallet', address: card.address, verdict: str(card.verdict, 60), winRate: num(card.winRate), pnl30d: num(card.pnl30d), netWorth: num(card.netWorth) };
    if (card.type === 'coin' && isAddress(card.mint)) return { type: 'coin', mint: card.mint, symbol: str(card.symbol, 16), name: str(card.name, 40), mcUsd: num(card.mcUsd) };
    if (card.type === 'pnl' && me === HOST) { const s = hostStats(); return { type: 'pnl', total: s.totalPnl, today: s.todayPnl, winRate: s.winRate, trades: s.sells, streak: s.streak }; }
    return null;
  }

  function post(me, room, text, card) {
    const t = Date.now();
    if (me !== HOST && t - (lastPost.get(me) ?? 0) < 700) throw fail('Slow down a little.', 429);
    lastPost.set(me, t);
    const msg = { id: db.nextId++, from: me, at: t, text: str(text, 1000).trim(), card: cleanCard(card, me), reactions: {} };
    if (!msg.text && !msg.card) throw fail('Write something first.');
    const list = (db.rooms[room] ??= []);
    list.push(msg);
    if (list.length > KEEP_MESSAGES) list.splice(0, list.length - KEEP_MESSAGES);
    save();
    return msg;
  }

  let callPrices = { at: 0, map: new Map() };
  async function priced() {
    if (Date.now() - callPrices.at > 60_000) {
      callPrices = { at: Date.now(), map: await coinInfo(db.calls.map((c) => c.mint)).catch(() => new Map()) };
    }
    return callPrices.map;
  }

  const api = {
    /** Who's asking: the host on the dashboard, or a friend's session token. */
    whoIs(session, isHost) {
      if (isHost) {
        db.members[HOST] ??= { id: HOST, name: 'host', color: COLORS[0], joined: Date.now(), bio: '' };
        seen.set(HOST, Date.now());
        return HOST;
      }
      const s = db.sessions[session];
      if (!s || !db.members[s.id] || db.members[s.id].banned) return null;
      seen.set(s.id, Date.now());
      return s.id;
    },
    signup({ name, password }) {
      if (!NAME_RE.test(String(name ?? ''))) throw fail('Pick a username of 3–20 letters, numbers, _ . or -');
      if (String(password ?? '').length < 4) throw fail('Pick a password of at least 4 characters.');
      if (byName(name) || String(name).toLowerCase() === 'host') throw fail('That username is taken.');
      if (Object.keys(db.members).length >= MAX_MEMBERS) throw fail('The Social Lobby is full.');
      const id = crypto.randomBytes(6).toString('hex'), salt = crypto.randomBytes(12).toString('hex');
      db.members[id] = { id, name: String(name), salt, pass: hash(password, salt), color: COLORS[Object.keys(db.members).length % COLORS.length], joined: Date.now(), bio: '' };
      (db.rooms.lounge ??= []).push({ id: db.nextId++, from: id, at: Date.now(), text: `👋 ${name} joined the lobby`, system: true, reactions: {} });
      save();
      return { session: newSession(id), me: pub(db.members[id]) };
    },
    login({ name, password }) {
      const m = byName(name);
      if (!m || m.id === HOST || !m.pass || hash(password, m.salt) !== m.pass) throw fail('Wrong username or password.', 401);
      if (m.banned) throw fail('The host removed you from this Social Lobby.', 403);
      return { session: newSession(m.id), me: pub(m) };
    },
    logout(session) { delete db.sessions[session]; save(); return { ok: true }; },
    me: (id) => pub(db.members[id]),
    profile(id, body) {
      const m = db.members[id];
      if (body.name !== undefined && body.name !== m.name) {
        if (!NAME_RE.test(String(body.name))) throw fail('Pick a username of 3–20 letters, numbers, _ . or -');
        const other = byName(body.name);
        if ((other && other.id !== id) || (String(body.name).toLowerCase() === 'host' && id !== HOST)) throw fail('That username is taken.');
        m.name = String(body.name);
      }
      if (body.bio !== undefined) m.bio = str(body.bio, 300);
      if (body.color !== undefined && COLORS.includes(body.color)) m.color = body.color;
      if (body.avatar !== undefined) { m.avatar = checkImage(body.avatar, 150_000); m.av = (m.av ?? 1) + 1; }
      if (body.banner !== undefined) { m.banner = checkImage(body.banner, 400_000); m.bv = (m.bv ?? 1) + 1; }
      save();
      return pub(m);
    },
    image(memberId, kind) {
      const m = db.members[memberId], data = kind === 'banner' ? m?.banner : m?.avatar;
      const x = data && IMAGE_RE.exec(data);
      return x ? { type: `image/${x[1]}`, body: Buffer.from(x[2], 'base64') } : null;
    },
    members: () => Object.values(db.members).filter((m) => !m.banned).map(pub).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name)),
    messages(me, room, after = 0) {
      if (!roomOk(room, me)) throw fail('No such chat.', 404);
      return (db.rooms[room] ?? []).filter((m) => m.id > after).slice(-150);
    },
    /** Rooms with something newer than `since`, for unread dots. */
    unread(me, since) {
      const out = {};
      for (const [room, list] of Object.entries(db.rooms)) if (roomOk(room, me)) { const n = list.filter((m) => m.id > (since[room] ?? 0) && m.from !== me).length; if (n) out[room] = n; }
      return out;
    },
    dms(me) {
      return Object.keys(db.rooms).filter((r) => r.startsWith('dm:') && roomOk(r, me)).map((r) => ({ room: r, with: r.split(':').slice(1).find((x) => x !== me) ?? me, last: db.rooms[r].at(-1)?.at ?? 0 })).sort((a, b) => b.last - a.last);
    },
    dmRoom: (me, other) => { if (!db.members[other] || other === me) throw fail('No such member.', 404); return dmRoom(me, other); },
    send: (me, { room, text, card }) => { if (!roomOk(String(room), me)) throw fail('No such chat.', 404); return post(me, String(room), text, card); },
    react(me, { room, id, emoji }) {
      if (!roomOk(String(room), me) || !REACTIONS.includes(emoji)) throw fail('Not allowed.');
      const msg = (db.rooms[room] ?? []).find((m) => m.id === Number(id));
      if (!msg) throw fail('Message not found.', 404);
      const who = (msg.reactions[emoji] ??= []);
      const i = who.indexOf(me);
      i >= 0 ? who.splice(i, 1) : who.push(me);
      if (!who.length) delete msg.reactions[emoji];
      save();
      return msg;
    },
    remove(me, { room, id }) {
      const list = db.rooms[String(room)] ?? [];
      const i = list.findIndex((m) => m.id === Number(id));
      if (i < 0 || !roomOk(String(room), me)) throw fail('Message not found.', 404);
      if (list[i].from !== me && me !== HOST) throw fail('You can only delete your own messages.', 403);
      list.splice(i, 1);
      save();
      return { ok: true };
    },
    async call(me, { mint, note }) {
      if (!isAddress(String(mint ?? '').trim())) throw fail("That isn't a coin address.");
      mint = String(mint).trim();
      const i = (await coinInfo([mint]).catch(() => new Map())).get(mint);
      if (!i?.priceSol) throw fail("SolBoy can't find a price for that coin yet.");
      const c = { id: db.nextId++, by: me, mint, at: Date.now(), priceAt: i.priceSol, mcAt: i.mcUsd ?? null, symbol: str(i.symbol, 16), name: str(i.name, 40), image: i.image ? str(i.image, 400) : null, note: str(note, 200) };
      db.calls.push(c);
      if (db.calls.length > 300) db.calls.splice(0, db.calls.length - 300);
      callPrices.at = 0;
      post(me, 'lounge', c.note, { type: 'coin', mint, symbol: c.symbol, name: c.name, mcUsd: c.mcAt }).call = c.id;
      return c;
    },
    async calls() {
      const prices = await priced();
      return db.calls.map((c) => {
        const now = prices.get(c.mint);
        return { ...c, image: now?.image ?? c.image, mcNow: now?.mcUsd ?? null, x: now?.priceSol ? now.priceSol / c.priceAt : null, byName: db.members[c.by]?.name ?? 'gone' };
      }).reverse();
    },
    kick(me, id) {
      if (me !== HOST) throw fail('Only the host can do that.', 403);
      const m = db.members[id];
      if (!m || id === HOST) throw fail('No such member.', 404);
      m.banned = true;
      for (const [t, s] of Object.entries(db.sessions)) if (s.id === id) delete db.sessions[t];
      save();
      return { ok: true };
    },
    reactions: REACTIONS, colors: COLORS,
  };
  return api;
}
