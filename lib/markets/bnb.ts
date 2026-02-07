import type { MarketSpec } from './index';

export const BNB: MarketSpec = {
  id: 'BNB',
  label: 'BNB Chain',
  price: {
    basePrice: 560,
    driftBpsPerSec: 0.11,
    noiseBps: 11,
    wickBps: 17,
    meanRevert: 0.15,
    volumeBase: 170,
    volumeJitter: 110,
    minPrice: 40,
  },
  rules: {
    feeBps: 8,
    minNotionalUsd: 10,
    maxLeverage: 5,
  },
  ai: {
    name: 'Steady Operator',
    aggressiveness: 0.4,
    confidenceBias: 0.03,
    tone: 'calm',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
