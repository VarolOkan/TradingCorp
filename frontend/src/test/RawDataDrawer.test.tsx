// frontend/src/test/RawDataDrawer.test.tsx
// Verify the R5 per-analyst raw-data viewer drawer: renders nothing without a
// dump, mounts closed→open without a hooks error, shows the four tabs, lists
// per-analyst dataReceived annotations, and renders the equity + options
// stores when present. Mirrors AnalystTraceDrawer.test.tsx conventions.

import { render, screen, fireEvent } from '@testing-library/react';
import { RawDataDrawer, type RawDataDump } from '../components/RawDataDrawer';

function makeDump(overrides: Partial<RawDataDump> = {}): RawDataDump {
  return {
    reportId: 'report-long-term-AAPL-12-30-45',
    agencyId: 'long-term',
    tickers: ['AAPL'],
    companyName: 'Apple Inc.',
    generatedAt: '2026-07-11T12:30:45.000Z',
    ingested: {
      source: 'yahoo',
      market: {
        AAPL: { price: 212.34, day_high: 214.1, day_low: 210.2, volume: 54000000, interval: '5m', beta: 1.21, volatility_30d: 0.24 },
      },
      fundamental: { debt_to_equity: 1.2 },
      sentiment: { news_score: 0.6 },
    },
    optionsData: {
      underlying_symbol: 'AAPL',
      source: 'mock',
      asOf: '2026-07-11T12:30:00Z',
      price_bars: [{ timestamp: '2026-07-11T12:30:00Z', close: 212.34 }],
      option_chain: [{ strike: 210, type: 'call', bid: 4.2, ask: 4.4 }],
      greeks: [{ strike: 210, delta: 0.55 }],
    },
    dataReceived: [
      { analyst: 'fundamental', ticker: 'AAPL', domain: 'fundamental', channel: 'ingested.fundamental', blocks: [{ channel: 'ingested.fundamental', rows: 1, source: 'yahoo' }], provenance: 'ingested' },
      { analyst: 'technical', ticker: 'AAPL', domain: 'technical', channel: 'ingested.bars', blocks: [{ channel: 'ingested.bars', interval: '5m', barsUsed: 78, source: 'yahoo' }], provenance: 'ingested' },
      { analyst: 'risk', ticker: 'AAPL', domain: 'risk', channel: 'ingested.market', blocks: [{ channel: 'ingested.market', source: 'yahoo' }], provenance: 'ingested' },
    ],
    byAnalyst: {
      fundamental: [{ ticker: 'AAPL', channel: 'ingested.fundamental', domains: ['fundamental'], provenance: 'ingested' }],
      technical: [{ ticker: 'AAPL', channel: 'ingested.bars', domains: ['technical'], provenance: 'ingested' }],
      risk: [{ ticker: 'AAPL', channel: 'ingested.market', domains: ['risk'], provenance: 'ingested' }],
    },
    ...overrides,
  };
}

describe('RawDataDrawer', () => {
  it('renders nothing when dump is null (closed)', () => {
    const { container } = render(<RawDataDrawer dump={null} onClose={vi.fn()} />);
    expect(container.querySelector('.trace-drawer')).toBeNull();
  });

  it('mounts closed then opens without a hooks error', () => {
    const { rerender } = render(<RawDataDrawer dump={null} onClose={vi.fn()} />);
    // closed render establishes the hook baseline
    rerender(<RawDataDrawer dump={makeDump()} onClose={vi.fn()} />);
    expect(screen.getByTestId('rawdata-drawer')).toBeInTheDocument();
  });

  it('shows the Overview tab with run metadata', () => {
    render(<RawDataDrawer dump={makeDump()} onClose={vi.fn()} />);
    expect(screen.getByTestId('rawdata-tab-overview').className).toContain('active');
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    // 3 dataReceived entries counted in summary
    expect(screen.getByText('3 dataReceived entries')).toBeInTheDocument();
  });

  it('lists per-analyst annotations on the By Analyst tab', () => {
    render(<RawDataDrawer dump={makeDump()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('rawdata-tab-analysts'));
    expect(screen.getByTestId('rawdata-analyst-btn-fundamental')).toBeInTheDocument();
    // selecting technical shows its channel annotation
    fireEvent.click(screen.getByTestId('rawdata-analyst-btn-technical'));
    expect(screen.getByTestId('rawdata-entry-technical-0')).toHaveTextContent('ingested.bars');
  });

  it('renders the equity store on the Equity tab', () => {
    render(<RawDataDrawer dump={makeDump()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('rawdata-tab-equity'));
    expect(screen.getByTestId('equity-AAPL-price')).toHaveTextContent('212.34');
    expect(screen.getByTestId('equity-fundamental')).toBeInTheDocument();
  });

  it('renders the options bundle on the Options tab', () => {
    render(<RawDataDrawer dump={makeDump()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('rawdata-tab-options'));
    expect(screen.getByTestId('options-json')).toHaveTextContent('AAPL');
  });

  it('shows honest CBOE provenance + note in the Options side-pane', () => {
    render(
      <RawDataDrawer
        dump={makeDump({
          optionsData: {
            underlying_symbol: 'NVDA',
            source: 'cboe',
            note: 'Delayed ~15-20 min — free CBOE delayed options feed (real bid/ask/IV).',
            asOf: '2026-07-17T17:04:22Z',
            option_chain: [{ strike: 2.5, type: 'call', bid: 200.5, ask: 205.85 }],
          },
        })}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('rawdata-tab-options'));
    expect(screen.getByTestId('options-source-label')).toHaveTextContent('CBOE free delayed feed');
    expect(screen.getByTestId('options-source-note')).toHaveTextContent('CBOE delayed options feed');
  });

  it('shows an empty state when the dump has no annotations', () => {
    render(
      <RawDataDrawer
        dump={makeDump({ dataReceived: [], byAnalyst: {}, ingested: null, optionsData: null })}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByTestId('rawdata-noanalysts')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rawdata-tab-equity'));
    expect(screen.getByText(/No ingested equity data/)).toBeInTheDocument();
  });

  it('calls onClose from the close button + scrim', () => {
    const onClose = vi.fn();
    render(<RawDataDrawer dump={makeDump()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('rawdata-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('rawdata-scrim'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
