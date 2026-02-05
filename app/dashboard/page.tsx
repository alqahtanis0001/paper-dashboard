'use client';

import { useEffect, useRef, useState, CSSProperties } from 'react';
import type { ISeriesApi, CandlestickData, UTCTimestamp } from 'lightweight-charts';
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
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [hasChartData, setHasChartData] = useState(false);
  const [scanTicker, setScanTicker] = useState('BTC/USDT · Solana · AVAX');
  const [buyAmount, setBuyAmount] = useState('');
  const [sellPercent, setSellPercent] = useState(100);

  const pushPrice = (payload: { candle: { time: number; open: number; high: number; low: number; close: number } }) => {
    if (!candleSeries.current) return;
    const c = payload.candle;
    const candle: CandlestickData = {
      time: (c.time / 1000) as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    };
    candleSeries.current.update(candle);
    setHasChartData(true);
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
    const guard = async () => {
      let socket: ReturnType<typeof io> | null = null;
      // use loose typing to avoid build-time API surface mismatches
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let chart: any = null;
      let resizeHandler: (() => void) | null = null;
      try {
        await fetchWallet();
        const { createChart } = await import('lightweight-charts');
        if (chartRef.current) {
          // use any to avoid type mismatch in certain builds
          chart = createChart(chartRef.current, {
            layout: { background: { color: 'transparent' }, textColor: '#b8c7f0' },
            grid: { vertLines: { color: '#0f1629' }, horzLines: { color: '#0f1629' } },
            width: chartRef.current.clientWidth,
            height: 360,
            timeScale: { borderColor: '#1f2a44' },
            rightPriceScale: { borderColor: '#1f2a44' },
          });
          const candle = (chart as any).addCandlestickSeries?.({
            upColor: '#3cff8d',
            downColor: '#ff5c8d',
            borderVisible: false,
            wickUpColor: '#3cff8d',
            wickDownColor: '#ff5c8d',
          });
          candleSeries.current = candle;
          resizeHandler = () => (chart as any)?.applyOptions?.({ width: chartRef.current?.clientWidth ?? 360 });
          window.addEventListener('resize', resizeHandler);
        }

        socket = io('', { path: '/api/socket' });
        socket.on('connect', () => setMetaStatus('Scanning markets...'));
        socket.on('meta_status', (p) => setMetaStatus(p.text));
        socket.on('market_selected', (p) => setSelectedMarket({ symbol: p.symbol, chainName: p.chainName }));
        socket.on('price_tick', (payload) => pushPrice(payload));
        socket.on('ai_signals', (payload) => {
          setSignals(payload.signals);
          setMeta(payload.meta);
        });
        socket.on('deal_state', (p) => setDealState(p.status));
        return () => {
          socket?.disconnect();
          if (resizeHandler) window.removeEventListener('resize', resizeHandler);
          chart?.remove?.();
        };
      } catch (err) {
        console.error('Fatal dashboard error', err);
        setFatalError(err instanceof Error ? err.message : 'Unknown error');
      }
      return undefined;
    };
    guard();
  }, []);

  // playful scanning text animation while waiting
  useEffect(() => {
    const tickers = [
      'Scanning BTC/USDT on Solana',
      'Scanning ETH/USDT on Arbitrum',
      'Scanning AVAX/USDT on C-Chain',
      'Scanning OP/USDT on Optimism',
      'Scanning MATIC/USDT on Polygon',
    ];
    let i = 0;
    const id = setInterval(() => {
      setScanTicker(tickers[i % tickers.length]);
      i += 1;
    }, 900);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (wallet && buyAmount === '') {
      setBuyAmount((wallet.cashBalance * 0.25).toFixed(2));
    }
  }, [wallet, buyAmount]);

  const act = async (side: 'BUY' | 'SELL', payload?: Record<string, unknown>) => {
    const aiNote = meta.action !== side && meta.action !== 'WAIT' ? `AI consensus prefers ${meta.action}. Proceeded with your ${side}.` : '';
    const endpoint = side === 'BUY' ? '/api/trade/buy' : '/api/trade/sell';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (res.ok) {
      if (aiNote) setWarning(aiNote);
      else setWarning('');
      fetchWallet();
      return true;
    }
    const body = await res.json().catch(() => ({}));
    setWarning(body.error ?? 'Trade failed');
    return false;
  };

  const applyBuyPercent = (pct: number) => {
    if (!wallet) return;
    const amount = wallet.cashBalance * pct;
    setBuyAmount(amount.toFixed(2));
  };

  const handleBuy = async () => {
    setWarning('');
    const amt = Number(buyAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setWarning('Enter a valid buy amount');
      return;
    }
    if (wallet && amt > wallet.cashBalance) {
      setWarning('Amount exceeds cash balance');
      return;
    }
    await act('BUY', { amountUsd: amt });
  };

  const handleSell = async (pct?: number) => {
    const targetPct = pct ?? sellPercent;
    setSellPercent(targetPct);
    setWarning('');
    if (!Number.isFinite(targetPct) || targetPct <= 0 || targetPct > 100) {
      setWarning('Choose a percent between 0 and 100');
      return;
    }
    await act('SELL', { sellPercent: targetPct });
  };

  return (
    <div style={styles.page}>
      {fatalError && (
        <div className="glass" style={{ padding: '0.8rem', border: '1px solid #ff5c8d', color: '#ff5c8d' }}>
          Client error: {fatalError}
        </div>
      )}
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
            <div style={{ fontSize: 16, fontWeight: 700 }}>{hasChartData ? metaStatus : scanTicker}</div>
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
        <div style={{ position: 'relative', width: '100%', height: 360 }}>
          <div ref={chartRef} style={{ width: '100%', height: '100%', pointerEvents: 'none' }} />
          {!hasChartData && (
            <div style={styles.scanOverlay}>
              <div style={styles.scanGlow} />
              <div style={styles.scanBars}>
                <div className="bar" />
                <div className="bar" />
                <div className="bar" />
                <div className="bar" />
              </div>
              <div style={{ marginTop: 8, color: '#7ea4ff', fontSize: 12 }}>{scanTicker}</div>
            </div>
          )}
        </div>
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
        <div style={styles.tradeColumns}>
          <div className="glass" style={styles.tradeCard}>
            <div style={styles.tradeCardHeader}>
              <div style={{ fontWeight: 700 }}>Buy</div>
              <div style={styles.tradeHint}>Cash ${wallet?.cashBalance?.toFixed(2) ?? '--'}</div>
            </div>
            <div style={styles.inputRow}>
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="Amount USD"
                value={buyAmount}
                onChange={(e) => setBuyAmount(e.target.value)}
                style={styles.input}
              />
              <button style={{ ...styles.tradeBtn, background: '#ff5c8d', minWidth: 120 }} onClick={handleBuy}>
                Deploy
              </button>
            </div>
            <div style={styles.quickRow}>
              {[0.25, 0.5, 1].map((pct) => (
                <button key={pct} style={styles.quickBtn} onClick={() => applyBuyPercent(pct)}>
                  {pct * 100}% of cash
                </button>
              ))}
            </div>
          </div>
          <div className="glass" style={styles.tradeCard}>
            <div style={styles.tradeCardHeader}>
              <div style={{ fontWeight: 700 }}>Sell</div>
              <div style={styles.tradeHint}>Open size ${position?.sizeUsd?.toFixed(0) ?? '--'}</div>
            </div>
            <div style={styles.quickRow}>
              {[25, 50, 100].map((pct) => (
                <button
                  key={pct}
                  style={{
                    ...styles.quickBtn,
                    borderColor: sellPercent === pct ? '#3cff8d' : 'var(--border)',
                    background: sellPercent === pct ? '#1b253a' : 'transparent',
                  }}
                  onClick={() => setSellPercent(pct)}
                >
                  {pct}%
                </button>
              ))}
            </div>
            <button style={{ ...styles.tradeBtn, background: '#3cff8d', color: '#041013', width: '100%' }} onClick={() => handleSell()}>
              Sell {sellPercent}%
            </button>
          </div>
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
  metaCardRow: { display: 'flex', alignItems: 'stretch', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  metaCard: { padding: '1rem 1.2rem', minWidth: 200 },
  tradeColumns: { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', flex: 1 },
  tradeCard: { padding: '0.9rem', display: 'flex', flexDirection: 'column', gap: 10 },
  tradeCardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  tradeHint: { color: 'var(--muted)', fontSize: 12 },
  inputRow: { display: 'flex', gap: 10, alignItems: 'center' },
  input: {
    flex: 1,
    padding: '0.65rem 0.75rem',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: '#0f172b',
    color: 'var(--text)',
  },
  quickRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  quickBtn: {
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text)',
    borderRadius: 10,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
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
  scanOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, rgba(37,59,110,0.4), rgba(12,18,36,0.6))',
    borderRadius: 8,
    pointerEvents: 'none',
  },
  scanGlow: {
    width: '80%',
    height: 2,
    background: 'linear-gradient(90deg, transparent, #5df3a6, transparent)',
    animation: 'sweep 1.6s infinite',
  },
  scanBars: {
    width: '70%',
    display: 'grid',
    gridTemplateColumns: 'repeat(4,1fr)',
    gap: 10,
    marginTop: 14,
  },
};

// inject keyframes once on client
if (typeof document !== 'undefined') {
  const id = 'scan-anim';
  if (!document.getElementById(id)) {
    const style = document.createElement('style');
    style.id = id;
    style.innerHTML = `
      @keyframes sweep { 
        0% { transform: translateX(-30%); opacity: 0.2; }
        50% { transform: translateX(30%); opacity: 0.9; }
        100% { transform: translateX(80%); opacity: 0.2; }
      }
      .bar {
        height: 8px;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(93,243,166,0.8), rgba(93,179,243,0.5));
        animation: pulse 1.4s infinite ease-in-out;
      }
      .bar:nth-child(2) { animation-delay: 0.1s; }
      .bar:nth-child(3) { animation-delay: 0.2s; }
      .bar:nth-child(4) { animation-delay: 0.3s; }
      @keyframes pulse { 
        0% { transform: scaleX(0.6); opacity: 0.5; }
        50% { transform: scaleX(1); opacity: 1; }
        100% { transform: scaleX(0.7); opacity: 0.5; }
      }
    `;
    document.head.appendChild(style);
  }
}
