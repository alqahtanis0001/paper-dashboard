'use client';

import { useCallback, useEffect, useMemo, useRef, useState, CSSProperties } from 'react';
import type {
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  LineData,
  Time,
  UTCTimestamp,
  ISeriesMarkersPluginApi,
  SeriesMarker,
} from 'lightweight-charts';
import io, { type Socket } from 'socket.io-client';
import {
  GRAPH_MODES,
  GRAPH_TIMEFRAMES,
  type GraphMode,
  type GraphTimeframe,
  normalizeGraphMode,
  normalizeGraphTimeframe,
} from '@/lib/engine/graphModes';

type Wallet = { cashBalance: number; equity: number; liveEquity?: number; positionValue?: number; unrealizedPnl?: number; pnlTotal: number };
type Trade = {
  id: string;
  time: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  sizeUsd: number;
  pnl: number | null;
  fillPrice?: number;
  feeUsd?: number;
  slippageUsd?: number;
  latencyMs?: number;
};
type SignalState = 'BUY' | 'SELL' | 'NO_TRADE';
type RawSignalState = SignalState | 'OFF';
type ModelSignal = { model: string; signal: RawSignalState; confidence: number; reasons: string[] };
type NormalizedModelSignal = Omit<ModelSignal, 'signal'> & { signal: SignalState };
type Meta = { action: 'BUY' | 'SELL' | 'NO_TRADE'; confidence: number; reason: string };
type ActivityEvent = { id: string; eventType: string; actorRole: string; createdAt: string; metadata: Record<string, unknown> };

type ChartPreference = {
  selectedSymbol?: string | null;
  timeframe?: string | null;
  zoomLogical?: number | null;
  collapsedJson?: Record<string, boolean> | null;
};

type ChartBootstrapResponse = {
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  symbol: string;
  timeframe?: string;
};

const BAND_MULTIPLIER = 1.85;

const formatPrice = (value: number) => {
  const abs = Math.abs(value);
  if (!Number.isFinite(value)) return '--';
  if (abs >= 10000) return value.toFixed(2);
  if (abs >= 1000) return value.toFixed(3);
  if (abs >= 1) return value.toFixed(4);
  if (abs >= 0.01) return value.toFixed(5);
  return value.toFixed(7);
};

