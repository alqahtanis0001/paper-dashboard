import type { MarketSpec } from './index';

export const ETH: MarketSpec = {
  id: 'ETH',
  label: 'Ethereum',
  price: {
    basePrice: 3200,
    driftBpsPerSec: 0.14,
    noiseBps: 12,
    wickBps: 20,
    meanRevert: 0.12,
    volumeBase: 190,
    volumeJitter: 130,
    minPrice: 300,
  },
  rules: {
    feeBps: 8,
    minNotionalUsd: 10,
    maxLeverage: 6,
  },
  ai: {
    name: 'Balanced Strategist',
    aggressiveness: 0.52,
    confidenceBias: 0.04,
    tone: 'neutral',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
