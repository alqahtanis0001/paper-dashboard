import type { MarketSpec } from './index';

export const XRP: MarketSpec = {
  id: 'XRP',
  label: 'XRP Ledger',
  price: {
    basePrice: 0.62,
    driftBpsPerSec: 0.18,
    noiseBps: 22,
    wickBps: 31,
    meanRevert: 0.14,
    volumeBase: 260,
    volumeJitter: 190,
    minPrice: 0.1,
  },
  rules: {
    feeBps: 12,
    minNotionalUsd: 10,
    maxLeverage: 3,
  },
  ai: {
    name: 'News Reactor',
    aggressiveness: 0.68,
    confidenceBias: 0.06,
    tone: 'hype',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
