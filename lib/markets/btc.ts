import type { MarketSpec } from './index';

export const BTC: MarketSpec = {
  id: 'BTC',
  label: 'Bitcoin',
  price: {
    basePrice: 67000,
    driftBpsPerSec: 0.12,
    noiseBps: 10,
    wickBps: 18,
    meanRevert: 0.1,
    volumeBase: 220,
    volumeJitter: 150,
    minPrice: 5000,
  },
  rules: {
    feeBps: 8,
    minNotionalUsd: 10,
    maxLeverage: 5,
  },
  ai: {
    name: 'Calm Analyst',
    aggressiveness: 0.45,
    confidenceBias: 0.05,
    tone: 'calm',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
