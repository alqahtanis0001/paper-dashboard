import type { MarketSpec } from './index';

export const UNI: MarketSpec = {
  id: 'UNI',
  label: 'Uniswap',
  price: {
    basePrice: 8,
    driftBpsPerSec: 0.13,
    noiseBps: 17,
    wickBps: 23,
    meanRevert: 0.17,
    volumeBase: 178,
    volumeJitter: 124,
    minPrice: 0.4,
  },
  rules: {
    feeBps: 10,
    minNotionalUsd: 10,
    maxLeverage: 4,
  },
  ai: {
    name: 'Liquidity Watcher',
    aggressiveness: 0.52,
    confidenceBias: 0.03,
    tone: 'neutral',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
