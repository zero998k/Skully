const BASE = process.env.SOLBOY_TEST_URL || 'http://localhost:7777';
// Update flow: damaged download refused, then a real update to 1.1.1 with the page reloading by itself.
const { chromium } = require('playwright');
const fs = require('fs'); const crypto = require('crypto'); const { execFileSync } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const F = (path) => fetch(`http://127.0.0.1:18900${path}`, { method: 'POST' }).then((r) => r.json());
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => false); if (v || Date.now() > end) return v; await sleep(300); } };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
(async () => {
  const [E, APP] = process.argv.slice(2); const R = {};
  for (let i = 0; i < 60 && !(await fetch(BASE + '/').then(() => true).catch(() => false)); i++) await sleep(500);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; p.on('pageerror', (e) => errors.push(String(e))); p.on('dialog', (d) => d.accept());
  await p.goto(BASE + '/'); await sleep(2000);
  await F('/emit?side=buy'); await until(async () => (await p.evaluate(() => S.inventory.length)) === 1);
  const before = { env: sha(`${APP}/.env`), cfg: sha(`${APP}/config.json`), pos: sha(`${APP}/data/positions-paper.json`) };
  R.versionBefore = await p.evaluate(() => S.update.version);
  R.buttonText = await p.textContent('#updateBtn'); R.buttonVisible = await p.isVisible('#updateBtn');
  await p.screenshot({ path: `${E}/u1-button.png` });
  // damaged download
  await F('/set?corrupt=1');
  await p.click('#updateBtn', { force: true }); await sleep(400);
  R.notes = (await p.locator('#modalBody .notes').innerText()).replace(/\s+/g, ' ');
  await p.screenshot({ path: `${E}/u2-modal.png` });
  await p.click('#updGo'); await until(async () => (await p.textContent('#updErr')).length > 0, 30000);
  R.damagedError = await p.textContent('#updErr');
  R.stillOldBinary = execFileSync(`${APP}/SolBoy`, ['--version']).toString().trim();
  R.leftoverNewFile = fs.existsSync(`${APP}/SolBoy.new`);
  // real update
  await F('/set?corrupt=0');
  const reloaded = p.waitForEvent('load', { timeout: 60000 });
  await p.click('#updGo');
  await reloaded; await sleep(2500);
  R.versionAfter = await p.evaluate(() => S.update?.version);
  R.binaryAfter = execFileSync(`${APP}/SolBoy`, ['--version']).toString().trim();
  R.positionKept = await p.evaluate(() => S.inventory.length);
  R.online = await p.textContent('#conn');
  const after = { env: sha(`${APP}/.env`), cfg: sha(`${APP}/config.json`), pos: sha(`${APP}/data/positions-paper.json`) };
  R.settingsUntouched = JSON.stringify(before) === JSON.stringify(after);
  R.buttonGone = !(await p.isVisible('#updateBtn'));
  R.oldFilesLeft = fs.readdirSync(APP).filter((f) => /\.old|\.new/.test(f));
  // still trades after the update
  await F('/emit?side=sell'); R.sellAfterUpdate = await until(async () => (await p.evaluate(() => S.inventory.length)) === 0);
  R.errors = errors; console.log(JSON.stringify(R, null, 1)); await b.close();
})().catch((e) => { console.error('TEST CRASH', e.message); process.exit(1); });
