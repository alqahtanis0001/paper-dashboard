import { randomInt } from 'crypto';

// Execution sim constants tuned for light realism
const MAKER_FEE = 0.00015; // 1.5 bps
const TAKER_FEE = 0.0006;  // 6  bps
const SPREAD_BPS = 0.0004; // 4 bps half‑spread around mid
const BASE_SLIPPAGE_BPS = 0.00005; // 0.5 bps minimum slippage

type Side = 'buy' | 'sell';

/**
 * Simulate an order fill around a mid price.
 * - Buys pay the ask (mid + spread); sells hit the bid (mid - spread).
 * - Slippage magnitude scales with regimeVolatility and randomizes per fill.
 * - Fees randomly pick maker vs taker to keep variety in the log.
 * - feeUsd/slippageUsd are per-unit; multiply by quantity for trade totals.
 */
export function simulateExecution(midPrice: number, side: Side, regimeVolatility: number) {
  const safeMid = Number.isFinite(midPrice) && midPrice > 0 ? midPrice : 0;
  const vol = Math.max(0, regimeVolatility ?? 0);

  // Apply spread to mid
  const spreadSigned = safeMid * SPREAD_BPS * (side === 'buy' ? 1 : -1);

  // Tiny random slippage scaled by volatility (capped for sanity)
  const volScale = Math.min(vol, 5); // prevent runaway fills
  const slippageBps = BASE_SLIPPAGE_BPS + Math.random() * BASE_SLIPPAGE_BPS * 6 * volScale;
  const slippageSigned = safeMid * slippageBps * (side === 'buy' ? 1 : -1);

  const fillPrice = safeMid + spreadSigned + slippageSigned;

  // Maker / taker mix (20% maker to vary fees)
  const isMaker = Math.random() < 0.2;
  const feeRate = isMaker ? MAKER_FEE : TAKER_FEE;
  const feeUsd = fillPrice * feeRate;

  const latencyMs = randomInt(100, 601); // inclusive 100-600ms

  return {
    fillPrice,
    feeUsd,
    slippageUsd: Math.abs(slippageSigned),
    latencyMs,
  };
}
