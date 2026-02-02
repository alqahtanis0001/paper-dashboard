'use client';

import { useEffect, useRef, useState, CSSProperties } from 'react';
import { createChart, ISeriesApi, CandlestickData } from 'lightweight-charts';
import io from 'socket.io-client';

type Wallet = { cashBalance: number; equity: number; pnlTotal: number };
type Position = { isOpen: boolean; entryPrice: number; sizeUsd: number; symbol: string } | null;
type Trade = { id: string; time: string; symbol: string; side: string; price: number; sizeUsd: number; pnl: number | null };
type ModelSignal = { model: string; signal: 'BUY' | 'SELL' | 'OFF'; confidence: number };
type Meta = { action: 'BUY' | 'SELL' | 'WAIT'; confidence: number };

const lightColor = {
  BUY: '#ff5c8d', // red light required for BUY
  SELL: '#3cff8d',
  OFF: '#4b5568',
};

export default function DashboardPage() {
  const chartRef = useRef<HTMLDivElement>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [position, setPosition] = useState<Position>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [signals, setSignals] = useState<ModelSignal[]>([
    { model: 'Trend', signal: 'OFF', confidence: 0 },
    { model: 'Momentum', signal: 'OFF', confidence: 0 },
    { model: 'Volatility', signal: 'OFF', confidence: 0 },
    { model: 'Volume', signal: 'OFF', confidence: 0 },
    { model: 'Pattern', signal: 'OFF', confidence: 0 },
  ]);
  const [meta, setMeta] = useState<Meta>({ action: 'WAIT', confidence: 0 });
  const [metaStatus, setMetaStatus] = useState('Scanning markets…');
  const [selectedMarket, setSelectedMarket] = useState<{ symbol: string; chainName: string } | null>(null);
  const [dealState, setDealState] = useState('WAITING');
  const [warning, setWarning] = useState('');

  const pushPrice = (payload: { candle: { time: number; open: number; high: number; low: number; close: number } }) => {
    if (!candleSeries.current) return;
    const c = payload.candle;
    const candle: CandlestickData = { time: c.time / 1000, open: c.open, high: c.high, low: c.low, close: c.close };
    candleSeries.current.update(candle);
  };

  const setupChart = () => {
    if (!chartRef.current) return;
    const chart = createChart(chartRef.current, {
      layout: { background: { color: 'transparent' }, textColor: '#b8c7f0' },
      grid: { vertLines: { color: '#0f1629' }, horzLines: { color: '#0f1629' } },
      width: chartRef.current.clientWidth,
      height: 360,
      timeScale: { borderColor: '#1f2a44' },
      rightPriceScale: { borderColor: '#1f2a44' },
    });
    const candle = chart.addCandlestickSeries({
      upColor: '#3cff8d',
      downColor: '#ff5c8d',
      borderVisible: false,
      wickUpColor: '#3cff8d',
      wickDownColor: '#ff5c8d',
    });
    candleSeries.current = candle;
    const handleResize = () => chart.applyOptions({ width: chartRef.current?.clientWidth ?? 360 });
    window.addEventListener('resize', handleResize);
  };

  const fetchWallet = async () => {
    const res = await fetch('/api/wallet');
    if (res.ok) {
      const data = await res.json();
      setWallet(data.wallet);
      setPosition(data.openPosition);
      setTrades(data.trades);
    } else if (res.status === 401) {
      window.location.href = '/login';
    }
  };

  useEffect(() => {
    const load = async () => {
      await fetchWallet();
    };
    load();
    setupChart();
    const socket = io('', { path: '/api/socket' });
    socket.on('connect', () => setMetaStatus('Scanning markets…'));
    socket.on('meta_status', (p) => setMetaStatus(p.text));
    socket.on('market_selected', (p) => setSelectedMarket({ symbol: p.symbol, chainName: p.chainName }));
    socket.on('price_tick', (payload) => pushPrice(payload));
    socket.on('ai_signals', (payload) => {
      setSignals(payload.signals);
      setMeta(payload.meta);
    });
    socket.on('deal_state', (p) => setDealState(p.status));
    return () => {
      socket.disconnect();
    };
  }, []);

  const act = async (side: 'BUY' | 'SELL') => {
    setWarning('');
    if (meta.action !== side && meta.action !== 'WAIT') {
      setWarning(`AI consensus prefers ${meta.action}. Proceeded with your ${side}.`);
    }
    const endpoint = side === 'BUY' ? '/api/trade/buy' : '/api/trade/sell';
    const res = await fetch(endpoint, { method: 'POST' });
    if (res.ok) {
      fetchWallet();
    } else {
      const body = await res.json().catch(() => ({}));
      setWarning(body.error ?? 'Trade failed');
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.walletRow}>
        <div className="glass" style={styles.walletCard}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <div style={styles.label}>Wallet Balance</div>
              <div style={styles.value}>${wallet?.cashBalance?.toFixed(2) ?? '--'}</div>
            </div>
            <div>
              <div style={styles.label}>Equity</div>
              <div style={styles.value}>${wallet?.equity?.toFixed(2) ?? '--'}</div>
            </div>
            <div>
              <div style={styles.label}>PnL</div>
              <div style={{ ...styles.value, color: (wallet?.pnlTotal ?? 0) >= 0 ? '#3cff8d' : '#ff5c8d' }}>
                ${wallet?.pnlTotal?.toFixed(2) ?? '--'}
              </div>
            </div>
          </div>
        </div>
        <button
          onClick={async () =>
            await fetch('/api/withdraw', {
              method: 'POST',
              body: JSON.stringify({ amount: 1000 }),
              headers: { 'Content-Type': 'application/json' },
            })
          }
          className="glass"
          style={styles.withdraw}
        >
          Request Withdraw
        </button>
      </div>

      <div className="glass" style={styles.chartCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <div>
            <div style={styles.label}>Meta-AI</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{metaStatus}</div>
            {selectedMarket && (
              <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                {selectedMarket.symbol} • {selectedMarket.chainName} • Deal {dealState}
              </div>
            )}
            {position && (
              <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                Open: {position.symbol} @ ${position.entryPrice?.toFixed(2)} size ${position.sizeUsd?.toFixed(0)}
              </div>
            )}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={styles.label}>Meta Decision</div>
            <div style={{ fontWeight: 700 }}>
              {meta.action} ({meta.confidence}%)
            </div>
          </div>
        </div>
        <div ref={chartRef} style={{ width: '100%', height: 360 }} />
      </div>

      <div style={styles.aiRow}>
        {signals.map((s) => (
          <div key={s.model} className="glass" style={styles.aiCard}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{s.model}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: lightColor[s.signal],
                  boxShadow: `0 0 12px ${lightColor[s.signal]}`,
                }}
              />
              <span>{s.signal}</span>
            </div>
          </div>
        ))}
      </div>

      <div style={styles.metaCardRow}>
        <div className="glass" style={styles.metaCard}>
          <div style={{ fontSize: 14, color: 'var(--muted)' }}>Meta-AI</div>
          <div style={{ fontSize: 28, fontWeight: 800 }}>{meta.action}</div>
          <div style={{ color: 'var(--muted)' }}>{meta.confidence}% agreement</div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button style={{ ...styles.tradeBtn, background: '#ff5c8d' }} onClick={() => act('BUY')}>
            BUY
          </button>
          <button style={{ ...styles.tradeBtn, background: '#3cff8d', color: '#041013' }} onClick={() => act('SELL')}>
            SELL
          </button>
        </div>
      </div>
      {warning && <div style={{ color: '#ffb347', marginTop: -6 }}>{warning}</div>}

      <div className="glass" style={{ padding: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3>Trade Log</h3>
          <button onClick={fetchWallet} style={{ ...styles.buttonGhost, padding: '6px 10px' }}>
            Refresh
          </button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
              <th>Time</th>
              <th>Side</th>
              <th>Price</th>
              <th>Size</th>
              <th>PnL</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '8px 0' }}>{new Date(t.time).toLocaleTimeString()}</td>
                <td>{t.side}</td>
                <td>${t.price.toFixed(2)}</td>
                <td>${t.sizeUsd.toFixed(0)}</td>
                <td style={{ color: t.pnl && t.pnl >= 0 ? '#3cff8d' : '#ff5c8d' }}>{t.pnl?.toFixed(2) ?? '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    maxWidth: 960,
    margin: '0 auto',
    padding: '1.5rem 1.2rem 3rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.9rem',
  },
  walletRow: { display: 'flex', alignItems: 'center', gap: 12 },
  walletCard: { flex: 1, padding: '1rem 1.2rem' },
  label: { color: 'var(--muted)', fontSize: 12 },
  value: { fontSize: 20, fontWeight: 800 },
  withdraw: { padding: '0.8rem 1rem', border: '1px solid var(--border)', borderRadius: 12, color: '#ffb347', background: '#151a2b' },
  chartCard: { padding: '1rem', width: '100%' },
  aiRow: { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' },
  aiCard: { padding: '0.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  metaCardRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  metaCard: { padding: '1rem 1.2rem', minWidth: 200 },
  tradeBtn: {
    padding: '0.9rem 1.4rem',
    border: 'none',
    borderRadius: 12,
    fontWeight: 800,
    cursor: 'pointer',
    color: '#0a0c12',
    minWidth: 120,
  },
  buttonGhost: {
    border: '1px solid var(--border)',
    background: '#0f172b',
    color: 'var(--text)',
    borderRadius: 10,
    cursor: 'pointer',
  },
};
