// Share link: a public https address for the Wallet Finder, so a friend can use it in any browser without
// installing anything. It runs a free Cloudflare quick tunnel (cloudflared, downloaded once into tools/), or
// localhost.run over the computer's built-in ssh if that fails. Only the guest Finder page goes through it; the
// server refuses everything else that arrives via the tunnel. The link stops when SolBoy or the computer stops.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { file } from './paths.js';
import { log } from './log.js';

const CLOUDFLARED = {
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
  'win32-x64': 'cloudflared-windows-amd64.exe',
  'win32-arm64': 'cloudflared-windows-amd64.exe',
};

export function createShare({ port }) {
  let token = null, url = null, child = null, state = 'off', error = null, starting = null;
  const stopChild = () => { try { child?.kill(); } catch {} child = null; };
  process.on('exit', stopChild);

  async function cloudflared() {
    const name = CLOUDFLARED[`${process.platform}-${process.arch}`];
    if (!name) throw new Error('No Cloudflare tunnel for this computer.');
    const dir = file('tools');
    const bin = path.join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (fs.existsSync(bin)) return bin;
    fs.mkdirSync(dir, { recursive: true });
    const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Couldn't download the tunnel (HTTP ${res.status}).`);
    const data = Buffer.from(await res.arrayBuffer());
    if (name.endsWith('.tgz')) {
      const tgz = path.join(dir, name);
      fs.writeFileSync(tgz, data);
      await new Promise((resolve, reject) => execFile('tar', ['-xzf', tgz, '-C', dir], (e) => (e ? reject(e) : resolve())));
      fs.rmSync(tgz, { force: true });
    } else fs.writeFileSync(bin, data);
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  // Start a tunnel program and wait for it to print its public address.
  function run(cmd, args, pattern, ms = 40_000) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      const timer = setTimeout(() => { p.kill(); reject(new Error('The tunnel took too long to start.')); }, ms);
      const look = (d) => {
        out = (out + d).slice(-20_000);
        const m = out.match(pattern);
        if (m) { clearTimeout(timer); resolve({ p, url: m[0] }); }
      };
      p.stdout.on('data', look);
      p.stderr.on('data', look);
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('exit', () => { clearTimeout(timer); reject(new Error('The tunnel closed.')); });
    });
  }

  async function open() {
    const local = `http://127.0.0.1:${port}`;
    if (process.env.SHARE_TUNNEL_TEST) return { p: null, url: local }; // tests: no internet, the link is local
    try {
      return await run(await cloudflared(), ['tunnel', '--no-autoupdate', '--url', local], /https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    } catch (e) {
      log(`Cloudflare tunnel failed (${e.message}); trying localhost.run instead.`);
      return run('ssh', ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run'], /https:\/\/[a-z0-9-]+\.lhr\.life/);
    }
  }

  const status = () => ({ state, url: url && token ? `${url}/g/${token}` : null, error });

  return {
    status,
    /** The guest token in use, or null when sharing is off. */
    guestToken: () => (state === 'on' ? token : null),
    async start() {
      if (state === 'on') return status();
      starting ??= (async () => {
        state = 'starting'; error = null;
        try {
          const t = await open();
          token = crypto.randomBytes(12).toString('base64url');
          child = t.p; url = t.url; state = 'on';
          child?.on('exit', () => { if (child === t.p) { state = 'off'; url = null; token = null; child = null; log('The Finder share link closed.'); } });
          log(`Finder share link: ${url}/g/${token}`);
        } catch (e) {
          state = 'off'; error = `Couldn't make a link: ${e.message}`;
        }
        starting = null;
        return status();
      })();
      return starting;
    },
    stop() {
      stopChild();
      state = 'off'; url = null; token = null; error = null;
      return status();
    },
  };
}
