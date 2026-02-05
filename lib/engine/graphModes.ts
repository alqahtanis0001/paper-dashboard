export const GRAPH_MODES = [
  'AUTO',
  'BTC/USDT',
  'ETH/USDT',
  'SOL/USDT',
  'BNB/USDT',
  'XRP/USDT',
  'ADA/USDT',
  'DOGE/USDT',
  'AVAX/USDT',
  'LINK/USDT',
  'DOT/USDT',
  'MATIC/USDT',
  'LTC/USDT',
  'BCH/USDT',
  'ATOM/USDT',
  'UNI/USDT',
  'TRX/USDT',
] as const;

export type GraphMode = (typeof GRAPH_MODES)[number];
export type NonAutoGraphMode = Exclude<GraphMode, 'AUTO'>;

export const GRAPH_TIMEFRAMES = ['1s', '5s', '15s'] as const;
export type GraphTimeframe = (typeof GRAPH_TIMEFRAMES)[number];

export const DEFAULT_GRAPH_MODE: GraphMode = 'AUTO';
export const DEFAULT_GRAPH_TIMEFRAME: GraphTimeframe = '1s';

export type GraphProfile = {
  basePrice: number;
  cycleSec: number;
  trendBpsPerSec: number;
  waveBps: number;
  microWaveBps: number;
  noiseBps: number;
  wickBps: number;
  volumeBase: number;
  volumeJitter: number;
  meanRevert: number;
  shockChance: number;
  shockBps: number;
};

export const NON_AUTO_GRAPH_MODES = GRAPH_MODES.filter((mode): mode is NonAutoGraphMode => mode !== 'AUTO');

