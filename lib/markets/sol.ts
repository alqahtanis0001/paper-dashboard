import type { MarketSpec } from './index';

export const SOL: MarketSpec = {
  id: 'SOL',
  label: 'Solana',
  price: {
    basePrice: 170,
    driftBpsPerSec: 0.2,
    noiseBps: 24,
    wickBps: 34,
    meanRevert: 0.1,
    volumeBase: 240,
    volumeJitter: 180,
    minPrice: 10,
  },
  rules: {
    feeBps: 10,
    minNotionalUsd: 10,
    maxLeverage: 4,
  },
  ai: {
    name: 'Momentum Hunter',
    aggressiveness: 0.72,
    confidenceBias: 0.08,
    tone: 'hype',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
