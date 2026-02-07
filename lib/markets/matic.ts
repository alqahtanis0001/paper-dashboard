import type { MarketSpec } from './index';

export const MATIC: MarketSpec = {
  id: 'MATIC',
  label: 'Polygon',
  price: {
    basePrice: 1.15,
    driftBpsPerSec: 0.17,
    noiseBps: 23,
    wickBps: 31,
    meanRevert: 0.14,
    volumeBase: 210,
    volumeJitter: 150,
    minPrice: 0.08,
  },
  rules: {
    feeBps: 11,
    minNotionalUsd: 10,
    maxLeverage: 3,
  },
  ai: {
    name: 'Volatility Mapper',
    aggressiveness: 0.6,
    confidenceBias: 0.04,
    tone: 'neutral',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
