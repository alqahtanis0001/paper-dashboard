import type { MarketSpec } from './index';

export const TRX: MarketSpec = {
  id: 'TRX',
  label: 'Tron',
  price: {
    basePrice: 0.11,
    driftBpsPerSec: 0.19,
    noiseBps: 22,
    wickBps: 30,
    meanRevert: 0.13,
    volumeBase: 245,
    volumeJitter: 180,
    minPrice: 0.01,
  },
  rules: {
    feeBps: 12,
    minNotionalUsd: 10,
    maxLeverage: 3,
  },
  ai: {
    name: 'Scalp Executor',
    aggressiveness: 0.66,
    confidenceBias: 0.05,
    tone: 'hype',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
