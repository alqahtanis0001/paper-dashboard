export type SignalAction = 'BUY' | 'SELL' | 'NO_TRADE';

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

export type AggregateOptions = {
  agentHitRates?: Record<string, number>;
};

const COMMITTEE_SIZE = 5;
const MIN_CONSENSUS_VOTES = 4;
const MIN_META_CONFIDENCE = 70;
const MIN_EDGE_PCT = 50;

function clampConfidence(value: number) {
  return Math.max(35, Math.min(95, Math.round(value)));
}

function avg(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function sum(values: number[]) {
  return values.reduce((total, item) => total + item, 0);
}

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

function getReliabilityMultiplier(model: string, agentHitRates?: Record<string, number>) {
  const rawHitRate = agentHitRates?.[model];
  if (typeof rawHitRate !== 'number' || !Number.isFinite(rawHitRate)) return 1;
  const hitRate = Math.max(0, Math.min(100, rawHitRate));
  const centered = (hitRate - 50) / 50; // [-1, 1]
  return Math.max(0.8, Math.min(1.2, 1 + centered * 0.2));
}

function adjustedConfidence(signal: ModelSignal, agentHitRates?: Record<string, number>) {
  const reliability = getReliabilityMultiplier(signal.model, agentHitRates);
  return clampConfidence(signal.confidence * reliability);
}

function computeConsensusConfidence(
  voters: ModelSignal[],
  totalAgents: number,
  opposingVotes: number,
  neutralVotes: number,
  agentHitRates?: Record<string, number>,
) {
  const avgConfidence = avg(voters.map((voter) => adjustedConfidence(voter, agentHitRates)));
  const agreementPct = (voters.length / totalAgents) * 100;
  const conflictPenalty = opposingVotes * 6 + neutralVotes * 2;
  return clampConfidence(avgConfidence * 0.78 + agreementPct * 0.22 - conflictPenalty);
}

function computeEdgePct(voters: ModelSignal[], opposing: ModelSignal[], agentHitRates?: Record<string, number>) {
  const voteWeight = sum(voters.map((voter) => adjustedConfidence(voter, agentHitRates)));
  const opposingWeight = sum(opposing.map((voter) => adjustedConfidence(voter, agentHitRates)));
  const denominator = voteWeight + opposingWeight;
  if (denominator <= 0) return 0;
  return Math.round(((voteWeight - opposingWeight) / denominator) * 100);
}

function voteSummary(buyVotes: ModelSignal[], sellVotes: ModelSignal[], noTradeVotes: ModelSignal[]) {
  return `${buyVotes.length} BUY / ${sellVotes.length} SELL / ${noTradeVotes.length} NO_TRADE`;
}

export function buildSignals(prices: number[], volumes: number[] = []): ModelSignal[] {
  const last = prices[prices.length - 1] ?? 0;
  const emaFast = ema(prices.slice(-30), 9);
  const emaSlow = ema(prices.slice(-60), 21);
  const priceSlope = slope(prices.slice(-5));
  const rsiVal = rsi(prices, 14);

  const spreadPct = last ? ((emaFast - emaSlow) / last) * 100 : 0;
  const slopePct = last ? Math.abs(priceSlope / last) * 100 : 0;
  const trend: ModelSignal =
    spreadPct > 0.08 && priceSlope > 0
      ? {
          model: 'Trend Agent',
          signal: 'BUY',
          confidence: clampConfidence(64 + spreadPct * 65 + slopePct * 220),
          reasons: ['EMA fast above EMA slow', 'price slope positive', 'trend continuation setup'],
        }
      : spreadPct < -0.08 && priceSlope < 0
        ? {
            model: 'Trend Agent',
            signal: 'SELL',
            confidence: clampConfidence(64 + Math.abs(spreadPct) * 65 + slopePct * 220),
            reasons: ['EMA fast below EMA slow', 'price slope negative', 'trend continuation setup'],
          }
        : {
            model: 'Trend Agent',
            signal: 'NO_TRADE',
            confidence: clampConfidence(58 - Math.min(10, Math.abs(spreadPct) * 20)),
            reasons: ['trend signal mixed', 'convergence or weak slope'],
          };

  const momentumDistance = Math.abs(rsiVal - 50);
  const momentum: ModelSignal =
    rsiVal <= 33 && priceSlope >= 0
      ? {
          model: 'Momentum Agent',
          signal: 'BUY',
          confidence: clampConfidence(60 + (33 - rsiVal) * 1.35 + momentumDistance * 0.2),
          reasons: [`RSI oversold (${rsiVal.toFixed(1)})`, 'momentum recovering'],
        }
      : rsiVal >= 67 && priceSlope <= 0
        ? {
            model: 'Momentum Agent',
            signal: 'SELL',
            confidence: clampConfidence(60 + (rsiVal - 67) * 1.35 + momentumDistance * 0.2),
            reasons: [`RSI overbought (${rsiVal.toFixed(1)})`, 'momentum fading'],
          }
        : {
            model: 'Momentum Agent',
            signal: 'NO_TRADE',
            confidence: clampConfidence(55 + Math.max(0, 14 - momentumDistance) * 0.6),
            reasons: [`RSI neutral (${rsiVal.toFixed(1)})`, 'no edge confirmation'],
          };

  const recentWindow = prices.slice(-20);
  const maxRecent = Math.max(...recentWindow);
  const minRecent = Math.min(...recentWindow);
  const width = last ? (maxRecent - minRecent) / last : 0;
  const breakoutBias = (last - avg(recentWindow)) / Math.max(last, 1);
  const volatility: ModelSignal =
    width > 0.011 && breakoutBias > 0.0012
      ? {
          model: 'Volatility Agent',
          signal: 'BUY',
          confidence: clampConfidence(58 + width * 1750 + breakoutBias * 12000),
          reasons: ['expanding range', 'breakout pressure to upside'],
        }
      : width > 0.011 && breakoutBias < -0.0012
        ? {
            model: 'Volatility Agent',
            signal: 'SELL',
            confidence: clampConfidence(58 + width * 1750 + Math.abs(breakoutBias) * 12000),
            reasons: ['expanding range', 'breakout pressure to downside'],
          }
        : {
            model: 'Volatility Agent',
            signal: 'NO_TRADE',
            confidence: clampConfidence(width < 0.006 ? 72 : 57),
            reasons: width < 0.006 ? ['range compression', 'waiting for confirmed breakout'] : ['volatility mixed', 'no directional edge'],
          };

  const volArr = volumes.length ? volumes.slice(-12) : prices.slice(-12).map((p, i, arr) => Math.abs(p - (arr[i - 1] || p)));
  const avgVol = avg(volArr);
  const lastVol = volArr[volArr.length - 1] || 0;
  const volSpike = avgVol > 0 ? lastVol / avgVol : 1;
  const volumeSignal: ModelSignal =
    volSpike > 1.65 && priceSlope > 0
      ? {
          model: 'Volume Agent',
          signal: 'BUY',
          confidence: clampConfidence(60 + (volSpike - 1) * 22 + slopePct * 140),
          reasons: ['volume expansion supports buyers', 'positive tape pressure'],
        }
      : volSpike > 1.65 && priceSlope < 0
        ? {
            model: 'Volume Agent',
            signal: 'SELL',
            confidence: clampConfidence(60 + (volSpike - 1) * 22 + slopePct * 140),
            reasons: ['volume expansion supports sellers', 'negative tape pressure'],
          }
        : {
            model: 'Volume Agent',
            signal: 'NO_TRADE',
            confidence: clampConfidence(58 + Math.max(0, 1.65 - volSpike) * 7),
            reasons: ['insufficient volume confirmation', 'breakout not validated'],
          };

  const tail = prices.slice(-30);
  const tailHigh = Math.max(...tail);
  const tailLow = Math.min(...tail);
  const rebound = (last - tailLow) / Math.max(last, 1);
  const rejection = (tailHigh - last) / Math.max(last, 1);
  const patternSignal: ModelSignal =
    rebound > 0.012 && tail[0] <= tailLow * 1.01
      ? {
          model: 'Pattern Agent',
          signal: 'BUY',
          confidence: clampConfidence(62 + rebound * 1800),
          reasons: ['washout then recovery', 'bullish reversal structure'],
        }
      : rejection > 0.012 && tail[0] >= tailHigh * 0.99
        ? {
            model: 'Pattern Agent',
            signal: 'SELL',
            confidence: clampConfidence(62 + rejection * 1800),
            reasons: ['failed breakout', 'bearish reversal structure'],
          }
        : {
            model: 'Pattern Agent',
            signal: 'NO_TRADE',
            confidence: clampConfidence(56),
            reasons: ['pattern quality low', 'no reliable reversal edge'],
          };

  const committee = [trend, momentum, volatility, volumeSignal, patternSignal];
  return committee.slice(0, COMMITTEE_SIZE);
}

export function aggregateSignals(signals: ModelSignal[], options: AggregateOptions = {}): MetaDecision {
  const { agentHitRates } = options;
  const committee = signals.slice(0, COMMITTEE_SIZE);
  if (committee.length < COMMITTEE_SIZE) {
    return {
      action: 'NO_TRADE',
      confidence: 50,
      reason: `Committee incomplete (${committee.length}/${COMMITTEE_SIZE}); conservative no-trade`,
    };
  }

  const buyVotes = committee.filter((signal) => signal.signal === 'BUY');
  const sellVotes = committee.filter((signal) => signal.signal === 'SELL');
  const noTradeVotes = committee.filter((signal) => signal.signal === 'NO_TRADE');

  if (buyVotes.length >= MIN_CONSENSUS_VOTES) {
    const overallConfidence = computeConsensusConfidence(
      buyVotes,
      committee.length,
      sellVotes.length,
      noTradeVotes.length,
      agentHitRates,
    );
    const edgePct = computeEdgePct(buyVotes, sellVotes, agentHitRates);
    if (overallConfidence > MIN_META_CONFIDENCE && edgePct >= MIN_EDGE_PCT) {
      return {
        action: 'BUY',
        confidence: overallConfidence,
        reason: `BUY consensus ${buyVotes.length}/5 | confidence ${overallConfidence}% | edge +${edgePct}`,
      };
    }
    const failures = [
      overallConfidence <= MIN_META_CONFIDENCE ? `confidence ${overallConfidence}% <= ${MIN_META_CONFIDENCE}%` : null,
      edgePct < MIN_EDGE_PCT ? `edge ${edgePct} < ${MIN_EDGE_PCT}` : null,
    ].filter(Boolean);
    return {
      action: 'NO_TRADE',
      confidence: overallConfidence,
      reason: `BUY votes ${buyVotes.length}/5 but ${failures.join(', ')} (${voteSummary(buyVotes, sellVotes, noTradeVotes)})`,
    };
  }

  if (sellVotes.length >= MIN_CONSENSUS_VOTES) {
    const overallConfidence = computeConsensusConfidence(
      sellVotes,
      committee.length,
      buyVotes.length,
      noTradeVotes.length,
      agentHitRates,
    );
    const edgePct = computeEdgePct(sellVotes, buyVotes, agentHitRates);
    if (overallConfidence > MIN_META_CONFIDENCE && edgePct >= MIN_EDGE_PCT) {
      return {
        action: 'SELL',
        confidence: overallConfidence,
        reason: `SELL consensus ${sellVotes.length}/5 | confidence ${overallConfidence}% | edge +${edgePct}`,
      };
    }
    const failures = [
      overallConfidence <= MIN_META_CONFIDENCE ? `confidence ${overallConfidence}% <= ${MIN_META_CONFIDENCE}%` : null,
      edgePct < MIN_EDGE_PCT ? `edge ${edgePct} < ${MIN_EDGE_PCT}` : null,
    ].filter(Boolean);
    return {
      action: 'NO_TRADE',
      confidence: overallConfidence,
      reason: `SELL votes ${sellVotes.length}/5 but ${failures.join(', ')} (${voteSummary(buyVotes, sellVotes, noTradeVotes)})`,
    };
  }

  if (buyVotes.length > 0 && sellVotes.length > 0) {
    const buyAvg = Math.round(avg(buyVotes.map((signal) => adjustedConfidence(signal, agentHitRates))));
    const sellAvg = Math.round(avg(sellVotes.map((signal) => adjustedConfidence(signal, agentHitRates))));
    return {
      action: 'NO_TRADE',
      confidence: 52,
      reason: `Conflict (${voteSummary(buyVotes, sellVotes, noTradeVotes)}; BUY avg ${buyAvg}% vs SELL avg ${sellAvg}%)`,
    };
  }

  if (noTradeVotes.length >= 3) {
    return {
      action: 'NO_TRADE',
      confidence: clampConfidence(avg(noTradeVotes.map((signal) => signal.confidence))),
      reason: `No-trade majority (${noTradeVotes.length}/5) and weak directional agreement`,
    };
  }

  return {
    action: 'NO_TRADE',
    confidence: 50,
    reason: 'Consensus below 4/5; Meta remains conservative by default',
  };
}
