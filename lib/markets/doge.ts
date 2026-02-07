import type { MarketSpec } from './index';

export const DOGE: MarketSpec = {
  id: 'DOGE',
  label: 'Dogecoin',
  price: {
    basePrice: 0.16,
    driftBpsPerSec: 0.24,
    noiseBps: 33,
    wickBps: 46,
    meanRevert: 0.08,
    volumeBase: 280,
    volumeJitter: 220,
    minPrice: 0.01,
  },
  rules: {
    feeBps: 14,
    minNotionalUsd: 10,
    maxLeverage: 2,
  },
  ai: {
    name: 'Meme Sniper',
    aggressiveness: 0.84,
    confidenceBias: 0.12,
    tone: 'hype',
  },
  events: {
    newsSpike: (k = 1) => ({ kind: 'NEWS_SPIKE', magnitudeBps: 180 * k, decaySec: 18 }),
    dump: (k = 1) => ({ kind: 'DUMP', magnitudeBps: -220 * k, decaySec: 16 }),
    squeeze: (k = 1) => ({ kind: 'SQUEEZE', magnitudeBps: 260 * k, decaySec: 14 }),
  },
};
