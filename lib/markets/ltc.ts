import type { MarketSpec } from './index';

export const LTC: MarketSpec = {
  id: 'LTC',
  label: 'Litecoin',
  price: {
    basePrice: 92,
    driftBpsPerSec: 0.1,
    noiseBps: 13,
    wickBps: 18,
    meanRevert: 0.18,
    volumeBase: 160,
    volumeJitter: 108,
    minPrice: 10,
  },
  rules: {
    feeBps: 8,
    minNotionalUsd: 10,
    maxLeverage: 5,
  },
  ai: {
    name: 'Classic Swinger',
    aggressiveness: 0.44,
    confidenceBias: 0.01,
    tone: 'calm',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
