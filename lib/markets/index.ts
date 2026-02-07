export type RegimeOverride = 'AUTO' | 'BULL' | 'BEAR' | 'CHOPPY' | 'HIGH_VOL' | 'LOW_VOL';

export type MarketRules = {
  feeBps: number;
  minNotionalUsd: number;
  maxLeverage: number;
};

export type MarketAiProfile = {
  name: string;
  aggressiveness: number;
  confidenceBias: number;
  tone: 'calm' | 'neutral' | 'hype';
};

export type MarketPriceModel = {
  basePrice: number;
  driftBpsPerSec: number;
  noiseBps: number;
  wickBps: number;
  meanRevert: number;
  volumeBase: number;
  volumeJitter: number;
  minPrice?: number;
  maxPrice?: number;
};

export type MarketEvent =
  | { kind: 'NEWS_SPIKE'; magnitudeBps: number; decaySec: number }
  | { kind: 'DUMP'; magnitudeBps: number; decaySec: number }
  | { kind: 'SQUEEZE'; magnitudeBps: number; decaySec: number };

export type MarketSpec = {
  id: string;
  label: string;
  price: MarketPriceModel;
  rules: MarketRules;
  ai: MarketAiProfile;
  events: {
    newsSpike: (k?: number) => MarketEvent;
    dump: (k?: number) => MarketEvent;
    squeeze: (k?: number) => MarketEvent;
  };
};

import { BTC } from './btc';
import { ETH } from './eth';
import { SOL } from './sol';
import { BNB } from './bnb';
import { XRP } from './xrp';
import { ADA } from './ada';
import { DOGE } from './doge';
import { AVAX } from './avax';
import { LINK } from './link';
import { DOT } from './dot';
import { MATIC } from './matic';
import { LTC } from './ltc';
import { BCH } from './bch';
import { ATOM } from './atom';
import { UNI } from './uni';
import { TRX } from './trx';

export const MARKETS: Record<string, MarketSpec> = {
  BTC,
  ETH,
  SOL,
  BNB,
  XRP,
  ADA,
  DOGE,
  AVAX,
  LINK,
  DOT,
  MATIC,
  LTC,
  BCH,
  ATOM,
  UNI,
  TRX,
};

export function getMarket(marketId: string): MarketSpec {
  return MARKETS[marketId] ?? BTC;
}

export function listMarkets(): Array<{ id: string; label: string }> {
  return Object.values(MARKETS).map((m) => ({ id: m.id, label: m.label }));
}
