export type SignalAction = 'BUY' | 'SELL' | 'OFF';

export type ModelSignal = {
  model: string;
  signal: SignalAction;
  confidence: number;
  reasons: string[];
};

export type MetaDecision = {
  action: 'BUY' | 'SELL' | 'NO_TRADE';
  confidence: number;
  reason: string;
};

function ema(values: number[], period: number) {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let emaPrev = values[0];
  for (let i = 1; i < values.length; i++) emaPrev = values[i] * k + emaPrev * (1 - k);
  return emaPrev;
}

function rsi(values: number[], period = 14) {
  if (values.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return 100 - 100 / (1 + rs);
}

function slope(values: number[]) {
  if (values.length < 2) return 0;
  return values[values.length - 1] - values[values.length - 2];
}

export function buildSignals(prices: number[], volumes: number[] = []): ModelSignal[] {
  const last = prices[prices.length - 1] ?? 0;
  const emaFast = ema(prices.slice(-30), 9);
  const emaSlow = ema(prices.slice(-60), 21);
  const priceSlope = slope(prices.slice(-5));
  const rsiVal = rsi(prices, 14);
  const trend: ModelSignal = emaFast > emaSlow && priceSlope > 0
    ? { model: 'Trend', signal: 'BUY', confidence: 78, reasons: ['EMA9 above EMA21', 'short-term slope positive', 'trend continuation odds favorable'] }
    : emaFast < emaSlow && priceSlope < 0
      ? { model: 'Trend', signal: 'SELL', confidence: 76, reasons: ['EMA9 below EMA21', 'short-term slope negative', 'downtrend momentum persists'] }
      : { model: 'Trend', signal: 'OFF', confidence: 40, reasons: ['EMAs converging', 'slope indecisive'] };

  const momentum: ModelSignal = rsiVal < 35
    ? { model: 'Momentum', signal: 'BUY', confidence: 72, reasons: [`RSI oversold ${rsiVal.toFixed(1)}`, 'sell pressure likely exhausted'] }
    : rsiVal > 65
      ? { model: 'Momentum', signal: 'SELL', confidence: 74, reasons: [`RSI elevated ${rsiVal.toFixed(1)}`, 'mean reversion risk rising'] }
      : { model: 'Momentum', signal: 'OFF', confidence: 45, reasons: [`RSI neutral ${rsiVal.toFixed(1)}`] };

  const recentWindow = prices.slice(-20);
  const maxRecent = Math.max(...recentWindow);
  const minRecent = Math.min(...recentWindow);
  const width = last ? (maxRecent - minRecent) / last : 0;
  const vol: ModelSignal = width < 0.008
    ? { model: 'Volatility', signal: 'OFF', confidence: 35, reasons: ['range compressed', 'breakout signal weak'] }
    : emaFast > emaSlow
      ? { model: 'Volatility', signal: 'BUY', confidence: 68, reasons: ['range expanding upward', 'high participation in upside candles'] }
      : { model: 'Volatility', signal: 'SELL', confidence: 68, reasons: ['range expanding downward', 'volatility favoring downside'] };

  const volArr = volumes.length ? volumes.slice(-10) : prices.slice(-10).map((p, i, arr) => Math.abs(p - (arr[i - 1] || p)));
  const avgVol = volArr.reduce((a, b) => a + b, 0) / Math.max(volArr.length, 1);
  const lastVol = volArr[volArr.length - 1] || 0;
  const volumeSignal: ModelSignal = lastVol > avgVol * 1.8 && priceSlope > 0
    ? { model: 'Volume', signal: 'BUY', confidence: 70, reasons: ['volume spike confirms breakout', 'buyers absorbing offers'] }
    : lastVol > avgVol * 1.8 && priceSlope < 0
      ? { model: 'Volume', signal: 'SELL', confidence: 70, reasons: ['volume spike on selloff', 'offers overwhelming bids'] }
      : { model: 'Volume', signal: 'OFF', confidence: 40, reasons: ['no clear volume confirmation'] };

  const tail = prices.slice(-30);
  const patternSignal: ModelSignal = last > tail[0] && tail[0] === Math.min(...tail)
    ? { model: 'Pattern', signal: 'BUY', confidence: 75, reasons: ['local flush then recovery', 'higher closes after exhaustion'] }
    : last < tail[0] && tail[0] === Math.max(...tail)
      ? { model: 'Pattern', signal: 'SELL', confidence: 75, reasons: ['local peak then breakdown', 'lower closes after rejection'] }
      : { model: 'Pattern', signal: 'OFF', confidence: 45, reasons: ['no clean pattern edge'] };

  return [trend, momentum, vol, volumeSignal, patternSignal];
}

export function aggregateSignals(signals: ModelSignal[]): MetaDecision {
  const buy = signals.filter((s) => s.signal === 'BUY');
  const sell = signals.filter((s) => s.signal === 'SELL');
  if (buy.length >= 4) return { action: 'BUY', confidence: Math.round((buy.length / signals.length) * 100), reason: 'Strong multi-agent upside agreement' };
  if (sell.length >= 4) return { action: 'SELL', confidence: Math.round((sell.length / signals.length) * 100), reason: 'Strong multi-agent downside agreement' };
  if (buy.length > 0 && sell.length > 0) {
    return {
      action: 'NO_TRADE',
      confidence: 55,
      reason: `Agent conflict: ${buy.length} buy vs ${sell.length} sell votes`,
    };
  }
  return { action: 'NO_TRADE', confidence: 40, reason: 'Insufficient conviction across agents' };
}
