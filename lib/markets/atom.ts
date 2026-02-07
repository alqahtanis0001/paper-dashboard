import type { MarketSpec } from './index';

export const ATOM: MarketSpec = {
  id: 'ATOM',
  label: 'Cosmos',
  price: {
    basePrice: 12,
    driftBpsPerSec: 0.12,
    noiseBps: 16,
    wickBps: 22,
    meanRevert: 0.18,
    volumeBase: 175,
    volumeJitter: 120,
    minPrice: 0.6,
  },
  rules: {
    feeBps: 10,
    minNotionalUsd: 10,
    maxLeverage: 4,
  },
  ai: {
    name: 'Calm Synthesizer',
    aggressiveness: 0.46,
    confidenceBias: 0.02,
    tone: 'calm',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
