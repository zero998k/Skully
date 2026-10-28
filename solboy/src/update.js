import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { VERSION } from './version.js';
import { isPackagedApp } from './paths.js';
import { log } from './log.js';

// New versions are published as GitHub releases tagged solboy-v1.2.3 (built by the repo's release workflow).
export const RESTART_CODE = 75; // tells the launcher in main.js to start SolBoy again
const REPO = 'zero998k/Skully';
const TAG = 'solboy-v';
const api = () => process.env.SOLBOY_UPDATE_API || `https://api.github.com/repos/${REPO}`;
const site = () => process.env.SOLBOY_UPDATE_SITE || `https://github.com/${REPO}`;
const ASSET = {
  'darwin-arm64': 'SolBoy-Mac-AppleSilicon',
  'darwin-x64': 'SolBoy-Mac-Intel',
  'win32-x64': 'SolBoy-Windows.exe',
  'linux-x64': 'SolBoy-Linux-x64',
  'linux-arm64': 'SolBoy-Linux-arm64',
}[`${process.platform}-${process.arch}`];

const parts = (v) => String(v).replace(/^\D*/, '').split('.').map((n) => parseInt(n, 10) || 0);
export function isNewer(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

async function get(url, ms) {
  const res = await fetch(url, { headers: { 'User-Agent': `SolBoy/${VERSION}`, Accept: 'application/vnd.github+json' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res;
}

const run = (file, args) =>
  new Promise((resolve) => execFile(file, args, { timeout: 30_000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout))));

/**
 * One-click updates: finds a newer release, downloads this computer's version, checks it's intact and
 * actually runs, then swaps the app file. Settings, keys, wallets and trades live in separate files
 * next to the app, so they're untouched. The caller then exits with RESTART_CODE.
 */
export function createUpdater() {
  const exe = process.execPath;
  const canInstall = isPackagedApp && process.argv.includes('--solboy-worker') && Boolean(ASSET);
  let latest = null;
  let checkedAt = 0;
  let error = null;
  let busy = false;
  let announced = null;

  // Old app files from earlier updates (Windows keeps them locked until the old launcher closes).
  if (canInstall) {
    for (const f of fs.readdirSync(path.dirname(exe))) {
      if (f.startsWith(`${path.basename(exe)}.old`)) fs.rm(path.join(path.dirname(exe), f), { force: true }, () => {});
    }
  }

  // GitHub's API allows 60 checks an hour per internet address; its releases feed has no such limit,
  // so it's the backup. Download links follow a fixed pattern either way.
  async function fromApi() {
    const releases = await (await get(`${api()}/releases?per_page=30`, 10_000)).json();
    return releases.filter((r) => !r.draft && !r.prerelease).map((r) => ({ tag: r.tag_name, notes: r.body, page: r.html_url }));
  }
  async function fromFeed() {
    const xml = await (await get(`${site()}/releases.atom`, 10_000)).text();
    const text = (html) =>
      html
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/<\/?strong>/g, '**').replace(/<\/(p|li)>/g, '\n').replace(/<li>/g, '- ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
      tag: /\/releases\/tag\/([^"]+)"/.exec(e)?.[1],
      notes: text(/<content[^>]*>([\s\S]*?)<\/content>/.exec(e)?.[1] ?? ''),
      page: /href="([^"]+)"/.exec(e)?.[1],
    }));
  }

  async function check(force = false) {
    if (!force && Date.now() - checkedAt < 10 * 60_000) return latest;
    checkedAt = Date.now();
    try {
      const releases = await fromApi().catch(fromFeed);
      const best = releases.filter((r) => r.tag?.startsWith(TAG)).reduce((a, r) => (!a || isNewer(r.tag, a.tag) ? r : a), null);
      latest = best && isNewer(best.tag, VERSION) ? { version: best.tag.slice(TAG.length), tag: best.tag, notes: String(best.notes ?? '').trim().slice(0, 3000), page: best.page } : null;
      error = null;
      if (latest && latest.version !== announced) {
        announced = latest.version;
        log(`SolBoy ${latest.version} is out. Click Update in the dashboard (or type update) to install it. Your settings and wallets stay.`);
      }
    } catch (e) {
      error = `Couldn't check for updates (${e.message}).`;
    }
    return latest;
  }

  function status() {
    return {
      version: VERSION,
      available: latest ? { version: latest.version, notes: latest.notes, page: latest.page } : null,
      canInstall,
      busy,
      error,
    };
  }

  async function install() {
    if (busy) throw new Error('Already updating.');
    if (!canInstall) throw new Error(isPackagedApp ? "This copy of SolBoy can't update itself. Download the new version instead." : 'Running from source: update with git pull instead.');
    const rel = await check(true);
    if (!rel) throw new Error(error ?? "You're already on the newest SolBoy.");
    const download = (name) => `${site()}/releases/download/${rel.tag}/${name}`;

    busy = true;
    const tmp = `${exe}.new`;
    try {
      let sums;
      try {
        sums = await (await get(download('SHA256SUMS'), 30_000)).text();
      } catch {
        throw new Error("The new version isn't fully uploaded yet. Try again in a few minutes.");
      }
      const listed = sums.split('\n').map((l) => l.trim().split(/\s+\*?/));
      const expected = listed.find(([, name]) => name === ASSET)?.[0];
      if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('The update has no checksum for your computer. Nothing was changed.');

      log(`Downloading SolBoy ${rel.version}...`);
      const res = await get(download(ASSET), 15 * 60_000);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmp, { mode: 0o755 });
      for await (const chunk of res.body) {
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, 'drain');
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      if (hash.digest('hex') !== expected) throw new Error('The download was damaged. Nothing was changed. Try again.');
      fs.chmodSync(tmp, 0o755);
      // Only switch to the new version once it has proved it starts on this computer.
      if (!(await run(tmp, ['--version'])).includes(rel.version)) throw new Error("The new version wouldn't start on this computer. Nothing was changed.");

      const old = `${exe}.old-${Date.now()}`;
      fs.renameSync(exe, old);
      try {
        fs.renameSync(tmp, exe);
      } catch (e) {
        fs.renameSync(old, exe);
        throw e;
      }
      fs.rm(old, { force: true }, () => {}); // fails harmlessly on Windows while the launcher still uses it
      log(`Updated SolBoy ${VERSION} → ${rel.version}. Restarting...`);
      return rel.version;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    } finally {
      busy = false;
    }
  }

  check(true);
  setInterval(() => check(true), 15 * 60_000).unref(); // new versions show up within 15 minutes
  return { check, status, install };
}
