import type { MarketSpec } from './index';

export const AVAX: MarketSpec = {
  id: 'AVAX',
  label: 'Avalanche',
  price: {
    basePrice: 41,
    driftBpsPerSec: 0.21,
    noiseBps: 26,
    wickBps: 36,
    meanRevert: 0.11,
    volumeBase: 230,
    volumeJitter: 170,
    minPrice: 2,
  },
  rules: {
    feeBps: 10,
    minNotionalUsd: 10,
    maxLeverage: 4,
  },
  ai: {
    name: 'Breakout Rider',
    aggressiveness: 0.7,
    confidenceBias: 0.07,
    tone: 'hype',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
