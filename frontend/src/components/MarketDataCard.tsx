// frontend/src/components/MarketDataCard.tsx
// Phase M (Market unification): a SINGLE card that replaces the three separate
// post-submit panels (quote / history / options). Tabs:
//   - Chart   : D3 candlestick + volume (TradingView-ish), interval 1D/5m/1m
//   - Quote   : company name + market stats
//   - History : OHLCV summary + recent bars table
//   - Options : option chain (calls/puts, ATM highlighted)
// Each tab lazily fetches its own data (same endpoints the old panels used), so
// the card is a drop-in for the three removed rows in AnalysisView.

import { useEffect, useRef, useState } from 'react';
import PriceChart, { type ChartBar, type StudyId } from './PriceChart';
import { getQuote, type QuoteResult } from '../api/quoteClient';
import { getPriceHistory, type PriceBarsResult, type PriceBar } from '../api/historyClient';
import { getOptionChain, type OptionChainResult, type OptionQuote } from '../api/optionsHistoryClient';
import { getNews, type NewsResult, sentimentClass } from '../api/newsClient';
import { type AgencyId, isIntradayAgency, DEFAULT_AGENCY } from './analysts/agencies';
import { useWatchlist } from '../lib/watchlist';

export interface MarketDataCardProps {
  symbol: string;
  /** Selected agency — drives the default chart interval (1D for long-term, 5M for intraday). */
  agencyId?: AgencyId;
  /** Technical analyst verdict for THIS symbol (drives support/resistance annotations). */
  technical?: { support_resistance?: { support_levels: number[]; resistance_levels: number[] } } | null;
  /** Sentiment analyst verdict for THIS symbol (drives the scored read in the News tab). */
  sentiment?: any | null;
  /** Phase 7: when provided, render a watchlist star and call this on toggle.
   *  When omitted, the card uses the shared watchlist store so the star still works. */
  watched?: boolean;
  onToggleWatch?: (symbol: string) => void;
}

type Tab = 'chart' | 'quote' | 'history' | 'options';
// Intervals offered in the Chart tab. `1wk` (1W) and `1h` (1H) are Yahoo-native
// granularities. `4h` (4H) has NO Yahoo equivalent, so we fetch `1h` bars and
// resample them to 4-hour candles client-side (see resampleTo4h).
type Interval = '1d' | '5m' | '1m' | '1wk' | '1h' | '4h';

// UI label + the interval actually requested from the backend (4h → 1h fetch).
// Button order requested: [1W] [1D] [4H] [1H] [5M] [1M].
const INTERVALS: { id: Interval; label: string; fetch: '1d' | '5m' | '1m' | '1wk' | '1h'; lookback: number }[] = [
  { id: '1wk', label: '1W', fetch: '1wk', lookback: 730 },
  { id: '1d', label: '1D', fetch: '1d', lookback: 400 },
  { id: '4h', label: '4H', fetch: '1h', lookback: 30 },
  { id: '1h', label: '1H', fetch: '1h', lookback: 30 },
  { id: '5m', label: '5M', fetch: '5m', lookback: 5 },
  { id: '1m', label: '1M', fetch: '1m', lookback: 1 },
];

const TABS: { id: Tab; label: string }[] = [
  { id: 'chart', label: 'Chart' },
  { id: 'quote', label: 'Quote' },
  { id: 'history', label: 'History' },
  { id: 'options', label: 'Options' },
  { id: 'news', label: 'News' },
];

