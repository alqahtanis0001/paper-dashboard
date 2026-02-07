import type { MarketSpec } from './index';

export const DOT: MarketSpec = {
  id: 'DOT',
  label: 'Polkadot',
  price: {
    basePrice: 8.5,
    driftBpsPerSec: 0.14,
    noiseBps: 18,
    wickBps: 24,
    meanRevert: 0.17,
    volumeBase: 180,
    volumeJitter: 132,
    minPrice: 0.4,
  },
  rules: {
    feeBps: 10,
    minNotionalUsd: 10,
    maxLeverage: 4,
  },
  ai: {
    name: 'Range Specialist',
    aggressiveness: 0.48,
    confidenceBias: 0.02,
    tone: 'calm',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
