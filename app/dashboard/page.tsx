'use client';

import { useEffect, useMemo, useRef, useState, CSSProperties } from 'react';
import type { IChartApi, ISeriesApi, CandlestickData, HistogramData, LineData, UTCTimestamp } from 'lightweight-charts';
import io from 'socket.io-client';

type Wallet = { cashBalance: number; equity: number; pnlTotal: number };
type Trade = {
  id: string;
  time: string;
  symbol: string;
  side: string;
  price: number;
  sizeUsd: number;
  pnl: number | null;
  fillPrice?: number;
  feeUsd?: number;
  slippageUsd?: number;
  latencyMs?: number;
};
type ModelSignal = { model: string; signal: 'BUY' | 'SELL' | 'OFF'; confidence: number; reasons: string[] };
type Meta = { action: 'BUY' | 'SELL' | 'NO_TRADE'; confidence: number; reason: string };
type ActivityEvent = { id: string; eventType: string; actorRole: string; createdAt: string; metadata: Record<string, unknown> };

export default function DashboardPage() {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ema20Series = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50Series = useRef<ISeriesApi<'Line'> | null>(null);
  const upperBandSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const lowerBandSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const buyInputRef = useRef<HTMLInputElement>(null);

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [signals, setSignals] = useState<ModelSignal[]>([]);
  const [meta, setMeta] = useState<Meta>({ action: 'NO_TRADE', confidence: 0, reason: 'Waiting for data' });
  const [hitRates, setHitRates] = useState<{ meta: number; agents: Record<string, number> }>({ meta: 0, agents: {} });
  const [buyAmount, setBuyAmount] = useState('');
  const [sellPercent, setSellPercent] = useState(100);
  const [warning, setWarning] = useState('');
  const [tooltip, setTooltip] = useState('');

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
    const pingWebsite = () => {
      void fetch('/api/ping', {
        method: 'GET',
        cache: 'no-store',
        keepalive: true,
      }).catch(() => {
        // Keep-alive ping failure should never interrupt dashboard interaction.
      });
    };

    pingWebsite();
    const pingInterval = setInterval(pingWebsite, 8 * 60 * 1000);
    return () => clearInterval(pingInterval);
  }, []);

  useEffect(() => {
    const setup = async () => {
      const { createChart, CandlestickSeries, HistogramSeries, LineSeries } = await import('lightweight-charts');
      if (!chartRef.current) return;

      const chart = createChart(chartRef.current, {
        layout: { background: { color: 'transparent' }, textColor: '#b8c7f0' },
        width: chartRef.current.clientWidth,
        height: 430,
        crosshair: { mode: 1 },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      });
      chartApi.current = chart;
      candleSeries.current = chart.addSeries(CandlestickSeries, { upColor: '#3cff8d', downColor: '#ff5c8d', wickUpColor: '#3cff8d', wickDownColor: '#ff5c8d', borderVisible: false });
      volumeSeries.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
      volumeSeries.current.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      ema20Series.current = chart.addSeries(LineSeries, { color: '#ffd166', lineWidth: 1 });
      ema50Series.current = chart.addSeries(LineSeries, { color: '#6ea8ff', lineWidth: 1 });
      upperBandSeries.current = chart.addSeries(LineSeries, { color: 'rgba(255,92,141,0.45)', lineWidth: 1 });
      lowerBandSeries.current = chart.addSeries(LineSeries, { color: 'rgba(92,255,173,0.45)', lineWidth: 1 });

      chart.subscribeCrosshairMove((param) => {
        const c = param.seriesData.get(candleSeries.current! as never) as unknown as CandlestickData | undefined;
        if (!c) return setTooltip('');
        const pct = ((c.close - c.open) / c.open) * 100;
        setTooltip(`O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)} ${pct.toFixed(2)}%`);
      });

      const socket = io('', { path: '/api/socket' });
      socket.on('price_tick', (payload: { candle: { time: number; open: number; high: number; low: number; close: number; volume: number } }) => {
        const c = payload.candle;
        const item = { time: (c.time / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
        candleSeries.current?.update(item);
        volumeSeries.current?.update({ time: item.time, value: c.volume, color: c.close >= c.open ? 'rgba(60,255,141,0.4)' : 'rgba(255,92,141,0.4)' } as HistogramData);

        const existing = (window as Window & { __candles?: CandlestickData[] }).__candles ?? [];
        const next = [...existing.filter((x) => x.time !== item.time), item].slice(-250);
        (window as Window & { __candles?: CandlestickData[] }).__candles = next;
        const closes = next.map((x) => x.close);
        const ema = (period: number) => closes.map((_, i) => {
          const start = Math.max(0, i - period + 1);
          const arr = closes.slice(start, i + 1);
          return arr.reduce((a, b) => a + b, 0) / arr.length;
        });
        const ema20 = ema(20);
        const ema50 = ema(50);
        ema20Series.current?.setData(next.map((x, i) => ({ time: x.time, value: ema20[i] } as LineData)));
        ema50Series.current?.setData(next.map((x, i) => ({ time: x.time, value: ema50[i] } as LineData)));
        const atr = next.slice(-14).reduce((acc, v) => acc + (v.high - v.low), 0) / Math.max(1, Math.min(next.length, 14));
        upperBandSeries.current?.setData(next.map((x, i) => ({ time: x.time, value: ema20[i] + atr } as LineData)));
        lowerBandSeries.current?.setData(next.map((x, i) => ({ time: x.time, value: ema20[i] - atr } as LineData)));
      });
      socket.on('ai_signals', (payload: { signals: ModelSignal[]; meta: Meta; hitRates: { meta: number; agents: Record<string, number> } }) => {
        setSignals(payload.signals);
        setMeta(payload.meta);
        setHitRates(payload.hitRates);
      });

      return () => {
        socket.disconnect();
        chart.remove();
      };
    };
    setup();
  }, []);

  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'b') buyInputRef.current?.focus();
      if (e.key.toLowerCase() === 's') setSellPercent(100);
      if (e.key === 'Escape') setWarning('');
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

  const tradeTape = useMemo(() => trades.slice(0, 20), [trades]);

  return (
    <div style={styles.page}>
      <div className="glass" style={styles.row}>
        <div>Cash ${wallet?.cashBalance.toFixed(2) ?? '--'}</div>
        <div>Equity ${wallet?.equity.toFixed(2) ?? '--'}</div>
        <div style={{ color: (wallet?.pnlTotal ?? 0) >= 0 ? '#3cff8d' : '#ff5c8d' }}>PnL ${wallet?.pnlTotal.toFixed(2) ?? '--'}</div>
      </div>

      <div className="glass" style={{ padding: 12 }}>
        <div ref={chartRef} style={{ width: '100%', height: 430 }} />
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
          <div style={styles.quickRow}>{[25, 50, 100].map((pct) => <button key={pct} style={styles.quickBtn} onClick={() => setSellPercent(pct)}>{pct}%</button>)}</div>
          <button style={{ ...styles.button, background: '#3cff8d', color: '#07110b' }} onClick={() => act('SELL', { sellPercent })}>Sell {sellPercent}%</button>
        </div>
      </div>

      {warning && <div style={{ color: '#ffb347' }}>{warning}</div>}

      <div style={styles.panels}>
        <div className="glass" style={styles.card}>
          <h3>AI Feed</h3>
          <div>Meta: {meta.action} ({meta.confidence}%) · hit {hitRates.meta}%</div>
          {signals.map((s) => (
            <div key={s.model} style={{ marginTop: 8 }}>
              <strong>{s.model}</strong> {s.signal} ({hitRates.agents[s.model] ?? 0}%)
              <div style={{ color: 'var(--muted)', fontSize: 12 }}>{s.reasons.join(' · ')}</div>
            </div>
          ))}
        </div>

        <div className="glass" style={styles.card}>
          <h3>Trade Tape (20)</h3>
          {tradeTape.map((t) => <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span>{new Date(t.time).toLocaleTimeString()}</span><span>{t.side}</span><span>${t.sizeUsd.toFixed(0)}</span></div>)}
        </div>

        <div className="glass" style={styles.card}>
          <h3>Activity Feed</h3>
          {events.slice(0, 20).map((e) => <div key={e.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6, fontSize: 12 }}><strong>{e.eventType}</strong> · {e.actorRole}<div style={{ color: 'var(--muted)' }}>{new Date(e.createdAt).toLocaleString()}</div></div>)}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: { maxWidth: 1200, margin: '0 auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: 10 },
  row: { display: 'flex', gap: 16, padding: 12 },
  tradeGrid: { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' },
  panels: { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' },
  card: { padding: 12 },
  input: { width: '100%', padding: '0.6rem', border: '1px solid var(--border)', borderRadius: 8, background: '#0f172b', color: 'var(--text)' },
  quickRow: { display: 'flex', gap: 6, marginTop: 6, marginBottom: 8 },
  quickBtn: { border: '1px solid var(--border)', borderRadius: 8, padding: '6px 9px', background: 'transparent', color: 'var(--text)' },
  button: { width: '100%', border: 'none', borderRadius: 10, padding: '0.8rem', fontWeight: 700, color: '#fff' },
};
