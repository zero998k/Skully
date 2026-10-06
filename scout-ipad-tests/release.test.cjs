// Scout for iPad · release checks: versions line up, every file exists, the page only talks to known data hosts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const docs = path.join(__dirname, '..', 'docs');
const read = name => fs.readFileSync(path.join(docs, name), 'utf8');

test('version is the same in the app, the update file and the asset links', () => {
  const version = JSON.parse(read('version.json')).version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(read('app.js'), new RegExp(`const VERSION = '${version.replace(/\./g, '\\.')}';`));
  const html = read('index.html');
  const assets = [...html.matchAll(/(?:src|href)="([\w.-]+\.(?:js|css))\?v=([\d.]+)"/g)];
  assert.equal(assets.length, 4);
  for (const [, file, stamp] of assets) {
    assert.equal(stamp, version, file + ' must load ?v=' + version);
    assert.ok(fs.existsSync(path.join(docs, file)), file + ' exists');
  }
});

test('every file the page or the manifest needs exists', () => {
  const html = read('index.html');
  for (const [, file] of html.matchAll(/(?:src|href)="([\w.-]+\.(?:png|webmanifest))"/g)) assert.ok(fs.existsSync(path.join(docs, file)), file);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(docs, icon.src)), icon.src);
  assert.ok(fs.existsSync(path.join(docs, '.nojekyll')), 'GitHub Pages must serve files as they are');
});

test('the page may only reach the data hosts it needs', () => {
  const policy = read('index.html').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const connect = policy.split(';').map(part => part.trim()).find(part => part.startsWith('connect-src')).split(/\s+/).slice(1);
  const hosts = new Set([...read('data.js').matchAll(/getJson\('https:\/\/([\w.-]+)\//g)].map(match => match[1]));
  assert.ok(hosts.size >= 4);
  for (const host of hosts) assert.ok(connect.includes('https://' + host), host + ' is allowed by the page policy');
  assert.match(policy, /script-src 'self'/);
});

test('screens never inject HTML', () => {
  for (const file of ['app.js', 'data.js', 'core.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, file);
  }
});
