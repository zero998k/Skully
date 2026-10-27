import path from 'node:path';

// When packaged as a single app, keep config.json, .env and data/ next to the app itself,
// wherever it was double-clicked from. When run with `npm start`, use the current folder.
const runtime = path.basename(process.execPath).toLowerCase();
export const isPackagedApp = !/^(node|bun)(\.exe)?$/.test(runtime);

export const BASE_DIR = isPackagedApp ? path.dirname(process.execPath) : process.cwd();
export const file = (name) => path.join(BASE_DIR, name);
