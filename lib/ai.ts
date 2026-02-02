export type SignalAction = 'BUY' | 'SELL' | 'OFF';

export type ModelSignal = {
  model: string;
  signal: SignalAction;
  confidence: number;
  reason?: string;
};

export type MetaDecision = {
  action: 'BUY' | 'SELL' | 'WAIT';
  confidence: number;
};

function ema(values: number[], period: number) {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let emaPrev = values[0];
  for (let i = 1; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
  }
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

  const trendSignal: ModelSignal =
    emaFast > emaSlow && priceSlope > 0
      ? { model: 'Trend', signal: 'BUY', confidence: 78, reason: 'EMA9 > EMA21 & rising' }
      : emaFast < emaSlow && priceSlope < 0
        ? { model: 'Trend', signal: 'SELL', confidence: 76, reason: 'EMA9 < EMA21 & falling' }
        : { model: 'Trend', signal: 'OFF', confidence: 40, reason: 'Mixed trend' };

  const momentumSignal: ModelSignal =
    rsiVal < 35
      ? { model: 'Momentum', signal: 'BUY', confidence: 72, reason: `RSI ${rsiVal.toFixed(1)}` }
      : rsiVal > 65
        ? { model: 'Momentum', signal: 'SELL', confidence: 74, reason: `RSI ${rsiVal.toFixed(1)}` }
        : { model: 'Momentum', signal: 'OFF', confidence: 45, reason: `RSI neutral ${rsiVal.toFixed(1)}` };

  const recentWindow = prices.slice(-20);
  const maxRecent = Math.max(...recentWindow);
  const minRecent = Math.min(...recentWindow);
  const width = last ? (maxRecent - minRecent) / last : 0;
  const volSignal: ModelSignal =
    width < 0.008
      ? { model: 'Volatility', signal: 'OFF', confidence: 35, reason: 'Chop / narrow range' }
      : emaFast > emaSlow
        ? { model: 'Volatility', signal: 'BUY', confidence: 68, reason: 'Expanding upside range' }
        : { model: 'Volatility', signal: 'SELL', confidence: 68, reason: 'Expanding downside range' };

  const volArr = volumes.length ? volumes.slice(-10) : prices.slice(-10).map((p, i, arr) => Math.abs(p - arr[i - 1] || 0));
  const avgVol = volArr.reduce((a, b) => a + b, 0) / Math.max(volArr.length, 1);
  const lastVol = volArr[volArr.length - 1] || 0;
  const volumeSignal: ModelSignal =
    lastVol > avgVol * 1.8 && priceSlope > 0
      ? { model: 'Volume', signal: 'BUY', confidence: 70, reason: 'Volume spike on breakout' }
      : lastVol > avgVol * 1.8 && priceSlope < 0
        ? { model: 'Volume', signal: 'SELL', confidence: 70, reason: 'Volume spike on selloff' }
        : { model: 'Volume', signal: 'OFF', confidence: 40, reason: 'No volume confirmation' };

  const tail = prices.slice(-30);
  const minTail = Math.min(...tail);
  const maxTail = Math.max(...tail);
  const patternSignal: ModelSignal =
    last > tail[0] && tail[0] === minTail
      ? { model: 'Pattern', signal: 'BUY', confidence: 75, reason: 'Reversal after flush' }
      : last < tail[0] && tail[0] === maxTail
        ? { model: 'Pattern', signal: 'SELL', confidence: 75, reason: 'Breakdown after peak' }
        : { model: 'Pattern', signal: 'OFF', confidence: 45, reason: 'No clear pattern' };

  return [trendSignal, momentumSignal, volSignal, volumeSignal, patternSignal];
}

export function aggregateSignals(signals: ModelSignal[]): MetaDecision {
  const buyCount = signals.filter((s) => s.signal === 'BUY').length;
  const sellCount = signals.filter((s) => s.signal === 'SELL').length;
  let action: 'BUY' | 'SELL' | 'WAIT' = 'WAIT';
  let agreeCount = 0;
  if (buyCount >= 4 && buyCount >= sellCount) {
    action = 'BUY';
    agreeCount = buyCount;
  } else if (sellCount >= 4 && sellCount > buyCount) {
    action = 'SELL';
    agreeCount = sellCount;
  }
  const confidence = Math.round((agreeCount / 5) * 100);
  if (confidence <= 70) {
    return { action: 'WAIT', confidence };
  }
  return { action, confidence };
}
