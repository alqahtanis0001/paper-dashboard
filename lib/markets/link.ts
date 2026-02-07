import type { MarketSpec } from './index';

export const LINK: MarketSpec = {
  id: 'LINK',
  label: 'Chainlink',
  price: {
    basePrice: 22,
    driftBpsPerSec: 0.15,
    noiseBps: 17,
    wickBps: 23,
    meanRevert: 0.16,
    volumeBase: 185,
    volumeJitter: 135,
    minPrice: 1,
  },
  rules: {
    feeBps: 10,
    minNotionalUsd: 10,
    maxLeverage: 4,
  },
  ai: {
    name: 'Data-Driven Analyst',
    aggressiveness: 0.5,
    confidenceBias: 0.02,
    tone: 'neutral',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
