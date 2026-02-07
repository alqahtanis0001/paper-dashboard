import { Deal, DealJump } from '@prisma/client';
import { prisma } from '../prisma';
import { buildSignals, aggregateSignals, type MetaDecision, type ModelSignal } from '../ai';
import { getIO } from '../socketServer';
import {
  type GraphMode,
  type GraphProfile,
  type GraphTimeframe,
  type NonAutoGraphMode,
  DEFAULT_GRAPH_MODE,
  DEFAULT_GRAPH_TIMEFRAME,
  GRAPH_MODE_PROFILES,
  NON_AUTO_GRAPH_MODES,
  normalizeGraphMode,
  normalizeGraphTimeframe,
  timeframeToMs,
} from './graphModes';
import { runtimeEnv } from '../runtimeEnv';
import { getMarket, type MarketEvent, type MarketSpec, type RegimeOverride } from '@/lib/markets';
import { getEngineConfig, setEngineConfig } from '@/lib/engine/engineConfig';

type Candle = {
  time: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type DealWithJumps = Deal & { jumps: DealJump[] };

type MarketRegime = 'TRENDING' | 'CHOPPY' | 'HIGH_VOL' | 'LOW_VOL';

type RegimeState = {
  kind: MarketRegime;
  driftBpsPerSec: number;
  noiseBps: number;
  wickBps: number;
  volumeBase: number;
  volumeJitter: number;
  meanRevert: number;
  trendDirection?: 1 | -1;
};

type ModeRuntimeState = {
  phaseOffset: number;
  driftTilt: number;
  noiseTilt: number;
  volumeTilt: number;
  shockTilt: number;
};

type SyntheticModeState = {
  price: number;
  startTime: number;
  candles: Candle[];
  regime: RegimeState | null;
  nextRegimeSwitch: number;
  lastTickAt: number;
};

type MetaStatus = {
  text: string;
  stage: string;
};

type AiRuntimeSnapshot = {
  signals: ModelSignal[];
  meta: MetaDecision;
  hitRates: { meta: number; agents: Record<string, number> };
  lastSignalAt: number | null;
};

type EngineControlState = {
  symbol: string;
  market: {
    id: string;
    label: string;
    regimeOverride: RegimeOverride;
    intensity: number;
    activeRegime: MarketRegime | null;
    trendDirection: number;
    rules: { feeBps: number; minNotionalUsd: number; maxLeverage: number };
    ai: MarketSpec['ai'];
  };
  selectedGraphMode: GraphMode;
  timeframe: GraphTimeframe;
  activeDealId: string | null;
  hasRunningDeal: boolean;
  metaStatus: MetaStatus;
  ai: AiRuntimeSnapshot;
};

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

const buildModeRuntime = (): Record<NonAutoGraphMode, ModeRuntimeState> => {
  const entries = NON_AUTO_GRAPH_MODES.map((mode) => [
    mode,
    {
      phaseOffset: randomBetween(0, Math.PI * 2),
      driftTilt: randomBetween(0.82, 1.18),
      noiseTilt: randomBetween(0.86, 1.22),
      volumeTilt: randomBetween(0.8, 1.24),
      shockTilt: randomBetween(0.8, 1.3),
    } satisfies ModeRuntimeState,
  ] as const);

  return Object.fromEntries(entries) as Record<NonAutoGraphMode, ModeRuntimeState>;
};

class DealEngine {
  private watcher: NodeJS.Timeout | null = null;
  private marketTickTimer: NodeJS.Timeout | null = null;
  private signalTimer: NodeJS.Timeout | null = null;
  private currentDeal: DealWithJumps | null = null;
  private price = 0;
  private startTime = 0;
  private candles: Candle[] = [];
  private regime: RegimeState | null = null;
  private nextRegimeSwitch = 0;
  private lastTickAt = 0;
  private signalOutcomes: { id: string; time: number; price: number; action: 'BUY' | 'SELL' | 'NO_TRADE'; horizonSec: number }[] = [];
  private market: MarketSpec = getMarket('BTC');
  private regimeOverride: RegimeOverride = 'AUTO';
  private intensity = 1.0;
  private timeframeMs = 1000;
  private lastCandleOpenTimeMs = 0;
  private activeEvent: { event: MarketEvent; startedAt: number } | null = null;

  private selectedGraphMode: GraphMode = DEFAULT_GRAPH_MODE;
  private selectedTimeframe: GraphTimeframe = DEFAULT_GRAPH_TIMEFRAME;
  private autoGraphMode: NonAutoGraphMode = NON_AUTO_GRAPH_MODES[0];
  private autoGraphModeUntil = 0;
  private modeRuntime: Record<NonAutoGraphMode, ModeRuntimeState> = buildModeRuntime();
  private syntheticActiveMode: NonAutoGraphMode = NON_AUTO_GRAPH_MODES[0];
  private syntheticModeStates: Partial<Record<NonAutoGraphMode, SyntheticModeState>> = {};
  private metaStatus: MetaStatus = { text: 'Monitoring markets...', stage: 'idle' };
  private aiRuntime: AiRuntimeSnapshot = {
    signals: [],
    meta: { action: 'NO_TRADE', confidence: 0, reason: 'Waiting for data' },
    hitRates: { meta: 0, agents: {} },
    lastSignalAt: null,
  };

  constructor() {
    this.resetSyntheticClock();
    this.reseedSyntheticMarket(false);
    this.startMarketTicks();
    this.startWatcher();
    void getEngineConfig()
      .then((cfg) => {
        this.market = getMarket(cfg.activeMarketId);
        this.regimeOverride = cfg.regimeOverride;
        this.intensity = cfg.intensity;
        this.price = this.market.price.basePrice;
        this.resetSyntheticClock();
        this.reseedSyntheticMarket(true, true);
        this.emitControlState();
      })
      .catch(() => null);
  }

  private log(msg: string) {
    if (process.env.NODE_ENV !== 'production') console.log('[DealEngine]', msg);
  }

  private static gaussianRandom() {
    return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  }

  private resetSyntheticClock() {
    const now = Date.now();
    this.lastCandleOpenTimeMs = now - (now % this.timeframeMs);
  }

  private nextCandleTime() {
    this.lastCandleOpenTimeMs += this.timeframeMs;
    return this.lastCandleOpenTimeMs;
  }

  private getEventMultiplier() {
    if (!this.activeEvent) return 0;
    const elapsed = (Date.now() - this.activeEvent.startedAt) / 1000;
    const remain = Math.max(0, 1 - elapsed / Math.max(this.activeEvent.event.decaySec, 1));
    if (remain <= 0) {
      this.activeEvent = null;
      return 0;
    }
    return (this.activeEvent.event.magnitudeBps / 10000) * remain;
  }

  private emitControlState() {
    const io = getIO();
    io?.emit('control_state', this.getControlState());
  }

  private setMetaStatus(text: string, stage: string) {
    this.metaStatus = { text, stage };
    const io = getIO();
    io?.emit('meta_status', this.metaStatus);
  }

  private startWatcher() {
    if (this.watcher) return;
    this.watcher = setInterval(() => void this.checkDeals(), 5000);
    void this.checkDeals();
  }

  private startMarketTicks() {
    if (this.marketTickTimer) return;
    this.marketTickTimer = setInterval(() => {
      if (this.currentDeal) {
        this.generateDealTick(this.currentDeal);
      } else {
        this.generateSyntheticTick();
      }
    }, 200);
  }

  private async checkDeals() {
    if (this.currentDeal) return;
    const now = new Date();
    try {
      const deal = await prisma.deal.findFirst({
        where: { status: 'SCHEDULED', startTimeUtc: { lte: now } },
        include: { jumps: { orderBy: { orderIndex: 'asc' } } },
        orderBy: { startTimeUtc: 'asc' },
      });
      if (deal) {
        await prisma.deal.update({ where: { id: deal.id }, data: { status: 'RUNNING' } });
        this.runDeal(deal);
      }
    } catch (err: unknown) {
      // If tables are not ready (P2021) or connection issue, skip and retry on next tick
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[DealEngine] checkDeals skipped due to error:', code ?? (err instanceof Error ? err.message : err));
      }
    }
  }

  private pickAutoMode(now: number) {
    const candidates = NON_AUTO_GRAPH_MODES.filter((mode) => mode !== this.autoGraphMode);
    const chosen = candidates[Math.floor(Math.random() * candidates.length)] ?? NON_AUTO_GRAPH_MODES[0];
    this.autoGraphMode = chosen;
    this.autoGraphModeUntil = now + Math.floor(randomBetween(25000, 70000));
    this.log(`Auto graph mode -> ${chosen}`);
  }

  private getResolvedGraphMode(now: number): NonAutoGraphMode {
    if (this.selectedGraphMode !== 'AUTO') return this.selectedGraphMode;
    if (now >= this.autoGraphModeUntil || !this.autoGraphMode) {
      this.pickAutoMode(now);
    }
    return this.autoGraphMode;
  }

  private cloneRegime(regime: RegimeState | null) {
    return regime ? { ...regime } : null;
  }

  private captureSyntheticState(mode: NonAutoGraphMode) {
    if (this.currentDeal) return;
    this.syntheticModeStates[mode] = {
      price: this.price,
      startTime: this.startTime,
      candles: this.candles.map((candle) => ({ ...candle })),
      regime: this.cloneRegime(this.regime),
      nextRegimeSwitch: this.nextRegimeSwitch,
      lastTickAt: this.lastTickAt,
    };
  }

  private restoreSyntheticState(mode: NonAutoGraphMode) {
    const state = this.syntheticModeStates[mode];
    if (!state) return false;

    this.price = state.price;
    this.startTime = state.startTime;
    this.candles = state.candles.map((candle) => ({ ...candle }));
    this.regime = this.cloneRegime(state.regime);
    this.nextRegimeSwitch = state.nextRegimeSwitch;
    this.lastTickAt = state.lastTickAt;
    return true;
  }

  private pickRegime(prev?: RegimeState | null): RegimeState {
    const base = this.market.price;
    const k = this.intensity;

    const makeRegime = (kind: MarketRegime, direction?: 1 | -1): RegimeState => {
      if (kind === 'TRENDING') {
        return {
          kind,
          driftBpsPerSec: randomBetween(base.driftBpsPerSec * 8, base.driftBpsPerSec * 26) * k,
          noiseBps: randomBetween(base.noiseBps * 0.65, base.noiseBps * 1.25) * k,
          wickBps: randomBetween(base.wickBps * 0.8, base.wickBps * 1.5) * k,
          volumeBase: randomBetween(base.volumeBase * 0.9, base.volumeBase * 1.45) * k,
          volumeJitter: randomBetween(base.volumeJitter * 0.75, base.volumeJitter * 1.3) * k,
          meanRevert: Math.min(0.85, base.meanRevert * 0.85),
          trendDirection: direction ?? (Math.random() < 0.5 ? -1 : 1),
        };
      }
      if (kind === 'HIGH_VOL') {
        return {
          kind,
          driftBpsPerSec: randomBetween(-base.driftBpsPerSec * 2.5, base.driftBpsPerSec * 2.5) * k,
          noiseBps: randomBetween(base.noiseBps * 1.6, base.noiseBps * 3.2) * k,
          wickBps: randomBetween(base.wickBps * 1.8, base.wickBps * 3.2) * k,
          volumeBase: randomBetween(base.volumeBase * 1.15, base.volumeBase * 1.85) * k,
          volumeJitter: randomBetween(base.volumeJitter * 1.2, base.volumeJitter * 2.2) * k,
          meanRevert: Math.min(0.85, base.meanRevert * 1.25),
        };
      }
      if (kind === 'CHOPPY') {
        return {
          kind,
          driftBpsPerSec: randomBetween(-base.driftBpsPerSec * 3.2, base.driftBpsPerSec * 3.2) * k,
          noiseBps: randomBetween(base.noiseBps * 0.9, base.noiseBps * 1.65) * k,
          wickBps: randomBetween(base.wickBps * 0.85, base.wickBps * 1.45) * k,
          volumeBase: randomBetween(base.volumeBase * 0.72, base.volumeBase * 1.2) * k,
          volumeJitter: randomBetween(base.volumeJitter * 0.7, base.volumeJitter * 1.25) * k,
          meanRevert: Math.min(0.9, base.meanRevert * 1.45),
        };
      }
      return {
        kind: 'LOW_VOL',
        driftBpsPerSec: randomBetween(-base.driftBpsPerSec * 1.4, base.driftBpsPerSec * 1.4) * Math.max(0.35, k * 0.8),
        noiseBps: randomBetween(base.noiseBps * 0.3, base.noiseBps * 0.7) * Math.max(0.35, k * 0.8),
        wickBps: randomBetween(base.wickBps * 0.45, base.wickBps * 0.85) * Math.max(0.35, k * 0.8),
        volumeBase: randomBetween(base.volumeBase * 0.45, base.volumeBase * 0.8),
        volumeJitter: randomBetween(base.volumeJitter * 0.4, base.volumeJitter * 0.75),
        meanRevert: Math.min(0.95, base.meanRevert * 1.7),
      };
    };

    if (this.regimeOverride !== 'AUTO') {
      if (this.regimeOverride === 'BULL') return makeRegime('TRENDING', 1);
      if (this.regimeOverride === 'BEAR') return makeRegime('TRENDING', -1);
      return makeRegime(this.regimeOverride);
    }

    const pool: { kind: MarketRegime; weight: number }[] = [
      { kind: 'TRENDING', weight: 0.32 },
      { kind: 'CHOPPY', weight: 0.28 },
      { kind: 'HIGH_VOL', weight: 0.24 },
      { kind: 'LOW_VOL', weight: 0.16 },
    ];
    const total = pool.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * total;
    let chosen: MarketRegime = pool[0].kind;
    for (const item of pool) {
      roll -= item.weight;
      if (roll <= 0) {
        chosen = item.kind;
        break;
      }
    }

    if (prev && prev.kind === chosen && Math.random() < 0.42) {
      const alternatives = pool.filter((item) => item.kind !== prev.kind);
      chosen = alternatives[Math.floor(Math.random() * alternatives.length)].kind;
    }

    const direction = prev?.kind === 'TRENDING' && prev.trendDirection && Math.random() < 0.58 ? prev.trendDirection : undefined;
    return makeRegime(chosen, direction);
  }

  private scheduleRegime(now: number = Date.now()) {
    this.regime = this.pickRegime(this.regime);
    this.nextRegimeSwitch = now + randomBetween(12000, 24000);
    this.log(`Regime -> ${this.regime.kind}`);
  }

  private maybeRotateRegime(now: number) {
    if (!this.regime || now >= this.nextRegimeSwitch || Math.random() < 0.003) {
      this.scheduleRegime(now);
    }
  }

  private computeSyntheticAnchor(now: number, profile: GraphProfile, runtime: ModeRuntimeState): number {
    const phase = (now / 1000 + runtime.phaseOffset) / profile.cycleSec;
    const macroWave = Math.sin(phase * Math.PI * 2) * (profile.waveBps / 10000);
    const microWave = Math.sin(phase * Math.PI * 2.8 + runtime.phaseOffset * 0.4) * (profile.microWaveBps / 10000);
    const longWave = Math.sin((now / 1000 + runtime.phaseOffset) / (profile.cycleSec * 6)) * ((profile.waveBps / 10000) * 0.35);
    return this.market.price.basePrice * (1 + macroWave + microWave + longWave);
  }

  private upsertCandle(now: number, price: number, regime: RegimeState, anchorPrice: number): Candle {
    const bucketMs = this.timeframeMs;
    const bucketScale = Math.max(1, Math.sqrt(bucketMs / 1000));

    const wickSwing =
      (regime.wickBps / 10000) *
      DealEngine.gaussianRandom() *
      (Math.random() < (regime.kind === 'HIGH_VOL' ? 0.6 : 0.35) ? 3.2 : 1.8);
    const wickPrice = Math.max(anchorPrice * 0.08, price * (1 + wickSwing));

    const lastCandle = this.candles[this.candles.length - 1];
    const currentBucket = Math.floor(now / bucketMs) * bucketMs;
    const isSameBucket = Boolean(lastCandle && lastCandle.time === currentBucket);

    if (!lastCandle || !isSameBucket) {
      if (this.lastCandleOpenTimeMs === 0) this.resetSyntheticClock();
      const open = lastCandle?.close ?? price;
      const initialVolume = Math.max(
        3,
        regime.volumeBase * bucketScale * randomBetween(0.55, 1.35) + Math.random() * regime.volumeJitter * 0.45 * bucketScale,
      );
      const t = this.nextCandleTime();
      this.candles.push({
        time: t,
        open,
        high: Math.max(open, price, wickPrice),
        low: Math.max(0.0000001, Math.min(open, price, wickPrice)),
        close: price,
        volume: initialVolume,
      });
    } else {
      lastCandle.high = Math.max(lastCandle.high, wickPrice, price);
      lastCandle.low = Math.max(0.0000001, Math.min(lastCandle.low, wickPrice, price));
      lastCandle.close = price;
      const incrementalVolume = (regime.volumeBase * 0.09 + Math.random() * (regime.volumeJitter * 0.35)) * (bucketScale / 2.4);
      lastCandle.volume += Math.max(0, incrementalVolume);
    }

    if (this.candles.length > 3000) this.candles = this.candles.slice(-2500);
    return this.candles[this.candles.length - 1];
  }

  private createSyntheticState(mode: NonAutoGraphMode, now: number): SyntheticModeState {
    const profile = GRAPH_MODE_PROFILES[mode];
    const runtime = this.modeRuntime[mode];
    const bucketMs = this.timeframeMs;
    const seedRegime = this.pickRegime(null);
    const nextRegimeSwitch = now + randomBetween(12000, 24000);

    const seedCount = 250;
    const seeded: Candle[] = [];
    let workingPrice = this.market.price.basePrice * randomBetween(0.94, 1.06);
    let prevClose = workingPrice;

    for (let i = seedCount - 1; i >= 0; i -= 1) {
      const ts = now - i * bucketMs;
      const anchor = this.computeSyntheticAnchor(ts, profile, runtime);
      const drift =
        this.market.price.basePrice *
        ((profile.trendBpsPerSec * runtime.driftTilt) / 10000) *
        (0.4 + Math.sin((ts / 1000 + runtime.phaseOffset) / (profile.cycleSec * 4)) * 0.6);
      const pull = (anchor - workingPrice) * profile.meanRevert * 0.55;
      const noise = this.market.price.basePrice * ((profile.noiseBps * runtime.noiseTilt) / 10000) * DealEngine.gaussianRandom() * 0.55;
      workingPrice = Math.max(this.market.price.basePrice * 0.08, workingPrice + drift + pull + noise);

      const wickRange = workingPrice * ((profile.wickBps * runtime.noiseTilt) / 10000) * randomBetween(0.5, 1.8);
      const high = Math.max(prevClose, workingPrice) + wickRange * randomBetween(0.12, 0.9);
      const low = Math.max(0.0000001, Math.min(prevClose, workingPrice) - wickRange * randomBetween(0.12, 0.9));
      const volume = Math.max(
        3,
        (profile.volumeBase * runtime.volumeTilt + Math.random() * profile.volumeJitter) * Math.max(1, Math.sqrt(bucketMs / 1000)),
      );

      seeded.push({
        time: Math.floor(ts / bucketMs) * bucketMs,
        open: prevClose,
        high,
        low,
        close: workingPrice,
        volume,
      });

      prevClose = workingPrice;
    }

    return {
      price: seeded[seeded.length - 1]?.close ?? this.market.price.basePrice,
      startTime: now,
      candles: seeded,
      regime: seedRegime,
      nextRegimeSwitch,
      lastTickAt: now,
    };
  }

  private applySyntheticState(state: SyntheticModeState) {
    this.price = state.price;
    this.startTime = state.startTime;
    this.candles = state.candles.map((candle) => ({ ...candle }));
    this.regime = this.cloneRegime(state.regime);
    this.nextRegimeSwitch = state.nextRegimeSwitch;
    this.lastTickAt = state.lastTickAt;
  }

  private activateSyntheticMode(mode: NonAutoGraphMode, now: number, forceReseed: boolean) {
    if (!forceReseed && this.syntheticActiveMode !== mode && this.candles.length > 0) {
      this.captureSyntheticState(this.syntheticActiveMode);
    }

    if (!forceReseed && this.restoreSyntheticState(mode)) {
      this.syntheticActiveMode = mode;
      return;
    }

    const fresh = this.createSyntheticState(mode, now);
    this.syntheticModeStates[mode] = {
      ...fresh,
      candles: fresh.candles.map((candle) => ({ ...candle })),
      regime: this.cloneRegime(fresh.regime),
    };
    this.applySyntheticState(fresh);
    this.syntheticActiveMode = mode;
  }

  private reseedSyntheticMarket(emitSocketUpdate: boolean, forceReseed = false) {
    if (this.currentDeal) return;

    const now = Date.now();
    const mode = this.getResolvedGraphMode(now);
    this.activateSyntheticMode(mode, now, forceReseed);
    this.maybeRotateRegime(now);

    if (emitSocketUpdate) {
      const io = getIO();
      io?.emit('market_selected', { symbol: this.getSelectedSymbol(), timeframe: this.selectedTimeframe, source: 'synthetic' });
      const latest = this.candles[this.candles.length - 1];
      if (latest) {
        io?.emit('price_tick', {
          timestamp: latest.time,
          price: latest.close,
          candle: latest,
          regime: this.regime?.kind ?? 'CHOPPY',
          mode,
        });
      }
    }
  }

  private computeScenarioPrice(deal: DealWithJumps, elapsedSec: number) {
    const base = deal.basePrice;
    let biasPct = 0;

    if (elapsedSec >= deal.dropDelaySec) {
      const prog = Math.min((elapsedSec - deal.dropDelaySec) / 4, 1);
      biasPct -= deal.dropMagnitudePct * prog;
    }

    for (const jump of deal.jumps) {
      const phase = elapsedSec - jump.riseDelaySec;
      if (phase < 0) continue;
      if (phase <= 3) {
        const ramp = Math.min(phase / 3, 1);
        biasPct += jump.riseMagnitudePct * ramp;
      } else if (phase <= jump.holdSec + 3) {
        biasPct += jump.riseMagnitudePct;
      } else {
        const decay = Math.min((phase - jump.holdSec - 3) / 5, 1);
        biasPct += jump.riseMagnitudePct * Math.max(1 - decay, 0);
      }
    }

    const noise = base * 0.0006 * DealEngine.gaussianRandom();
    return base * (1 + biasPct / 100) + noise;
  }

  private generateDealTick(deal: DealWithJumps) {
    const now = Date.now();
    const elapsedSec = (now - this.startTime) / 1000;
    this.maybeRotateRegime(now);

    const anchorPrice = this.computeScenarioPrice(deal, elapsedSec);
    const prevPrice = this.price || anchorPrice;
    const dtSec = Math.max((now - (this.lastTickAt || now)) / 1000, 0.05);
    this.lastTickAt = now;

    const regime = this.regime ?? this.pickRegime();
    const driftDirection = regime.kind === 'TRENDING' ? regime.trendDirection ?? 1 : 1;
    const driftTerm = anchorPrice * ((regime.driftBpsPerSec * driftDirection * dtSec) / 10000);
    const noiseScale = Math.sqrt(dtSec * 4);
    const noiseTerm = anchorPrice * (regime.noiseBps / 10000) * DealEngine.gaussianRandom() * noiseScale;
    const pullTerm = (anchorPrice - prevPrice) * regime.meanRevert * Math.min(dtSec * 1.1, 1);

    const unclampedPrice = prevPrice + pullTerm + driftTerm + noiseTerm;
    const maxJump = Math.max(prevPrice * 0.25, anchorPrice * 0.1);
    const boundedPrice = Math.min(Math.max(unclampedPrice, prevPrice - maxJump), prevPrice + maxJump);
    const eventTerm = prevPrice * this.getEventMultiplier();
    const rawPrice = boundedPrice + eventTerm;
    const minPrice = this.market.price.minPrice ?? anchorPrice * 0.2;
    const maxPrice = this.market.price.maxPrice ?? Number.POSITIVE_INFINITY;
    const price = Math.min(maxPrice, Math.max(minPrice, rawPrice));

    const candle = this.upsertCandle(now, price, regime, anchorPrice);
    this.price = price;

    const io = getIO();
    io?.emit('price_tick', { timestamp: now, price, candle, regime: regime.kind, mode: deal.symbol });
  }

  private generateSyntheticTick() {
    const now = Date.now();
    const mode = this.getResolvedGraphMode(now);
    if (mode !== this.syntheticActiveMode) {
      this.activateSyntheticMode(mode, now, false);
      const io = getIO();
      io?.emit('market_selected', { symbol: this.getSelectedSymbol(), timeframe: this.selectedTimeframe, source: 'synthetic' });
    }
    this.maybeRotateRegime(now);

    const profile = GRAPH_MODE_PROFILES[mode];
    const runtime = this.modeRuntime[mode];
    const regime = this.regime ?? this.pickRegime();

    const anchorPrice = this.computeSyntheticAnchor(now, profile, runtime);
    const prevPrice = this.price || this.market.price.basePrice;
    const dtSec = Math.max((now - (this.lastTickAt || now)) / 1000, 0.05);
    this.lastTickAt = now;

    const driftDirection = regime.kind === 'TRENDING' ? regime.trendDirection ?? 1 : 1;
    const profileDrift = profile.trendBpsPerSec * runtime.driftTilt;
    const regimeDrift = regime.driftBpsPerSec * 0.65 * driftDirection;
    const longSwing = Math.sin((now / 1000 + runtime.phaseOffset) / (profile.cycleSec * 4));
    const driftTerm =
      this.market.price.basePrice *
      ((profileDrift + regimeDrift) / 10000) *
      dtSec *
      (0.62 + longSwing * 0.68);

    const noiseBps = profile.noiseBps * runtime.noiseTilt + regime.noiseBps * 0.55;
    const noiseTerm =
      this.market.price.basePrice * (noiseBps / 10000) * DealEngine.gaussianRandom() * Math.sqrt(dtSec * 1.9);

    const pullStrength = Math.min(profile.meanRevert + regime.meanRevert * 0.25, 0.85);
    const pullTerm = (anchorPrice - prevPrice) * pullStrength * Math.min(dtSec * 1.15, 1);

    let shockTerm = 0;
    const shockProb = profile.shockChance * runtime.shockTilt * Math.max(0.1, dtSec);
    if (Math.random() < shockProb) {
      const shockDirection = Math.random() < 0.5 ? -1 : 1;
      shockTerm =
        this.market.price.basePrice *
        (profile.shockBps / 10000) *
        shockDirection *
        randomBetween(0.45, 1.2);
    }

    const unclampedPrice = prevPrice + driftTerm + noiseTerm + pullTerm + shockTerm;
    const maxJump = Math.max(prevPrice * 0.2, this.market.price.basePrice * 0.07);
    const boundedPrice = Math.min(Math.max(unclampedPrice, prevPrice - maxJump), prevPrice + maxJump);
    const price = Math.max(this.market.price.basePrice * 0.08, boundedPrice);

    const syntheticRegime: RegimeState = {
      ...regime,
      noiseBps: regime.noiseBps + profile.noiseBps * 0.5,
      wickBps: regime.wickBps + profile.wickBps * runtime.noiseTilt * 0.6,
      volumeBase: regime.volumeBase + profile.volumeBase * runtime.volumeTilt * 0.7,
      volumeJitter: regime.volumeJitter + profile.volumeJitter * runtime.volumeTilt * 0.55,
      meanRevert: Math.min(0.85, regime.meanRevert + profile.meanRevert * 0.45),
    };

    const candle = this.upsertCandle(now, price, syntheticRegime, anchorPrice);
    this.price = price;

    const io = getIO();
    io?.emit('price_tick', { timestamp: now, price, candle, regime: syntheticRegime.kind, mode });

    if (this.selectedGraphMode === 'AUTO' && now >= this.autoGraphModeUntil) {
      this.pickAutoMode(now);
    }
  }

  async runDeal(deal: DealWithJumps) {
    if (this.currentDeal) return;

    this.captureSyntheticState(this.syntheticActiveMode);
    this.currentDeal = deal;
    this.price = deal.basePrice;
    this.startTime = Date.now();
    this.candles = [];
    this.lastTickAt = Date.now();
    this.scheduleRegime();
    this.setMetaStatus('Scanning markets...', 'scanning');
    this.emitControlState();

    const io = getIO();

    setTimeout(() => {
      io?.emit('market_selected', {
        symbol: deal.symbol,
        chainName: deal.chainName,
        basePrice: deal.basePrice,
        startTime: deal.startTimeUtc,
        timeframe: this.selectedTimeframe,
      });
      this.setMetaStatus(`Trade identified: ${deal.symbol} (${deal.chainName})`, 'identified');
      this.emitControlState();
    }, 1000);

    if (this.signalTimer) clearInterval(this.signalTimer);
    this.signalTimer = setInterval(() => void this.emitSignals(deal), 1000);

    setTimeout(() => {
      void this.finishDeal();
    }, deal.totalDurationSec * 1000);
  }

  private async computeLast50HitRates() {
    const resolved = await prisma.aiSignalLog.findMany({
      where: { resolvedAt: { not: null }, outcomePct: { not: null } },
      orderBy: { resolvedAt: 'desc' },
      take: 50,
    });

    const thresholdPct = 0.15;
    const metaStats = { wins: 0, total: 0 };
    const agentStats: Record<string, { wins: number; total: number }> = {};

    for (const row of resolved) {
      const outcomePct = row.outcomePct ?? 0;
      const resolvedFlat = Math.abs(outcomePct) <= thresholdPct;
      const meta = (row.metaDecisionJson ?? {}) as { action?: 'BUY' | 'SELL' | 'NO_TRADE' };
      const metaAction = meta.action ?? 'NO_TRADE';
      const metaCorrect = metaAction === 'BUY' ? outcomePct > 0 : metaAction === 'SELL' ? outcomePct < 0 : resolvedFlat;
      metaStats.total += 1;
      if (metaCorrect) metaStats.wins += 1;

      const signals = (row.signalsJson as ModelSignal[] | null) ?? [];
      for (const signal of signals) {
        if (!agentStats[signal.model]) agentStats[signal.model] = { wins: 0, total: 0 };
        const stat = agentStats[signal.model];
        stat.total += 1;
        const ok = signal.signal === 'BUY' ? outcomePct > 0 : signal.signal === 'SELL' ? outcomePct < 0 : resolvedFlat;
        if (ok) stat.wins += 1;
      }
    }

    return {
      meta: metaStats.total ? Math.round((metaStats.wins / metaStats.total) * 100) : 0,
      agents: Object.fromEntries(Object.entries(agentStats).map(([key, value]) => [key, value.total ? Math.round((value.wins / value.total) * 100) : 0])),
    };
  }

  private async settleSignalOutcomes(currentPrice: number) {
    const now = Date.now();
    const matured = this.signalOutcomes.filter((signal) => now - signal.time >= signal.horizonSec * 1000);
    this.signalOutcomes = this.signalOutcomes.filter((signal) => now - signal.time < signal.horizonSec * 1000);

    for (const signal of matured) {
      const outcomePct = ((currentPrice - signal.price) / signal.price) * 100;
      const isFlat = Math.abs(outcomePct) <= 0.15;
      const metaCorrect = signal.action === 'BUY' ? outcomePct > 0 : signal.action === 'SELL' ? outcomePct < 0 : isFlat;
      await prisma.aiSignalLog
        .update({
          where: { id: signal.id },
          data: {
            resolvedAt: new Date(),
            outcomePct,
            metaCorrect,
          },
        })
        .catch(() => null);
    }

    const hitRates = await this.computeLast50HitRates().catch(() => ({ meta: 0, agents: {} as Record<string, number> }));
    if (matured.length > 0) {
      await prisma.aiSignalLog
        .updateMany({
          where: { id: { in: matured.map((item) => item.id) } },
          data: { hitRatesJson: hitRates as unknown as object },
        })
        .catch(() => null);
    }

    return hitRates;
  }

  private async emitSignals(deal: DealWithJumps) {
    const prices = this.candles.map((candle) => candle.close);
    if (prices.length < 5) return;

    const currentPrice = prices[prices.length - 1];
    const hitRates = await this.settleSignalOutcomes(currentPrice);
    const signals = buildSignals(prices, this.candles.map((candle) => candle.volume));
    const meta = aggregateSignals(signals, { agentHitRates: hitRates.agents });

    const created = await prisma.aiSignalLog
      .create({
        data: {
          dealId: deal.id,
          signalsJson: signals as unknown as object,
          metaDecisionJson: meta as unknown as object,
          horizonSec: 60,
        },
      })
      .catch(() => null);

    if (created) {
      this.signalOutcomes.push({
        id: created.id,
        time: Date.now(),
        price: currentPrice,
        action: meta.action,
        horizonSec: created.horizonSec,
      });
    }

    this.aiRuntime = {
      signals: signals.map((signal) => ({ ...signal, reasons: [...signal.reasons] })),
      meta: { ...meta },
      hitRates: { meta: hitRates.meta, agents: { ...hitRates.agents } },
      lastSignalAt: Date.now(),
    };

    const io = getIO();
    io?.emit('ai_signals', {
      signals,
      meta,
      hitRates,
    });
    io?.emit('deal_state', { status: 'RUNNING', dealId: deal.id });
    this.emitControlState();
  }

  private async finishDeal() {
    if (!this.currentDeal) return;

    const dealId = this.currentDeal.id;
    if (this.signalTimer) clearInterval(this.signalTimer);
    this.signalTimer = null;
    this.regime = null;
    this.nextRegimeSwitch = 0;
    this.lastTickAt = 0;

    await prisma.deal.update({ where: { id: dealId }, data: { status: 'FINISHED' } }).catch(() => null);
    const io = getIO();
    io?.emit('deal_state', { status: 'FINISHED', dealId });

    this.currentDeal = null;
    this.setMetaStatus('Monitoring synthetic markets...', 'idle');
    this.reseedSyntheticMarket(true);
    this.emitControlState();
  }

  setChartPreferences(inputMode?: string | null, inputTimeframe?: string | null) {
    const modeProvided = typeof inputMode === 'string';
    const timeframeProvided = typeof inputTimeframe === 'string';

    const nextMode = modeProvided ? normalizeGraphMode(inputMode) : this.selectedGraphMode;
    const nextTimeframe = timeframeProvided ? normalizeGraphTimeframe(inputTimeframe) : this.selectedTimeframe;

    const modeChanged = nextMode !== this.selectedGraphMode;
    const timeframeChanged = nextTimeframe !== this.selectedTimeframe;

    if (!modeChanged && !timeframeChanged) {
      this.emitControlState();
      return { symbol: this.getSelectedSymbol(), timeframe: this.selectedTimeframe };
    }

    this.selectedGraphMode = nextMode;
    this.selectedTimeframe = nextTimeframe;
    this.timeframeMs = timeframeToMs(this.selectedTimeframe);
    this.resetSyntheticClock();

    if (!this.currentDeal) {
      if (timeframeChanged) {
        this.syntheticModeStates = {};
      }
      this.reseedSyntheticMarket(true, timeframeChanged);
    } else if (timeframeChanged) {
      this.candles = this.candles.slice(-250);
      this.lastTickAt = Date.now();
      const io = getIO();
      io?.emit('market_selected', { symbol: this.currentDeal.symbol, timeframe: this.selectedTimeframe, source: 'deal' });
    }

    this.emitControlState();
    return { symbol: this.getSelectedSymbol(), timeframe: this.selectedTimeframe };
  }

  getControlState(): EngineControlState {
    return {
      symbol: this.getSelectedSymbol(),
      market: {
        id: this.market.id,
        label: this.market.label,
        regimeOverride: this.regimeOverride,
        intensity: this.intensity,
        activeRegime: this.regime?.kind ?? null,
        trendDirection: this.regime?.trendDirection ?? 0,
        rules: this.market.rules,
        ai: this.market.ai,
      },
      selectedGraphMode: this.selectedGraphMode,
      timeframe: this.selectedTimeframe,
      activeDealId: this.currentDeal?.id ?? null,
      hasRunningDeal: !!this.currentDeal,
      metaStatus: { ...this.metaStatus },
      ai: {
        signals: this.aiRuntime.signals.map((signal) => ({ ...signal, reasons: [...signal.reasons] })),
        meta: { ...this.aiRuntime.meta },
        hitRates: { meta: this.aiRuntime.hitRates.meta, agents: { ...this.aiRuntime.hitRates.agents } },
        lastSignalAt: this.aiRuntime.lastSignalAt,
      },
    };
  }

  notifyControlState() {
    this.emitControlState();
    return this.getControlState();
  }

  async setMarketAndOverride(next: { activeMarketId?: string; regimeOverride?: RegimeOverride; intensity?: number }) {
    const updated = await setEngineConfig({
      activeMarketId: next.activeMarketId,
      regimeOverride: next.regimeOverride,
      intensity: next.intensity,
    });

    this.market = getMarket(updated.activeMarketId);
    this.regimeOverride = updated.regimeOverride;
    this.intensity = updated.intensity;
    this.price = this.market.price.basePrice;
    this.regime = null;
    this.nextRegimeSwitch = 0;
    this.syntheticModeStates = {};
    this.resetSyntheticClock();
    this.reseedSyntheticMarket(true, true);
    this.emitControlState();
    return this.getControlState();
  }

  triggerMarketEvent(kind: 'NEWS_SPIKE' | 'DUMP' | 'SQUEEZE', strength = 1) {
    const k = Math.max(0.2, Math.min(3, strength));
    const event = kind === 'NEWS_SPIKE' ? this.market.events.newsSpike(k) : kind === 'DUMP' ? this.market.events.dump(k) : this.market.events.squeeze(k);
    this.activeEvent = { event, startedAt: Date.now() };
    return event;
  }

  getTradingRules() {
    return this.market.rules;
  }


  getCurrentPrice() {
    return this.price || this.currentDeal?.basePrice || 0;
  }

  getRegimeVolatility() {
    if (!this.regime) return 0.65;
    if (this.regime.kind === 'HIGH_VOL') return 1.6;
    if (this.regime.kind === 'LOW_VOL') return 0.3;
    if (this.regime.kind === 'CHOPPY') return 0.85;
    return 1.05;
  }

  getActiveDealId() {
    return this.currentDeal?.id ?? null;
  }

  getRecentCandles(limit = 250): Candle[] {
    return this.candles.slice(-Math.max(1, limit));
  }

  getSelectedSymbol() {
    return this.currentDeal?.symbol ?? this.market.id;
  }

  getSelectedTimeframe() {
    return this.selectedTimeframe;
  }
}