const formatVolumeCompact = (value: number) => {
  if (!Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(2);
};

const computeEma = (values: number[], period: number) => {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  let prev = values[0];
  return values.map((value, index) => {
    if (index === 0) {
      prev = value;
      return value;
    }
    prev = prev + alpha * (value - prev);
    return prev;
  });
};

const computeAtr = (candles: CandlestickData<Time>[], period: number) => {
  if (!candles.length) return [];
  const trValues = candles.map((candle, index) => {
    const prevClose = index === 0 ? candle.close : candles[index - 1].close;
    const hl = candle.high - candle.low;
    const hc = Math.abs(candle.high - prevClose);
    const lc = Math.abs(candle.low - prevClose);
    return Math.max(hl, hc, lc);
  });

  const alpha = 1 / Math.max(period, 1);
  let prevAtr = trValues[0];
  return trValues.map((value, index) => {
    if (index === 0) {
      prevAtr = value;
      return value;
    }
    prevAtr = prevAtr + alpha * (value - prevAtr);
    return prevAtr;
  });
};

const nearestCandleTime = (candles: CandlestickData<Time>[], tsSec: number) => {
  if (!candles.length) return tsSec as UTCTimestamp;
  let nearest = candles[0].time as number;
  let best = Math.abs((candles[0].time as number) - tsSec);
  for (const c of candles) {
    const time = c.time as number;
    const distance = Math.abs(time - tsSec);
    if (distance < best) {
      best = distance;
      nearest = time;
    }
  }
  return nearest as UTCTimestamp;
};

const normalizeSignalState = (signal: RawSignalState): SignalState => (signal === 'OFF' ? 'NO_TRADE' : signal);

const signalLightClassName = (signal: SignalState) => {
  if (signal === 'BUY') return 'status-light status-light-buy';
  if (signal === 'SELL') return 'status-light status-light-sell';
  return 'status-light status-light-neutral';
};

export default function DashboardPage() {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ema20Series = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50Series = useRef<ISeriesApi<'Line'> | null>(null);
  const upperBandSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const lowerBandSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const buyInputRef = useRef<HTMLInputElement>(null);
  const sellInputRef = useRef<HTMLInputElement>(null);
  const candlesRef = useRef<CandlestickData<Time>[]>([]);
  const volumesRef = useRef<Map<number, number>>(new Map());
  const zoomLogicalRef = useRef<number | undefined>(undefined);

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [signals, setSignals] = useState<ModelSignal[]>([]);
  const [meta, setMeta] = useState<Meta>({ action: 'NO_TRADE', confidence: 0, reason: 'Waiting for data' });
  const [hitRates, setHitRates] = useState<{ meta: number; agents: Record<string, number> }>({ meta: 0, agents: {} });
  const [lastAiUpdate, setLastAiUpdate] = useState('');
  const [buyAmount, setBuyAmount] = useState('');
  const [sellPercent, setSellPercent] = useState(100);
  const [warning, setWarning] = useState('');
  const [tooltip, setTooltip] = useState('');
  const [selectedSymbol, setSelectedSymbol] = useState<GraphMode>('AUTO');
  const [timeframe, setTimeframe] = useState<GraphTimeframe>('1s');
  const [zoomLogical, setZoomLogical] = useState<number | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ ai: false, tape: false, activity: false });
  const [prefHydrated, setPrefHydrated] = useState(false);
  const [chartReady, setChartReady] = useState(false);

  const fetchWallet = async () => {
    const res = await fetch('/api/wallet');
    if (res.ok) {
      const data = await res.json();
      setWallet(data.wallet);
      setTrades(data.trades);
    } else if (res.status === 401) {
      window.location.href = '/login';
    }
  };

  const fetchActivity = async () => {
    const res = await fetch('/api/activity');
    if (res.ok) {
      const data = await res.json();
      setEvents(data.events);
    }
  };

  const applyDerivedIndicators = useCallback((nextCandles: CandlestickData<Time>[]) => {
    const closes = nextCandles.map((candle) => candle.close);
    const ema20 = computeEma(closes, 20);
    const ema50 = computeEma(closes, 50);
    const atr14 = computeAtr(nextCandles, 14);
    ema20Series.current?.setData(nextCandles.map((candle, index) => ({ time: candle.time, value: ema20[index] } as LineData)));
    ema50Series.current?.setData(nextCandles.map((candle, index) => ({ time: candle.time, value: ema50[index] } as LineData)));

    upperBandSeries.current?.setData(
      nextCandles.map((candle, index) => ({ time: candle.time, value: ema20[index] + atr14[index] * BAND_MULTIPLIER } as LineData)),
    );
    lowerBandSeries.current?.setData(
      nextCandles.map((candle, index) => ({ time: candle.time, value: Math.max(0.0000001, ema20[index] - atr14[index] * BAND_MULTIPLIER) } as LineData)),
    );
  }, []);

  const applyBootstrapData = useCallback((bootstrap: ChartBootstrapResponse | null, fitContent: boolean) => {
    if (!bootstrap) return;

    const nextSymbol = normalizeGraphMode(bootstrap.symbol);
    const nextTimeframe = normalizeGraphTimeframe(bootstrap.timeframe);
    setSelectedSymbol((prev) => (prev === nextSymbol ? prev : nextSymbol));
    setTimeframe((prev) => (prev === nextTimeframe ? prev : nextTimeframe));

    const seedCandles = bootstrap.candles.map((candle) => ({
      time: (candle.time / 1000) as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));

    candlesRef.current = seedCandles;
    volumesRef.current = new Map(bootstrap.candles.map((candle) => [Math.floor(candle.time / 1000), candle.volume]));
    candleSeries.current?.setData(seedCandles);
    volumeSeries.current?.setData(
      bootstrap.candles.map((candle) => ({
        time: (candle.time / 1000) as UTCTimestamp,
        value: candle.volume,
        color: candle.close >= candle.open ? 'rgba(60,255,141,0.4)' : 'rgba(255,92,141,0.4)',
      } as HistogramData)),
    );

    if (seedCandles.length === 0) {
      ema20Series.current?.setData([]);
      ema50Series.current?.setData([]);
      upperBandSeries.current?.setData([]);
      lowerBandSeries.current?.setData([]);
      return;
    }

    applyDerivedIndicators(seedCandles);
    if (fitContent) {
      chartApi.current?.timeScale().fitContent();
    }
  }, [applyDerivedIndicators]);

  useEffect(() => {
    fetchWallet();
    fetchActivity();
    const interval = setInterval(() => {
      fetchWallet();
      fetchActivity();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    void fetch('/api/chart-state')
      .then(async (res) => (res.ok ? res.json() : null))
      .then((data: { preference?: ChartPreference } | null) => {
        const pref = data?.preference;
        if (!pref) return;
        if (pref.selectedSymbol) setSelectedSymbol(normalizeGraphMode(pref.selectedSymbol));
        if (pref.timeframe) setTimeframe(normalizeGraphTimeframe(pref.timeframe));
        if (typeof pref.zoomLogical === 'number') setZoomLogical(pref.zoomLogical);
        if (pref.collapsedJson) setCollapsed({ ai: false, tape: false, activity: false, ...pref.collapsedJson });
      })
      .catch(() => null)
      .finally(() => setPrefHydrated(true));
  }, []);

  useEffect(() => {
    if (!prefHydrated) return;
    const timer = setTimeout(() => {
      void fetch('/api/chart-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSymbol, timeframe, zoomLogical, collapsed }),
      }).catch(() => null);
    }, 350);
    return () => clearTimeout(timer);
  }, [selectedSymbol, timeframe, zoomLogical, collapsed, prefHydrated]);

  useEffect(() => {
    const pingWebsite = () => {
      void fetch('/api/ping', {
        method: 'GET',
        cache: 'no-store',
        keepalive: true,
      }).catch(() => null);
    };

    pingWebsite();
    const pingInterval = setInterval(pingWebsite, 8 * 60 * 1000);
    return () => clearInterval(pingInterval);
  }, []);

  useEffect(() => {
    zoomLogicalRef.current = zoomLogical;
  }, [zoomLogical]);

  useEffect(() => {
    let isDisposed = false;
    let socket: Socket | null = null;
    let chart: IChartApi | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let onResize: (() => void) | null = null;

    const setup = async () => {
      const { createChart, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers } = await import('lightweight-charts');
      const mount = chartRef.current;
      if (!mount || isDisposed) return;

      chart = createChart(mount, {
        layout: { background: { color: 'transparent' }, textColor: '#b8c7f0', attributionLogo: false },
        width: mount.clientWidth,
        height: mount.clientHeight || 430,
        grid: {
          vertLines: { color: 'rgba(120,140,180,0.13)' },
          horzLines: { color: 'rgba(120,140,180,0.13)' },
        },
        rightPriceScale: {
          borderColor: 'rgba(184,199,240,0.28)',
          scaleMargins: { top: 0.08, bottom: 0.12 },
        },
        timeScale: {
          borderColor: 'rgba(184,199,240,0.28)',
          rightOffset: 2,
          barSpacing: 9,
          minBarSpacing: 3,
          timeVisible: true,
          secondsVisible: true,
        },
        crosshair: {
          mode: 1,
          vertLine: { labelBackgroundColor: '#1b3c6d' },
          horzLine: { labelBackgroundColor: '#1b3c6d' },
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      });
      chartApi.current = chart;
      candleSeries.current = chart.addSeries(CandlestickSeries, {
        upColor: '#3cff8d',
        downColor: '#ff5c8d',
        wickUpColor: '#3cff8d',
        wickDownColor: '#ff5c8d',
        borderVisible: false,
        priceLineVisible: true,
        lastValueVisible: true,
      });
      markersApi.current = createSeriesMarkers(candleSeries.current, []);
      volumeSeries.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
      volumeSeries.current.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      ema20Series.current = chart.addSeries(LineSeries, { color: '#ffd166', lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
      ema50Series.current = chart.addSeries(LineSeries, { color: '#6ea8ff', lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
      upperBandSeries.current = chart.addSeries(LineSeries, {
        color: 'rgba(255,92,141,0.55)',
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      lowerBandSeries.current = chart.addSeries(LineSeries, {
        color: 'rgba(92,255,173,0.55)',
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      });

      onResize = () => {
        if (!chart || !mount) return;
        chart.applyOptions({ width: mount.clientWidth, height: mount.clientHeight || 430 });
      };
      onResize();
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => onResize?.());
        resizeObserver.observe(mount);
      }
      window.addEventListener('resize', onResize);

      chart.subscribeCrosshairMove((param) => {
        const c = param.seriesData.get(candleSeries.current! as never) as unknown as CandlestickData | undefined;
        if (!c) return setTooltip('');
        const volume = volumesRef.current.get(Number(c.time));
        const absChange = c.close - c.open;
        const pct = ((c.close - c.open) / c.open) * 100;
        setTooltip(
          `O:${formatPrice(c.open)} H:${formatPrice(c.high)} L:${formatPrice(c.low)} C:${formatPrice(c.close)} ` +
          `Δ:${absChange >= 0 ? '+' : ''}${formatPrice(absChange)} (${pct.toFixed(2)}%) ` +
          `V:${formatVolumeCompact(volume ?? Number.NaN)}`,
        );
      });

      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (!range) return;
        setZoomLogical(range.to);
      });

      if (typeof zoomLogicalRef.current === 'number') {
        chart.timeScale().setVisibleLogicalRange({ from: zoomLogicalRef.current - 120, to: zoomLogicalRef.current });
      }

      const bootstrap = await fetch('/api/chart', { cache: 'no-store' })
        .then(async (res) => (res.ok ? (res.json() as Promise<ChartBootstrapResponse>) : null))
        .catch(() => null);
      if (isDisposed) return;
      applyBootstrapData(bootstrap, true);
      setChartReady(true);

      await fetch('/api/socket').catch(() => null);
      if (isDisposed) return;

      socket = io('', { path: '/api/socket' });
      socket.on('market_selected', (payload: { symbol?: string; timeframe?: string }) => {
        if (payload.symbol) setSelectedSymbol(normalizeGraphMode(payload.symbol));
        if (payload.timeframe) setTimeframe(normalizeGraphTimeframe(payload.timeframe));
      });
      socket.on('price_tick', (payload: { candle: { time: number; open: number; high: number; low: number; close: number; volume: number } }) => {
        const c = payload.candle;
        const item = { time: (c.time / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
        candleSeries.current?.update(item);
        volumeSeries.current?.update({ time: item.time, value: c.volume, color: c.close >= c.open ? 'rgba(60,255,141,0.4)' : 'rgba(255,92,141,0.4)' } as HistogramData);

        const next = [...candlesRef.current.filter((x) => x.time !== item.time), item].slice(-250);
        candlesRef.current = next;
        const nextVolumes = new Map(volumesRef.current);
        nextVolumes.set(Number(item.time), c.volume);
        const keepTimes = new Set(next.map((candle) => Number(candle.time)));
        for (const time of nextVolumes.keys()) {
          if (!keepTimes.has(time)) nextVolumes.delete(time);
        }
        volumesRef.current = nextVolumes;
        applyDerivedIndicators(next);
      });
      socket.on('ai_signals', (payload: { signals: ModelSignal[]; meta: Meta; hitRates: { meta: number; agents: Record<string, number> } }) => {
        setSignals(payload.signals);
        setMeta(payload.meta);
        setHitRates(payload.hitRates);
        setLastAiUpdate(new Date().toLocaleTimeString());
      });
    };
    void setup();

    return () => {
      isDisposed = true;
      socket?.disconnect();
      resizeObserver?.disconnect();
      if (onResize) window.removeEventListener('resize', onResize);
      markersApi.current = null;
      candleSeries.current = null;
      volumeSeries.current = null;
      ema20Series.current = null;
      ema50Series.current = null;
      upperBandSeries.current = null;
      lowerBandSeries.current = null;
      chartApi.current = null;
      volumesRef.current = new Map();
      chart?.remove();
      setChartReady(false);
    };
  }, [applyBootstrapData, applyDerivedIndicators]);

  useEffect(() => {
    if (!chartReady || !prefHydrated) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ selectedSymbol, timeframe });
      void fetch(`/api/chart?${params.toString()}`, { cache: 'no-store', signal: controller.signal })
        .then(async (res) => (res.ok ? (res.json() as Promise<ChartBootstrapResponse>) : null))
        .then((bootstrap) => applyBootstrapData(bootstrap, false))
        .catch(() => null);
    }, 180);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [selectedSymbol, timeframe, chartReady, prefHydrated, applyBootstrapData]);

  useEffect(() => {
    if (!chartApi.current || typeof zoomLogical !== 'number') return;
    chartApi.current.timeScale().setVisibleLogicalRange({ from: zoomLogical - 120, to: zoomLogical });
  }, [zoomLogical]);

  useEffect(() => {
    if (!candleSeries.current) return;
    const markers: SeriesMarker<Time>[] = trades.slice(0, 30).map((t) => {
      const eventSec = Math.floor(new Date(t.time).getTime() / 1000);
      const candleTime = nearestCandleTime(candlesRef.current, eventSec);
      return {
        time: candleTime,
        position: t.side === 'BUY' ? 'belowBar' : 'aboveBar',
        color: t.side === 'BUY' ? '#3cff8d' : '#ff5c8d',
        shape: t.side === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: `${t.side} $${t.sizeUsd.toFixed(2)} @ ${(t.fillPrice ?? t.price).toFixed(2)} · fee ${(t.feeUsd ?? 0).toFixed(2)} · slip ${(t.slippageUsd ?? 0).toFixed(2)} · ${(t.latencyMs ?? 0)}ms · ${new Date(t.time).toLocaleTimeString()}`,
      };
    });
    markersApi.current?.setMarkers(markers);
  }, [trades]);

  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'b') buyInputRef.current?.focus();
      if (e.key.toLowerCase() === 's') sellInputRef.current?.focus();
      if (e.key === 'Escape') {
        setWarning('');
        setTooltip('');
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
    };
    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  }, []);

  useEffect(() => {
    if (wallet && !buyAmount) setBuyAmount((wallet.cashBalance * 0.25).toFixed(2));
  }, [wallet, buyAmount]);

  const act = async (side: 'BUY' | 'SELL', payload: Record<string, unknown>) => {
    const endpoint = side === 'BUY' ? '/api/trade/buy' : '/api/trade/sell';
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setWarning(body.error ?? 'Trade failed');
      return;
    }
    if (meta.action !== side && meta.action !== 'NO_TRADE') setWarning(`Meta-AI disagrees: ${meta.reason}`);
    else setWarning('');
    fetchWallet();
    fetchActivity();
  };

  const normalizedSignals = useMemo<NormalizedModelSignal[]>(
    () =>
      signals.map((signal) => ({
        ...signal,
        signal: normalizeSignalState(signal.signal),
      })),
    [signals],
  );

  const committeeSummary = useMemo(() => {
    const buy = normalizedSignals.filter((signal) => signal.signal === 'BUY').length;
    const sell = normalizedSignals.filter((signal) => signal.signal === 'SELL').length;
    const noTrade = normalizedSignals.filter((signal) => signal.signal === 'NO_TRADE').length;
    const hasConflict = buy > 0 && sell > 0;
    const hasStrongConsensus = buy >= 4 || sell >= 4;
    const confidenceGatePass = meta.confidence > 70;
    const decisionAligned = meta.action === 'BUY' ? buy >= 4 : meta.action === 'SELL' ? sell >= 4 : true;

    return {
      buy,
      sell,
      noTrade,
      hasConflict,
      hasStrongConsensus,
      confidenceGatePass,
      decisionAligned,
    };
  }, [normalizedSignals, meta.action, meta.confidence]);

  const tradeTape = useMemo(() => trades.slice(0, 20), [trades]);

  return (
    <div style={styles.page}>
      <div className="glass" style={styles.row}>
        <div>Cash ${wallet?.cashBalance.toFixed(2) ?? '--'}</div>
        <div>Equity ${(wallet?.liveEquity ?? wallet?.equity ?? 0).toFixed(2)}</div>
        <div>Position ${(wallet?.positionValue ?? 0).toFixed(2)}</div>
        <div style={{ color: (wallet?.pnlTotal ?? 0) >= 0 ? '#3cff8d' : '#ff5c8d' }}>PnL ${wallet?.pnlTotal.toFixed(2) ?? '--'}</div>
      </div>

      <div className="glass" style={styles.chartShell}>
        <div style={styles.controls}>
          <select value={selectedSymbol} onChange={(e) => setSelectedSymbol(normalizeGraphMode(e.target.value))} style={styles.input}>
            {GRAPH_MODES.map((symbol) => (
              <option key={symbol} value={symbol}>{symbol}</option>
            ))}
          </select>
          <select value={timeframe} onChange={(e) => setTimeframe(normalizeGraphTimeframe(e.target.value))} style={styles.input}>
            {GRAPH_TIMEFRAMES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>
        <div style={styles.legendRow}>
          <span style={{ ...styles.legendItem, color: '#ffd166' }}>EMA 20</span>
          <span style={{ ...styles.legendItem, color: '#6ea8ff' }}>EMA 50</span>
          <span style={{ ...styles.legendItem, color: 'rgba(255,92,141,0.85)' }}>Upper Band</span>
          <span style={{ ...styles.legendItem, color: 'rgba(92,255,173,0.85)' }}>Lower Band</span>
        </div>
        <div style={styles.chartViewport}>
          <div ref={chartRef} style={styles.chartCanvas} />
        </div>
        <div style={{ color: 'var(--muted)', marginTop: 6 }}>{tooltip || meta.reason}</div>
      </div>

      <div style={styles.tradeGrid}>
        <div className="glass" style={styles.card}>
          <h3>Buy (B)</h3>
          <input ref={buyInputRef} value={buyAmount} onChange={(e) => setBuyAmount(e.target.value)} type="number" style={styles.input} />
          <div style={styles.quickRow}>{[0.25, 0.5, 1].map((pct) => <button key={pct} style={styles.quickBtn} onClick={() => setBuyAmount(((wallet?.cashBalance ?? 0) * pct).toFixed(2))}>{pct * 100}%</button>)}</div>
          <button style={{ ...styles.button, background: '#ff5c8d' }} onClick={() => act('BUY', { amountUsd: Number(buyAmount) })}>Deploy</button>
        </div>
        <div className="glass" style={styles.card}>
          <h3>Sell (S)</h3>
          <input ref={sellInputRef} type="number" value={sellPercent} min={1} max={100} onChange={(e) => setSellPercent(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} style={styles.input} />
          <div style={styles.quickRow}>{[25, 50, 100].map((pct) => <button key={pct} style={styles.quickBtn} onClick={() => setSellPercent(pct)}>{pct}%</button>)}</div>
          <button style={{ ...styles.button, background: '#3cff8d', color: '#07110b' }} onClick={() => act('SELL', { sellPercent })}>Sell {sellPercent}%</button>
        </div>
      </div>

      {warning && <div style={{ color: '#ffb347' }}>{warning}</div>}

      <div style={styles.panels}>
        <div className="glass" style={styles.card}>
          <button style={styles.toggle} onClick={() => setCollapsed((v) => ({ ...v, ai: !v.ai }))}><h3>AI Feed</h3></button>
          {!collapsed.ai && <>
            <div style={styles.signalRow}>
              <span className={signalLightClassName(meta.action)} />
              <strong>Meta</strong>
              <span>{meta.action}</span>
              <span style={styles.signalStats}>({meta.confidence}% · hit {hitRates.meta}%)</span>
            </div>
            <div style={styles.summaryRow}>
              <span style={styles.voteChipBuy}>BUY {committeeSummary.buy}</span>
              <span style={styles.voteChipSell}>SELL {committeeSummary.sell}</span>
              <span style={styles.voteChipNeutral}>NO TRADE {committeeSummary.noTrade}</span>
            </div>
            <div style={styles.summaryRow}>
              <span style={committeeSummary.hasStrongConsensus ? styles.statusChipPass : styles.statusChipWarn}>
                Consensus {committeeSummary.hasStrongConsensus ? 'STRONG' : 'WEAK'}
              </span>
              <span style={committeeSummary.confidenceGatePass ? styles.statusChipPass : styles.statusChipWarn}>
                Confidence Gate {committeeSummary.confidenceGatePass ? 'PASS' : 'FAIL'}
              </span>
              <span style={committeeSummary.hasConflict ? styles.statusChipWarn : styles.statusChipInfo}>
                {committeeSummary.hasConflict ? 'Conflict Detected' : 'No Conflict'}
              </span>
              <span style={committeeSummary.decisionAligned ? styles.statusChipInfo : styles.statusChipWarn}>
                {committeeSummary.decisionAligned ? 'Decision Aligned' : 'Decision Caution'}
              </span>
              <span style={styles.signalStats}>Updated {lastAiUpdate || '--'}</span>
            </div>
            <div style={styles.signalReason}>{meta.reason}</div>
            {normalizedSignals.map((s) => (
              <div key={s.model} style={{ marginTop: 8 }}>
                <div style={styles.signalRow}>
                  <span className={signalLightClassName(s.signal)} />
                  <strong>{s.model}</strong>
                  <span>{s.signal}</span>
                  <span style={styles.signalStats}>({s.confidence}% · hit {hitRates.agents[s.model] ?? 0}%)</span>
                </div>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>{s.reasons.join(' · ')}</div>
              </div>
            ))}
          </>}
        </div>

        <div className="glass" style={styles.card}>
          <button style={styles.toggle} onClick={() => setCollapsed((v) => ({ ...v, tape: !v.tape }))}><h3>Trade Tape (20)</h3></button>
          {!collapsed.tape && tradeTape.map((t) => <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span>{new Date(t.time).toLocaleTimeString()}</span><span>{t.side}</span><span>${t.sizeUsd.toFixed(0)}</span></div>)}
        </div>

        <div className="glass" style={styles.card}>
          <button style={styles.toggle} onClick={() => setCollapsed((v) => ({ ...v, activity: !v.activity }))}><h3>Activity Feed</h3></button>
          {!collapsed.activity && events.slice(0, 20).map((e) => <div key={e.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6, fontSize: 12 }}><strong>{e.eventType}</strong> · {e.actorRole}<div style={{ color: 'var(--muted)' }}>{new Date(e.createdAt).toLocaleString()}</div></div>)}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: { maxWidth: 1200, margin: '0 auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: 10 },
  row: { display: 'flex', gap: 16, padding: 12 },
  chartShell: {
    padding: 12,
    position: 'relative',
    overflow: 'hidden',
    isolation: 'isolate',
  },
  controls: { display: 'flex', gap: 10, marginBottom: 8 },
  legendRow: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' },
  legendItem: {
    fontSize: 11,
    border: '1px solid var(--border)',
    borderRadius: 999,
    padding: '3px 8px',
    background: 'rgba(15,23,43,0.8)',
    letterSpacing: 0.3,
  },
  chartViewport: {
    width: '100%',
    height: 430,
    border: '1px solid var(--border)',
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
    isolation: 'isolate',
    contain: 'layout paint',
    background: 'rgba(6,10,22,0.78)',
    zIndex: 0,
  },
  chartCanvas: { width: '100%', height: '100%', position: 'relative', overflow: 'hidden', display: 'block', zIndex: 0 },
  tradeGrid: { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', position: 'relative', zIndex: 1 },
  panels: { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', position: 'relative', zIndex: 1 },
  card: { padding: 12 },
  input: { width: '100%', padding: '0.6rem', border: '1px solid var(--border)', borderRadius: 8, background: '#0f172b', color: 'var(--text)' },
  quickRow: { display: 'flex', gap: 6, marginTop: 6, marginBottom: 8 },
  quickBtn: { border: '1px solid var(--border)', borderRadius: 8, padding: '6px 9px', background: 'transparent', color: 'var(--text)' },
  button: { width: '100%', border: 'none', borderRadius: 10, padding: '0.8rem', fontWeight: 700, color: '#fff' },
  toggle: { width: '100%', textAlign: 'left', border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer' },
  signalRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
  signalStats: { color: 'var(--muted)', fontSize: 12 },
  summaryRow: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 },
  voteChipBuy: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#3cff8d',
    border: '1px solid rgba(60,255,141,0.35)',
    background: 'rgba(60,255,141,0.12)',
  },
  voteChipSell: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#ff5c8d',
    border: '1px solid rgba(255,92,141,0.35)',
    background: 'rgba(255,92,141,0.12)',
  },
  voteChipNeutral: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#ffd166',
    border: '1px solid rgba(255,209,102,0.35)',
    background: 'rgba(255,209,102,0.12)',
  },
  statusChipPass: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#3cff8d',
    border: '1px solid rgba(60,255,141,0.3)',
    background: 'rgba(60,255,141,0.08)',
  },
  statusChipWarn: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#ffb347',
    border: '1px solid rgba(255,179,71,0.35)',
    background: 'rgba(255,179,71,0.1)',
  },
  statusChipInfo: {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    color: '#9cb7ff',
    border: '1px solid rgba(156,183,255,0.3)',
    background: 'rgba(156,183,255,0.1)',
  },
  signalReason: { color: 'var(--muted)', fontSize: 12, marginTop: 4 },
};