function fmt(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtVol(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function fmtIv(iv: number | undefined | null): string {
  if (iv === undefined || iv === null || !Number.isFinite(iv)) return '—';
  return `${(iv * 100).toFixed(1)}%`;
}
function fmtPct(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}%`;
}
function fmtBig(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return String(n);
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace('T', ' ');
}

export function MarketDataCard({ symbol, agencyId = DEFAULT_AGENCY, technical, sentiment, watched, onToggleWatch }: MarketDataCardProps) {
  const [tab, setTab] = useState<Tab>('chart');
  const sym = symbol.trim().toUpperCase();

  // Phase 7: prefer an explicit watched/onToggle pair (controlled by the host,
  // e.g. the watchlist dashboard), otherwise fall back to the shared store so
  // the star works even when the card is rendered standalone.
  const store = useWatchlist();
  const isWatched = watched ?? store.isWatched(sym);
  const toggleWatch = onToggleWatch ?? store.toggle;

  // Quote
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  // History (chart + history tab)
  const [hist, setHist] = useState<PriceBarsResult | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);
  // Default chart interval depends on the agency: intraday agencies open on 5M,
  // long/medium-term + swing agencies on 1D.
  const [interval, setInterval] = useState<Interval>(isIntradayAgency(agencyId) ? '5m' : '1d');
  // Options
  const [opt, setOpt] = useState<OptionChainResult | null>(null);
  const [optErr, setOptErr] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<string>('');
  // Options table layout: 'all' = CALLS + PUTS, 'calls' = calls only, 'puts' = puts only.
  const [optSide, setOptSide] = useState<'all' | 'calls' | 'puts'>('all');
  // Two independent toggles: toggling CALLS off when both are on -> 'puts';
  // toggling it back on -> 'all'. Same for PUTS. At least one always stays on.
  const toggleSide = (cur: 'all' | 'calls' | 'puts', which: 'calls' | 'puts'): 'all' | 'calls' | 'puts' => {
    if (which === 'calls') {
      if (cur === 'all' || cur === 'calls') return 'puts'; // turn calls off
      return 'all'; // currently puts-only -> both on
    }
    // which === 'puts'
    if (cur === 'all' || cur === 'puts') return 'calls'; // turn puts off
    return 'all'; // currently calls-only -> both on
  };
  // Refs for the synced horizontal scroll of the two option panes (WeBull-style:
  // strike pinned in the center, both call/put panes scroll together).
  const callScrollRef = useRef<HTMLDivElement | null>(null);
  const putScrollRef = useRef<HTMLDivElement | null>(null);
  const strikeScrollRef = useRef<HTMLDivElement | null>(null);
  const optSyncRef = useRef(false);
  const optVSyncRef = useRef(false);
  // News / sentiment (Phase 4)
  const [news, setNews] = useState<NewsResult | null>(null);
  const [newsErr, setNewsErr] = useState<string | null>(null);
  // Chart studies toggle (analysis-grade overlays).
  const [studies, setStudies] = useState<Partial<Record<StudyId, boolean>>>({ sma: true, bb: true, rsi: true });

  // Quote fetch (only when Quote tab active, but cheap — fetch on mount).
  useEffect(() => {
    if (!sym) return;
    let cancelled = false;
    setQuoteErr(null);
    getQuote(sym)
      .then((q) => !cancelled && setQuote(q))
      .catch((e: Error) => !cancelled && setQuoteErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [sym]);

  // History/quote fetch driven by tab + interval (chart needs it).
  // `4h` has no Yahoo source, so we request `1h` and resample to 4h below.
  const fetchInterval = INTERVALS.find((i) => i.id === interval)?.fetch ?? '1d';
  const fetchLookback = INTERVALS.find((i) => i.id === interval)?.lookback ?? 180;
  useEffect(() => {
    if (!sym) return;
    let cancelled = false;
    setHistErr(null);
    getPriceHistory(sym, { interval: fetchInterval, lookbackDays: fetchLookback })
      .then((d) => !cancelled && setHist(d))
      .catch((e: Error) => !cancelled && setHistErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [sym, fetchInterval, fetchLookback]);

  // Options fetch (lazy — only when Options tab opened).
  useEffect(() => {
    if (tab !== 'options' || !sym) return;
    let cancelled = false;
    setOptErr(null);
    getOptionChain(sym)
      .then((d) => {
        if (cancelled) return;
        setOpt(d);
        setExpiry((prev) => (prev && d.expiries.includes(prev) ? prev : d.expiries[0] ?? ''));
      })
      .catch((e: Error) => !cancelled && setOptErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [tab, sym]);

  // News / sentiment fetch (lazy — only when News tab opened).
  useEffect(() => {
    if (tab !== 'news' || !sym) return;
    let cancelled = false;
    setNewsErr(null);
    getNews(sym)
      .then((d) => !cancelled && setNews(d))
      .catch((e: Error) => !cancelled && setNewsErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [tab, sym]);

  // Park the greeks next to the center strike whenever the options chain,
  // expiry, or visible side changes: CALL scrolled fully right, PUT at 0.
  // (Counter-scroll on manual scroll keeps the greek columns aligned.)
  useEffect(() => {
    if (!opt) return;
    const call = callScrollRef.current;
    const put = putScrollRef.current;
    if (call && put) {
      const callMax = call.scrollWidth - call.clientWidth;
      call.scrollLeft = callMax;
      put.scrollLeft = 0;
    }
  }, [opt, expiry, optSide]);

  if (!sym) return null;

  // Resample 1h bars into 4h candles (Yahoo has no native 4h). Groups of 4
  // consecutive 1h bars → one 4h bar (open=first, close=last, high/low=extremes,
  // volume=sum). The last partial group (<4 bars) is dropped to keep alignment
  // clean; timestamps stay ISO so PriceChart's tooltip keeps working.
  function resampleTo4h(bars: PriceBar[]): PriceBar[] {
    const out: PriceBar[] = [];
    for (let i = 0; i + 4 <= bars.length; i += 4) {
      const g = bars.slice(i, i + 4);
      out.push({
        t: g[0]!.t,
        open: g[0]!.open,
        high: Math.max(...g.map((b) => b.high)),
        low: Math.min(...g.map((b) => b.low)),
        close: g[3]!.close,
        volume: g.reduce((s, b) => s + b.volume, 0),
      });
    }
    return out;
  }

  const rawBars: PriceBar[] = hist?.bars ?? [];
  const displayBars: PriceBar[] = interval === '4h' ? resampleTo4h(rawBars) : rawBars;
  const chartBars: ChartBar[] = displayBars.map((b) => ({
    t: b.t,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));

  const optRows = (() => {
    if (!opt || !expiry) return [] as OptionQuote[];
    return opt.quotes
      .filter((q) => q.expiry === expiry)
      .sort((a, b) => a.strike - b.strike);
  })();

  return (
    <section className="market-card" data-testid={`market-card-${sym}`} aria-label={`${sym} market data`}>
      <header className="market-card-head">
        <h3 className="market-card-symbol">{sym}</h3>
        {quote?.name && <span className="market-card-name">{quote.name}</span>}
        <button
          type="button"
          className={`watch-star ${isWatched ? 'on' : ''}`}
          aria-pressed={isWatched}
          aria-label={isWatched ? `Remove ${sym} from watchlist` : `Add ${sym} to watchlist`}
          title={isWatched ? 'In watchlist — click to remove' : 'Add to watchlist'}
          onClick={() => toggleWatch(sym)}
          data-testid={`watch-star-${sym}`}
        >
          {isWatched ? '★' : '☆'}
        </button>
      </header>

      <nav className="market-tabs" role="tablist" data-testid="market-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`market-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
            data-testid={`market-tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="market-tab-body" data-testid="market-tab-body">
        {tab === 'chart' && (
          <div className="market-chart-pane">
            {/* Interval + study toggles live in ONE wrapping flex row
                (.chart-toolbar) so at wide widths (e.g. 1200px) all 11
                buttons sit on a single line instead of stacking into two. */}
            <div className="chart-toolbar">
              <div className="market-interval" data-testid="market-interval">
                {INTERVALS.map((iv) => (
                  <button
                    key={iv.id}
                    className={`interval-btn ${interval === iv.id ? 'active' : ''}`}
                    onClick={() => setInterval(iv.id)}
                    data-testid={`interval-${iv.id}`}
                  >
                    {iv.label}
                  </button>
                ))}
              </div>
              {!histErr && chartBars.length > 0 && (
                <div className="chart-studies" data-testid="chart-studies">
                  {(['sma', 'ema', 'bb', 'vwap', 'rsi'] as StudyId[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`study-btn study-${s} ${studies[s] ? 'active' : ''}`}
                      aria-pressed={!!studies[s]}
                      onClick={() => setStudies((prev) => ({ ...prev, [s]: !prev[s] }))}
                      data-testid={`study-${s}`}
                    >
                      {s.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {histErr && <p className="quote-error" role="alert" data-testid="chart-error">{histErr}</p>}
            {!histErr && chartBars.length > 0 ? (
              <PriceChart
                bars={chartBars}
                height={340}
                ariaLabel={`${sym} price chart`}
                supportResistance={technical?.support_resistance ?? null}
                studies={studies}
                showTime={interval === '5m' || interval === '1m' || interval === '1h' || interval === '4h'}
              />
            ) : (
              !histErr && <p className="history-loading" data-testid="chart-loading">Loading {sym} chart…</p>
            )}
          </div>
        )}

        {tab === 'quote' && (
          <div className="market-quote-pane" data-testid="market-quote-pane">
            {quoteErr && <p className="quote-error" role="alert" data-testid="quote-error">{quoteErr}</p>}
            {!quoteErr && quote && (
              quote.note ? (
                <p className="quote-unavailable" data-testid="quote-unavailable">
                  Market data unavailable ({quote.note}).
                </p>
              ) : (
                <>
                  {/* Session + as-of line */}
                  <div className="quote-session" data-testid="quote-session">
                    {quote.marketState && (
                      <span className={`quote-state quote-state-${quote.marketState.toLowerCase()}`}>
                        {quote.marketState === 'REGULAR' ? 'Market Open' : quote.marketState === 'CLOSED' ? 'Market Closed' : quote.marketState}
                      </span>
                    )}
                    {quote.exchange && <span className="quote-exchange">{quote.exchange}</span>}
                    {quote.marketTime != null && (
                      <span className="quote-asof">
                        as of {new Date(quote.marketTime * 1000).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}
                        {quote.timezoneOffsetMin != null ? ` (UTC${quote.timezoneOffsetMin >= 0 ? '+' : ''}${quote.timezoneOffsetMin / 60})` : ''}
                      </span>
                    )}
                    {quote.delaySec != null && quote.delaySec > 0 && (
                      <span className="quote-delay">delayed {quote.delaySec}s</span>
                    )}
                  </div>

                  {/* Price + change banner */}
                  <div className="quote-banner" data-testid="quote-banner">
                    <span className="quote-banner-price">{fmt(quote.price)}</span>
                    {quote.change != null && quote.changePct != null && (
                      <span className={`quote-banner-change ${quote.change >= 0 ? 'pos' : 'neg'}`}>
                        {quote.change >= 0 ? '▲' : '▼'} {fmt(Math.abs(quote.change))} ({quote.change >= 0 ? '+' : '−'}{fmtPct(Math.abs(quote.changePct))})
                      </span>
                    )}
                    {quote.currency && <span className="quote-banner-cur">{quote.currency}</span>}
                  </div>

                  <div className="quote-stats" data-testid="quote-stats">
                    <div className="quote-stat"><span className="quote-stat-label">Open</span><span className="quote-stat-value">{fmt(quote.open)}</span></div>
                    <div className="quote-stat"><span className="quote-stat-label">Prev close</span><span className="quote-stat-value">{fmt(quote.previousClose)}</span></div>
                    <div className="quote-stat"><span className="quote-stat-label">Day range</span><span className="quote-stat-value">{fmt(quote.dayLow)} – {fmt(quote.dayHigh)}</span></div>
                    <div className="quote-stat"><span className="quote-stat-label">52-wk range</span><span className="quote-stat-value">{fmt(quote.week52Low)} – {fmt(quote.week52High)}</span></div>
                    <div className="quote-stat"><span className="quote-stat-label">1-yr change</span><span className={`quote-stat-value ${quote.yearChangePct != null ? (quote.yearChangePct >= 0 ? 'pos' : 'neg') : ''}`}>{quote.yearChangePct != null ? `${quote.yearChangePct >= 0 ? '+' : '−'}${fmtPct(Math.abs(quote.yearChangePct!))}` : '—'}</span></div>
                    <div className="quote-stat"><span className="quote-stat-label">Volume</span><span className="quote-stat-value">{fmtVol(quote.volume)}</span></div>
                    <div className="quote-stat"><span className="quote-stat-label">Avg vol (3mo)</span><span className="quote-stat-value">{fmtVol(quote.avgVolume3m)}</span></div>
                    {quote.avgVolume3m != null && quote.volume != null && quote.avgVolume3m > 0 && (
                      <div className="quote-stat" data-testid="quote-volratio">
                        <span className="quote-stat-label">Vs 3mo avg</span>
                        <span className={`quote-stat-value ${quote.volume >= quote.avgVolume3m ? 'pos' : 'neg'}`}>
                          {fmtPct((quote.volume / quote.avgVolume3m) * 100)}
                        </span>
                      </div>
                    )}
                    {quote.currency && <div className="quote-stat"><span className="quote-stat-label">Currency</span><span className="quote-stat-value">{quote.currency}</span></div>}
                  </div>

                  {/* Fundamentals (best-effort; fields omitted when null) */}
                  {(quote.marketCap != null || quote.sharesOut != null || quote.floatShares != null || quote.dividendYield != null || quote.peTTM != null || quote.epsTTM != null || quote.priceToSales != null || quote.priceToBook != null || quote.earningsDate != null) && (
                    <div className="quote-fundamentals" data-testid="quote-fundamentals">
                      <div className="quote-fund-head">Fundamentals</div>
                      <div className="quote-stats">
                        {quote.marketCap != null && <div className="quote-stat"><span className="quote-stat-label">Market cap</span><span className="quote-stat-value">{fmtBig(quote.marketCap)}</span></div>}
                        {quote.sharesOut != null && <div className="quote-stat"><span className="quote-stat-label">Shares out</span><span className="quote-stat-value">{fmtBig(quote.sharesOut)}</span></div>}
                        {quote.floatShares != null && <div className="quote-stat"><span className="quote-stat-label">Shares float</span><span className="quote-stat-value">{fmtBig(quote.floatShares)}</span></div>}
                        {quote.avgVolume10d != null && <div className="quote-stat"><span className="quote-stat-label">Avg vol (10d)</span><span className="quote-stat-value">{fmtVol(quote.avgVolume10d)}</span></div>}
                        {quote.dividendYield != null && <div className="quote-stat"><span className="quote-stat-label">Div yield</span><span className="quote-stat-value">{fmtPct(quote.dividendYield)}</span></div>}
                        {quote.peTTM != null && <div className="quote-stat"><span className="quote-stat-label">P/E (TTM)</span><span className="quote-stat-value">{fmt(quote.peTTM)}</span></div>}
                        {quote.epsTTM != null && <div className="quote-stat"><span className="quote-stat-label">EPS (TTM)</span><span className="quote-stat-value">{fmt(quote.epsTTM)}</span></div>}
                        {quote.priceToSales != null && <div className="quote-stat"><span className="quote-stat-label">Price/Sales</span><span className="quote-stat-value">{fmt(quote.priceToSales)}</span></div>}
                        {quote.priceToBook != null && <div className="quote-stat"><span className="quote-stat-label">Price/Book</span><span className="quote-stat-value">{fmt(quote.priceToBook)}</span></div>}
                        {quote.earningsDate != null && <div className="quote-stat"><span className="quote-stat-label">Next earnings</span><span className="quote-stat-value">{quote.earningsDate}</span></div>}
                      </div>
                    </div>
                  )}
                </>
              )
            )}
          </div>
        )}

        {tab === 'history' && (
          <div className="market-history-pane" data-testid="market-history-pane">
            {histErr && <p className="quote-error" role="alert" data-testid="history-error">{histErr}</p>}
            {!histErr && hist && (() => {
              const bars = hist.bars;
              const first = bars[0];
              const last = bars[bars.length - 1];
              const hi = bars.length ? Math.max(...bars.map((b) => b.high)) : null;
              const lo = bars.length ? Math.min(...bars.map((b) => b.low)) : null;
              const avgVol = bars.length ? Math.round(bars.reduce((s, b) => s + (b.volume || 0), 0) / bars.length) : null;
              const recent = bars.slice(-8).reverse();
              return (
                <>
                  <div className="history-summary" data-testid="history-summary">
                    <div className="quote-stat"><span className="quote-stat-label">First</span><span className="quote-stat-value">{fmt(first?.close)}</span></div>
                    <div className="quote-stat"><span className="quote-stat-label">Last</span><span className="quote-stat-value">{fmt(last?.close)}</span></div>
                    <div className="quote-stat"><span className="quote-stat-label">Period Hi</span><span className="quote-stat-value">{fmt(hi)}</span></div>
                    <div className="quote-stat"><span className="quote-stat-label">Period Lo</span><span className="quote-stat-value">{fmt(lo)}</span></div>
                    <div className="quote-stat"><span className="quote-stat-label">Avg Vol</span><span className="quote-stat-value">{fmt(avgVol)}</span></div>
                  </div>
                  <table className="history-table">
                    <thead><tr><th>Date</th><th>O</th><th>H</th><th>L</th><th>C</th><th>Vol</th></tr></thead>
                    <tbody>
                      {recent.map((b) => (
                        <tr key={b.t}>
                          <td>{fmtDate(b.t)}</td>
                          <td>{fmt(b.open)}</td>
                          <td>{fmt(b.high)}</td>
                          <td>{fmt(b.low)}</td>
                          <td>{fmt(b.close)}</td>
                          <td>{fmt(b.volume)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              );
            })()}
          </div>
        )}

        {tab === 'options' && (
          <div className="market-options-pane" data-testid="market-options-pane">
            {optErr && <p className="quote-error" role="alert" data-testid="options-error">{optErr}</p>}
            {!optErr && opt && (
              <>
                <header className="history-head" data-testid="history-head">
                  {/* [CALLS][PUTS] toggle pinned to the FAR LEFT of the header row. */}
                  <div className="options-toolbar" data-testid="options-toolbar">
                    <div className="options-side-toggle" data-testid="options-side-toggle" role="group" aria-label="Show calls or puts">
                      <button type="button" aria-pressed={optSide === 'all' || optSide === 'calls'} className={optSide === 'all' || optSide === 'calls' ? 'active' : ''} onClick={() => setOptSide((s) => toggleSide(s, 'calls'))} data-testid="side-calls">CALLS</button>
                      <button type="button" aria-pressed={optSide === 'all' || optSide === 'puts'} className={optSide === 'all' || optSide === 'puts' ? 'active' : ''} onClick={() => setOptSide((s) => toggleSide(s, 'puts'))} data-testid="side-puts">PUTS</button>
                    </div>
                  </div>
                  {/* Meta cluster (spot / source / delay + expiry selector) pushed to
                      the FAR RIGHT of the same row. */}
                  <div className="history-meta-cluster" data-testid="history-meta-cluster">
                    <span className="history-meta">options · spot {fmt(opt.underlying_price)}</span>
                    <span
                      className={`history-src history-src-${opt.source}`}
                      data-testid="options-source"
                      title={opt.note ?? (opt.source === 'polygon' ? 'Live option chain from Polygon' : opt.source === 'cboe' ? 'Real (delayed) options chain from CBOE delayed feed' : opt.source === 'yahoo' ? 'Real (delayed) options chain from Yahoo' : 'No live feed — showing a deterministic mock chain')}
                    >
                      {opt.source === 'polygon' ? 'LIVE' : opt.source === 'cboe' ? 'DELAYED' : opt.source === 'yahoo' ? 'DELAYED' : 'MOCK'}
                    </span>
                    <span className="history-delay" data-testid="options-delay" title={opt.note ?? 'No live feed configured'}>
                      {opt.source === 'polygon'
                        ? 'near real-time · Polygon'
                        : opt.source === 'cboe'
                          ? 'delayed ~15-20m · CBOE (real bid/ask)'
                          : opt.source === 'yahoo'
                            ? 'delayed ~15-20m · Yahoo (real)'
                            : 'simulated · no live feed'}
                    </span>
                    {opt.expiries.length > 1 && (
                      <div className="options-expiries" data-testid="options-expiries">
                        <label htmlFor="opt-exp">Expiry: </label>
                        <select id="opt-exp" value={expiry} onChange={(e) => setExpiry(e.target.value)} data-testid="options-expiry-select">
                          {opt.expiries.map((exp) => (<option key={exp} value={exp}>{exp}</option>))}
                        </select>
                      </div>
                    )}
                  </div>
                </header>
                {/* SEMANTIC HONESTY: when a Massive/Polygon key WAS configured but
                    the live option-chain call was rejected (e.g. 401 = plan doesn't
                    entitle the options endpoint), say so VISIBLY. The badge above
                    still reads MOCK (we genuinely have no live chain), but this line
                    tells the truth: the key is fine, the endpoint isn't covered — so
                    the user doesn't think the key/code is broken. */}
                {opt.source === 'mock' && opt.note && /a Massive\/Polygon key was configured but the live option-chain call failed/i.test(opt.note) && (
                  <p className="quote-warn" role="alert" data-testid="options-live-failed" style={{ margin: '8px 0' }}>
                    {opt.note}
                  </p>
                )}
                {/* Unified options table (WeBull-style): greeks merged per row,
                    two independent CALLS / PUTS toggles (at least one on), strike
                    header shown once (top, between the panes), the two panes scroll
                    horizontally in sync, ITM/OTM row tinting. */}
                {(() => {
                  const greekMap = new Map<string, any>();
                  for (const g of opt.greeks ?? []) {
                    if (g.expiry === expiry) greekMap.set(`${g.type}-${g.strike}`, g);
                  }
                  const strikes = Array.from(new Set(optRows.map((q) => q.strike))).sort((a, b) => a - b);
                  const minDist = Math.min(...optRows.map((r) => Math.abs(r.strike - opt.underlying_price)));
                  const showCall = optSide === 'all' || optSide === 'calls';
                  const showPut = optSide === 'all' || optSide === 'puts';
                  // Column models. Same 8 fields for both sides. Header `label`
                  // shows the Greek symbol + a short english abbrev so the dense
                  // columns stay narrow but readable (hover `title` for the full
                  // name). ν is per 1 vol-pt (ν/100), Θ per day (Θ/365).
                  const colDefs = [
                    { key: 'd',  label: 'Δlt',  full: 'Delta (Δ) — directional exposure', get: (_q: OptionQuote, g: any) => (g ? g.delta.toFixed(3) : '—') },
                    { key: 'g',  label: 'Gma',  full: 'Gamma (Γ) — rate of change of Delta', get: (_q: OptionQuote, g: any) => (g ? g.gamma.toFixed(5) : '—') },
                    { key: 'v',  label: 'Veg',  full: 'Vega (ν) — per 1 vol-pt, shown as ν/100', get: (_q: OptionQuote, g: any) => (g ? (g.vega / 100).toFixed(4) : '—') },
                    { key: 'th', label: 'Tht',  full: 'Theta (Θ) — per day, shown as Θ/365', get: (_q: OptionQuote, g: any) => (g ? (g.theta / 365).toFixed(4) : '—') },
                    { key: 'r',  label: 'Rho',  full: 'Rho (ρ) — sensitivity to interest rate', get: (_q: OptionQuote, g: any) => (g ? g.rho.toFixed(2) : '—') },
                    { key: 'iv', label: 'IV',   full: 'Implied volatility', get: (q: OptionQuote) => fmtIv(q.iv) },
                    { key: 'bid', label: 'Bid', full: 'Bid price', get: (q: OptionQuote) => fmt(q.bid) },
                    { key: 'ask', label: 'Ask', full: 'Ask price', get: (q: OptionQuote) => fmt(q.ask) },
                  ];
                  // PUTS read left→right AWAY from the center strike (greeks nearest
                  // the center). CALLS are the mirror: right→left TOWARD the center,
                  // so the equivalent greek column on each side sits across from the
                  // other, both closest to the middle.
                  const putCols = colDefs;
                  const callCols = [...colDefs].reverse();
                  const syncScroll = (from: 'call' | 'put') => {
                    if (optSyncRef.current) return;
                    optSyncRef.current = true;
                    // Inverse (counter) scroll: the CALL pane scrolls from the right,
                    // the PUT pane from the left, so the greek columns stay parked
                    // next to the center strike as either side scrolls.
                    const call = callScrollRef.current;
                    const put = putScrollRef.current;
                    if (call && put) {
                      const callMax = call.scrollWidth - call.clientWidth;
                      if (from === 'call') {
                        put.scrollLeft = callMax - call.scrollLeft;
                      } else {
                        call.scrollLeft = callMax - put.scrollLeft;
                      }
                    }
                    requestAnimationFrame(() => { optSyncRef.current = false; });
                  };
                  // Vertical scroll: ALL THREE columns (call body, center strike, put
                  // body) scroll together so rows stay aligned. The pinned header
                  // rows (CALLS/Strike/PUTS + greek labels) live OUTSIDE these
                  // scrollers and therefore stay put.
                  const syncVertical = (from: 'call' | 'put' | 'strike') => {
                    if (optVSyncRef.current) return;
                    optVSyncRef.current = true;
                    const call = callScrollRef.current;
                    const put = putScrollRef.current;
                    const strike = strikeScrollRef.current;
                    const src = from === 'call' ? call : from === 'put' ? put : strike;
                    const top = src ? src.scrollTop : 0;
                    if (call && from !== 'call') call.scrollTop = top;
                    if (put && from !== 'put') put.scrollTop = top;
                    if (strike && from !== 'strike') strike.scrollTop = top;
                    requestAnimationFrame(() => { optVSyncRef.current = false; });
                  };
                  // On first layout, start CALL scrolled fully right and PUT at 0 —
                  // that parks the greeks of both sides immediately beside the
                  // center strike column. (Declared as a plain function, invoked
                  // from the component-level effect below — never as a hook here.)
                  const parkGreeksAtCenter = () => {
                    const call = callScrollRef.current;
                    const put = putScrollRef.current;
                    if (call && put) {
                      const callMax = call.scrollWidth - call.clientWidth;
                      call.scrollLeft = callMax;
                      put.scrollLeft = 0;
                    }
                  };
                  // when strike < spot; a put is ITM when strike > spot.
                  const itmClass = (which: 'C' | 'P', strike: number) =>
                    opt.underlying_price > 0
                      ? (which === 'C' ? strike < opt.underlying_price : strike > opt.underlying_price)
                        ? 'ochain-itm'
                        : 'ochain-otm'
                      : '';
                  const renderPane = (which: 'C' | 'P', cols: typeof callCols, valClass: string, scrollRef: React.RefObject<HTMLDivElement | null>) => (
                    <div
                      className="ochain-pane"
                      ref={scrollRef}
                      onScroll={() => {
                        syncScroll(which === 'C' ? 'call' : 'put');
                        syncVertical(which === 'C' ? 'call' : 'put');
                      }}
                      data-testid={`ochain-pane-${which}`}
                    >
                      {/* The greek column-header row is rendered as a STICKY <thead>
                        INSIDE this scroller so it (a) shares the table's exact
                        column widths — perfect alignment with the value rows —
                        (b) scrolls horizontally with its own pane automatically,
                        and (c) stays pinned at the top of the pane while only the
                        value rows scroll vertically (see .options-chain-table thead
                        { position: sticky }). */}
                    <table className="options-chain-table" data-testid={`options-chain-${which}`}>
                      <thead>
                        <tr className="ochain-cols">
                          {cols.map((c) => <th key={c.key} title={`${c.full} (${which === 'C' ? 'Call' : 'Put'})`}>{c.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {strikes.map((strike) => {
                          const q = optRows.find((r) => r.type === which && r.strike === strike);
                          const g = q ? greekMap.get(`${which}-${strike}`) : undefined;
                          const isAtm = opt.underlying_price > 0 && Math.abs(strike - opt.underlying_price) <= minDist;
                          return (
                            <tr key={strike} className={`${isAtm ? 'ochain-atm' : ''} ${itmClass(which, strike)}`} data-testid="ochain-row">
                              {cols.map((col) => (
                                <td key={col.key} className={valClass}>{q ? col.get(q, g) : '—'}</td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                  );
                  return (
                    <div className="options-chain-wrap" data-testid="options-chain-wrap">
                      <div className="options-chain-panes" data-testid="options-chain-panes">
                        {/* When a side is toggled off its whole wrapper is hidden
                            (.ochain-side-hidden -> display:none) so the remaining
                            side's flex:1 expands to the full width. The center
                            strike column always stays visible. */}
                        <div className={`ochain-side ochain-side-call ${showCall ? '' : 'ochain-side-hidden'}`}>
                          <div className="ochain-side-head opt-call" data-testid="head-calls">CALLS</div>
                          {showCall && renderPane('C', callCols, 'opt-call-val', callScrollRef)}
                        </div>
                        <div className="ochain-center" data-testid="ochain-center">
                          <div className="ochain-side-head ochain-strike-head">Strike</div>
                          {/* Spacer that matches the side panes' STICKY <thead> header
                              height (same padding 0.32rem + line-height 1.35 + font
                              0.72rem) so the strike VALUES drop by exactly one header
                              row and align with the data rows. */}
                          <div className="ochain-strike-spacer" aria-hidden="true">&nbsp;</div>
                          <div className="ochain-strike-col" ref={strikeScrollRef} onScroll={() => syncVertical('strike')} data-testid="ochain-strike-col">
                            {strikes.map((strike) => {
                              const isAtm = opt.underlying_price > 0 && Math.abs(strike - opt.underlying_price) <= minDist;
                              return (
                                <div key={strike} className={`ochain-strike ${isAtm ? 'ochain-atm-strike' : ''}`} data-testid="ochain-strike">{fmt(strike)}</div>
                              );
                            })}
                          </div>
                        </div>
                        <div className={`ochain-side ochain-side-put ${showPut ? '' : 'ochain-side-hidden'}`}>
                          <div className="ochain-side-head opt-put" data-testid="head-puts">PUTS</div>
                          {showPut && renderPane('P', putCols, 'opt-put-val', putScrollRef)}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
            {!optErr && !opt && <p className="history-loading" data-testid="options-loading">Loading {sym} option chain…</p>}
          </div>
        )}

        {tab === 'news' && (
          <div className="market-news-pane" data-testid="market-news-pane">
            {newsErr && <p className="quote-error" role="alert" data-testid="news-error">{newsErr}</p>}
            {!newsErr && news && (() => {
              const agg = news.sentiment_score;
              const aggLabel = news.sentiment_label;
              // The analyst's own scored read (present after an analysis run).
              const sa = sentiment;
              const headlineCount = news.headlines.length;
              return (
                <>
                  <div className="news-summary" data-testid="news-summary">
                    <div className={`news-agg ${sentimentClass(aggLabel)}`} data-testid="news-aggregate">
                      <span className="news-agg-score">{agg > 0 ? `+${agg}` : agg}</span>
                      <span className="news-agg-label">{aggLabel.replace('_', ' ')}</span>
                    </div>
                    <div className="news-meta">
                      <span className={`history-src history-src-${news.source}`}>{news.source === 'finnhub' ? 'live' : 'seeded'}</span>
                      <span className="news-count">{headlineCount} headlines</span>
                      {news.note && <span className="news-note">{news.note}</span>}
                    </div>
                  </div>

                  {sa && (
                    <div className="analyst-sentiment" data-testid="analyst-sentiment">
                      <div className="analyst-sentiment-head">Sentiment Analyst read</div>
                      <div className="analyst-sentiment-grid">
                        <div className="quote-stat"><span className="quote-stat-label">News</span><span className="quote-stat-value">{sa.news_sentiment}</span></div>
                        <div className="quote-stat"><span className="quote-stat-label">Social</span><span className="quote-stat-value">{sa.social_sentiment}</span></div>
                        <div className="quote-stat"><span className="quote-stat-label">Analyst</span><span className="quote-stat-value">{sa.analyst_sentiment}</span></div>
                        <div className="quote-stat"><span className="quote-stat-label">Institutional</span><span className="quote-stat-value">{sa.institutional_sentiment}</span></div>
                        <div className="quote-stat"><span className="quote-stat-label">Score</span><span className="quote-stat-value">{sa.sentiment_score}</span></div>
                        {sa.consensus ? (
                          <div className="quote-stat quote-stat-wide" data-testid="fusion-consensus">
                            <span className="quote-stat-label">Sources fused</span>
                            <span className="quote-stat-value">
                              {sa.consensus.contributors.map((c: string) => (
                                <span key={c} className={`fusion-badge fusion-badge-${c}`}>{c}</span>
                              ))}
                              {sa.consensus.low_consensus && (
                                <span className="fusion-low-consensus" data-testid="fusion-low-consensus">⚠ low consensus</span>
                              )}
                            </span>
                            <span className="quote-stat-sub">
                              {sa.consensus.contributions
                                .map((ct: any) => `${ct.sourceId} ${Math.round(ct.contribution * 100)}%`)
                                .join(' · ')}
                            </span>
                          </div>
                        ) : sa.data_source ? (
                          <div className="quote-stat"><span className="quote-stat-label">Source</span><span className="quote-stat-value">{sa.data_source}</span></div>
                        ) : null}
                      </div>
                    </div>
                  )}

                  <ul className="news-list" data-testid="news-list">
                    {news.headlines.map((h, i) => {
                      // Only seeded/mock headlines are synthetic (no real story
                      // to link to). Finnhub/Yahoo/Google all carry genuine
                      // article URLs, so they render as real clickable links.
                      const isLive = news.source !== 'mock';
                      const href = isLive
                        ? (h.url || `https://news.google.com/search?q=${encodeURIComponent(h.title)}`)
                        : '';
                      return (
                        <li key={`${h.url}-${i}`} className="news-item" data-testid="news-item">
                          {isLive ? (
                            <a
                              className="news-link"
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                            >{h.title}</a>
                          ) : (
                            <span className="news-title-static">{h.title}</span>
                          )}
                          {h.summary && <p className="news-snippet">{h.summary}</p>}
                          <div className="news-item-meta">
                            <span className={`news-chip ${sentimentClass(h.sentiment)}`}>{h.sentiment.replace('_', ' ')}</span>
                            <span className="news-src">{h.source}</span>
                            <span className="news-time">{fmtDate(h.timestamp)}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              );
            })()}
            {!newsErr && !news && <p className="history-loading" data-testid="news-loading">Loading {sym} news…</p>}
          </div>
        )}
      </div>
    </section>
  );
}

export default MarketDataCard;
