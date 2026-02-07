import type { MarketSpec } from './index';

export const BCH: MarketSpec = {
  id: 'BCH',
  label: 'Bitcoin Cash',
  price: {
    basePrice: 420,
    driftBpsPerSec: 0.13,
    noiseBps: 19,
    wickBps: 26,
    meanRevert: 0.14,
    volumeBase: 195,
    volumeJitter: 145,
    minPrice: 30,
  },
  rules: {
    feeBps: 9,
    minNotionalUsd: 10,
    maxLeverage: 4,
  },
  ai: {
    name: 'Cycle Tracker',
    aggressiveness: 0.55,
    confidenceBias: 0.03,
    tone: 'neutral',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