// singleton
class DealEngineDisabled {
  // minimal interface to avoid crashes during build when DATABASE_URL is absent
  getCurrentPrice() {
    return 0;
  }

  getActiveDealId() {
    return null;
  }

  getRegimeVolatility() {
    return 0.5;
  }

  getRecentCandles() {
    return [];
  }

  getSelectedSymbol() {
    return 'BTC';
  }

  getSelectedTimeframe() {
    return DEFAULT_GRAPH_TIMEFRAME;
  }

  setChartPreferences(inputMode?: string | null, inputTimeframe?: string | null) {
    void inputMode;
    void inputTimeframe;
    return { symbol: DEFAULT_GRAPH_MODE, timeframe: DEFAULT_GRAPH_TIMEFRAME };
  }

  getControlState(): EngineControlState {
    const fallbackMarket = getMarket('BTC');
    return {
      symbol: DEFAULT_GRAPH_MODE,
      market: {
        id: fallbackMarket.id,
        label: fallbackMarket.label,
        regimeOverride: 'AUTO',
        intensity: 1,
        activeRegime: null,
        trendDirection: 0,
        rules: fallbackMarket.rules,
        ai: fallbackMarket.ai,
      },
      selectedGraphMode: DEFAULT_GRAPH_MODE,
      timeframe: DEFAULT_GRAPH_TIMEFRAME,
      activeDealId: null,
      hasRunningDeal: false,
      metaStatus: { text: 'Engine disabled', stage: 'disabled' },
      ai: {
        signals: [],
        meta: { action: 'NO_TRADE', confidence: 0, reason: 'Engine disabled' },
        hitRates: { meta: 0, agents: {} },
        lastSignalAt: null,
      },
    };
  }

  notifyControlState() {
    return this.getControlState();
  }

  async setMarketAndOverride() {
    return this.getControlState();
  }

  triggerMarketEvent() {
    return null;
  }

  getTradingRules() {
    return { feeBps: 8, minNotionalUsd: 10, maxLeverage: 1 };
  }
}

const shouldRunEngine = runtimeEnv.hasDatabase;
const globalEngine = globalThis as unknown as { dealEngine?: DealEngine | DealEngineDisabled };
export const dealEngine = globalEngine.dealEngine ?? (shouldRunEngine ? new DealEngine() : new DealEngineDisabled());
if (!globalEngine.dealEngine) globalEngine.dealEngine = dealEngine;