export const GRAPH_MODE_PROFILES: Record<NonAutoGraphMode, GraphProfile> = {
  'BTC/USDT': {
    basePrice: 62000,
    cycleSec: 48,
    trendBpsPerSec: 1.8,
    waveBps: 120,
    microWaveBps: 32,
    noiseBps: 12,
    wickBps: 18,
    volumeBase: 165,
    volumeJitter: 95,
    meanRevert: 0.16,
    shockChance: 0.004,
    shockBps: 32,
  },
  'ETH/USDT': {
    basePrice: 3250,
    cycleSec: 42,
    trendBpsPerSec: 1.6,
    waveBps: 145,
    microWaveBps: 44,
    noiseBps: 15,
    wickBps: 20,
    volumeBase: 145,
    volumeJitter: 78,
    meanRevert: 0.18,
    shockChance: 0.005,
    shockBps: 38,
  },
  'SOL/USDT': {
    basePrice: 175,
    cycleSec: 31,
    trendBpsPerSec: 2.8,
    waveBps: 220,
    microWaveBps: 75,
    noiseBps: 26,
    wickBps: 34,
    volumeBase: 210,
    volumeJitter: 140,
    meanRevert: 0.14,
    shockChance: 0.009,
    shockBps: 75,
  },
  'BNB/USDT': {
    basePrice: 575,
    cycleSec: 40,
    trendBpsPerSec: 1.2,
    waveBps: 110,
    microWaveBps: 34,
    noiseBps: 12,
    wickBps: 16,
    volumeBase: 120,
    volumeJitter: 66,
    meanRevert: 0.2,
    shockChance: 0.004,
    shockBps: 30,
  },
  'XRP/USDT': {
    basePrice: 0.62,
    cycleSec: 26,
    trendBpsPerSec: 2.1,
    waveBps: 175,
    microWaveBps: 58,
    noiseBps: 24,
    wickBps: 30,
    volumeBase: 240,
    volumeJitter: 155,
    meanRevert: 0.19,
    shockChance: 0.01,
    shockBps: 95,
  },
  'ADA/USDT': {
    basePrice: 0.55,
    cycleSec: 29,
    trendBpsPerSec: 1.9,
    waveBps: 165,
    microWaveBps: 55,
    noiseBps: 22,
    wickBps: 28,
    volumeBase: 205,
    volumeJitter: 130,
    meanRevert: 0.2,
    shockChance: 0.009,
    shockBps: 88,
  },
  'DOGE/USDT': {
    basePrice: 0.16,
    cycleSec: 22,
    trendBpsPerSec: 3.2,
    waveBps: 290,
    microWaveBps: 95,
    noiseBps: 34,
    wickBps: 46,
    volumeBase: 265,
    volumeJitter: 180,
    meanRevert: 0.11,
    shockChance: 0.012,
    shockBps: 120,
  },
  'AVAX/USDT': {
    basePrice: 41,
    cycleSec: 30,
    trendBpsPerSec: 2.5,
    waveBps: 215,
    microWaveBps: 68,
    noiseBps: 28,
    wickBps: 36,
    volumeBase: 200,
    volumeJitter: 124,
    meanRevert: 0.15,
    shockChance: 0.008,
    shockBps: 84,
  },
  'LINK/USDT': {
    basePrice: 22,
    cycleSec: 35,
    trendBpsPerSec: 1.7,
    waveBps: 150,
    microWaveBps: 45,
    noiseBps: 18,
    wickBps: 22,
    volumeBase: 155,
    volumeJitter: 92,
    meanRevert: 0.19,
    shockChance: 0.006,
    shockBps: 58,
  },
  'DOT/USDT': {
    basePrice: 8.5,
    cycleSec: 34,
    trendBpsPerSec: 1.6,
    waveBps: 145,
    microWaveBps: 48,
    noiseBps: 19,
    wickBps: 24,
    volumeBase: 160,
    volumeJitter: 96,
    meanRevert: 0.2,
    shockChance: 0.006,
    shockBps: 62,
  },
  'MATIC/USDT': {
    basePrice: 1.15,
    cycleSec: 28,
    trendBpsPerSec: 2.2,
    waveBps: 195,
    microWaveBps: 62,
    noiseBps: 24,
    wickBps: 31,
    volumeBase: 190,
    volumeJitter: 120,
    meanRevert: 0.17,
    shockChance: 0.008,
    shockBps: 82,
  },
  'LTC/USDT': {
    basePrice: 92,
    cycleSec: 39,
    trendBpsPerSec: 1.1,
    waveBps: 105,
    microWaveBps: 34,
    noiseBps: 13,
    wickBps: 17,
    volumeBase: 132,
    volumeJitter: 76,
    meanRevert: 0.22,
    shockChance: 0.004,
    shockBps: 36,
  },
  'BCH/USDT': {
    basePrice: 420,
    cycleSec: 33,
    trendBpsPerSec: 1.8,
    waveBps: 170,
    microWaveBps: 54,
    noiseBps: 20,
    wickBps: 27,
    volumeBase: 178,
    volumeJitter: 108,
    meanRevert: 0.18,
    shockChance: 0.007,
    shockBps: 66,
  },
  'ATOM/USDT': {
    basePrice: 12,
    cycleSec: 36,
    trendBpsPerSec: 1.5,
    waveBps: 138,
    microWaveBps: 42,
    noiseBps: 17,
    wickBps: 22,
    volumeBase: 150,
    volumeJitter: 88,
    meanRevert: 0.21,
    shockChance: 0.005,
    shockBps: 52,
  },
  'UNI/USDT': {
    basePrice: 8,
    cycleSec: 34,
    trendBpsPerSec: 1.6,
    waveBps: 148,
    microWaveBps: 46,
    noiseBps: 18,
    wickBps: 23,
    volumeBase: 152,
    volumeJitter: 90,
    meanRevert: 0.2,
    shockChance: 0.006,
    shockBps: 56,
  },
  'TRX/USDT': {
    basePrice: 0.11,
    cycleSec: 25,
    trendBpsPerSec: 2.4,
    waveBps: 185,
    microWaveBps: 60,
    noiseBps: 23,
    wickBps: 30,
    volumeBase: 235,
    volumeJitter: 150,
    meanRevert: 0.16,
    shockChance: 0.01,
    shockBps: 96,
  },
};

export function isGraphMode(value: string | null | undefined): value is GraphMode {
  return typeof value === 'string' && (GRAPH_MODES as readonly string[]).includes(value);
}

export function normalizeGraphMode(value: string | null | undefined): GraphMode {
  return isGraphMode(value) ? value : DEFAULT_GRAPH_MODE;
}

export function isGraphTimeframe(value: string | null | undefined): value is GraphTimeframe {
  return typeof value === 'string' && (GRAPH_TIMEFRAMES as readonly string[]).includes(value);
}

export function normalizeGraphTimeframe(value: string | null | undefined): GraphTimeframe {
  return isGraphTimeframe(value) ? value : DEFAULT_GRAPH_TIMEFRAME;
}

export function timeframeToMs(timeframe: GraphTimeframe): number {
  if (timeframe === '5s') return 5000;
  if (timeframe === '15s') return 15000;
  return 1000;
}
