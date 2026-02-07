import type { MarketSpec } from './index';

export const ADA: MarketSpec = {
  id: 'ADA',
  label: 'Cardano',
  price: {
    basePrice: 0.56,
    driftBpsPerSec: 0.16,
    noiseBps: 20,
    wickBps: 29,
    meanRevert: 0.16,
    volumeBase: 210,
    volumeJitter: 160,
    minPrice: 0.08,
  },
  rules: {
    feeBps: 12,
    minNotionalUsd: 10,
    maxLeverage: 3,
  },
  ai: {
    name: 'Disciplined Scout',
    aggressiveness: 0.56,
    confidenceBias: 0.03,
    tone: 'neutral',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
