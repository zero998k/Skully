import { Positions } from './positions.js';
import { file } from './paths.js';

/**
 * Paper and real-money trading keep separate positions and trade logs. The book always points
 * at the current mode, so switching modes is instant and never mixes the two.
 */
export function createBook(cfg, keypair) {
  const stores = {};
  const storeFor = (mode) => (stores[mode] ??= new Positions(file(`data/positions-${mode}.json`)));
  const book = {
    keypair,
    get mode() {
      return cfg.dryRun ? 'paper' : 'live';
    },
    get tradeLogFile() {
      return file(`data/trades-${book.mode}.csv`);
    },
  };
  // A stable handle the rest of the app can keep, which always reads the current mode's positions.
  book.positions = new Proxy({}, {
    get(_, key) {
      const store = storeFor(book.mode);
      const value = store[key];
      return typeof value === 'function' ? value.bind(store) : value;
    },
  });
  book.positionsFor = storeFor;
  return book;
}
