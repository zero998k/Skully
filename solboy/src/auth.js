import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Password storage: scrypt with a random salt, so the .env never holds the password itself.
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password ?? ''), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const SESSION_DAYS = 30;
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

const tokenId = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Logins for server mode. Sessions are kept in a file (only a hash of each login, never the login itself)
 * so restarts and updates don't log you out.
 * After 10 wrong passwords in a row, logins pause for 15 minutes, which stops password guessing.
 */
export function createAuth(getHash, sessionFile) {
  const sessions = new Map();
  try {
    for (const [id, expires] of Object.entries(JSON.parse(fs.readFileSync(sessionFile, 'utf8')))) if (expires > Date.now()) sessions.set(id, expires);
  } catch {}
  const save = () => {
    if (!sessionFile) return;
    try {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    } catch {}
  };
  let fails = 0;
  let lockedUntil = 0;

  function cookieToken(req) {
    const m = /(?:^|;\s*)solboy=([a-f0-9]{64})/.exec(req.headers.cookie ?? '');
    return m?.[1];
  }

  return {
    isLoggedIn(req) {
      const token = cookieToken(req);
      const expires = token && sessions.get(tokenId(token));
      if (!expires) return false;
      if (expires < Date.now()) {
        sessions.delete(tokenId(token));
        save();
        return false;
      }
      return true;
    },

    /** Returns a Set-Cookie value on success, or throws a message to show. */
    async login(req, password) {
      if (Date.now() < lockedUntil) throw new Error('Too many wrong passwords. Try again in 15 minutes.');
      await new Promise((r) => setTimeout(r, 400)); // slows down guessing
      if (!checkPassword(password, getHash())) {
        if (++fails >= MAX_FAILS) {
          fails = 0;
          lockedUntil = Date.now() + LOCK_MS;
        }
        throw new Error('Wrong password.');
      }
      fails = 0;
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(tokenId(token), Date.now() + SESSION_DAYS * 86_400_000);
      save();
      const https = req.headers['x-forwarded-proto'] === 'https' || /\.ts\.net$/i.test((req.headers.host ?? '').replace(/:\d+$/, ''));
      return `solboy=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${https ? '; Secure' : ''}`;
    },

    logout(req) {
      const token = cookieToken(req);
      if (token) sessions.delete(tokenId(token));
      save();
      return 'solboy=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
    },

    /** Re-check the password for risky actions (withdraw, showing the key, real money). */
    confirm(password) {
      if (!checkPassword(password, getHash())) throw new Error('Wrong password.');
    },
  };
}
