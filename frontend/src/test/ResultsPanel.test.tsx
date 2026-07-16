// frontend/src/test/ResultsPanel.test.tsx
import { render, screen } from '@testing-library/react';
import { ResultsPanel } from '../components/ResultsPanel';
import type { AnalysisResult } from '../types';

function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    decision: 'REJECT',
    confidence: 0.85,
    reasoning: 'Valuation is stretched versus peers.',
    preservation_rationale: 'Capital preservation prioritized given macro risk.',
    conditions: ['size <=5%', 'stop-loss 15%'],
    tickers: ['AAPL'],
    company_name: 'Apple Inc.',
    investment_thesis: 'Strong moat but priced for perfection.',
    final_decision: '',
    error: null,
    fundamental_analysis: null,
    technical_analysis: null,
    sentiment_analysis: null,
    risk_assessment: { overall: 'MODERATE', downside: '15%' },
    decisions: {},
    riskAssessments: {},
    ...overrides,
  };
}

// Phase A: structured verdict grid derived from analystTraces.
const TRACED_RESULT = makeResult({
  decision: 'APPROVE',
  analystTraces: [
    { analyst: 'orchestrator', name: 'Orchestrator', stage: 1, instructions: '', inputs: [], weighting: [], output: { summary: '' } },
    { analyst: 'data_ingestion', name: 'Data Ingestion', stage: 1, instructions: '', inputs: [], weighting: [], output: { summary: '' } },
    { analyst: 'fundamental', name: 'Fundamental', stage: 2, instructions: '', inputs: [], weighting: [], output: { verdict: 'BULLISH', score: 82, summary: 'Wide moat, clean balance sheet' } },
    { analyst: 'technical', name: 'Technical', stage: 2, instructions: '', inputs: [], weighting: [], output: { verdict: 'NEUTRAL', score: 61, summary: 'Price below SMA200, RSI cooling' } },
    { analyst: 'sentiment', name: 'Sentiment', stage: 2, instructions: '', inputs: [], weighting: [], output: { verdict: 'POSITIVE', score: 70, summary: 'News bullish, social mixed' } },
    { analyst: 'risk', name: 'Risk', stage: 2, instructions: '', inputs: [], weighting: [], output: { verdict: 'MEDIUM', score: 50, summary: 'Stop 15%, size <=5%' } },
    { analyst: 'governance', name: 'Governance', stage: 3, instructions: '', inputs: [], weighting: [], output: { verdict: 'APPROVE', score: 75, summary: 'Approve with preservation conditions' } },
  ],
});

describe('ResultsPanel', () => {
  it('renders nothing when result is null', () => {
    const { container } = render(<ResultsPanel result={null} />);
    expect(container.querySelector('.results-panel')).toBeNull();
  });

  it('renders decision, confidence, reasoning, thesis', () => {
    render(<ResultsPanel result={makeResult()} />);
    expect(screen.getByText('Reject')).toBeInTheDocument();
    expect(screen.getByText(/Confidence: 85%/)).toBeInTheDocument();
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText(/Valuation is stretched/)).toBeInTheDocument();
    expect(screen.getByText(/Strong moat/)).toBeInTheDocument();
  });

  it('renders preservation rationale and conditions', () => {
    render(<ResultsPanel result={makeResult()} />);
    expect(screen.getByText(/Capital preservation prioritized/)).toBeInTheDocument();
    expect(screen.getByText('size <=5%')).toBeInTheDocument();
    expect(screen.getByText('stop-loss 15%')).toBeInTheDocument();
  });

  it('renders risk assessment entries', () => {
    render(<ResultsPanel result={makeResult()} />);
    expect(screen.getByText(/overall:/)).toBeInTheDocument();
    expect(screen.getByText(/downside:/)).toBeInTheDocument();
  });

  it('does not render preservation/conditions sections when absent', () => {
    render(
      <ResultsPanel
        result={makeResult({ preservation_rationale: null, conditions: [] })}
      />
    );
    expect(screen.queryByText(/Capital preservation/)).toBeNull();
    expect(screen.queryByText('size <=5%')).toBeNull();
  });

  it('shows error text for ERROR decisions', () => {
    render(
      <ResultsPanel result={makeResult({ decision: 'ERROR', error: 'Upstream timeout' })} />
    );
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Upstream timeout')).toBeInTheDocument();
  });

  it('omits confidence when null', () => {
    render(<ResultsPanel result={makeResult({ confidence: null })} />);
    expect(screen.queryByText(/Confidence:/)).toBeNull();
  });

  // ---- Phase A: thesis verdict grid ----
  it('renders the thesis verdict grid from analystTraces (not the raw paragraph)', () => {
    const { container } = render(<ResultsPanel result={TRACED_RESULT} />);
    // Grid present, per-analyst rows present.
    expect(container.querySelector('.thesis-grid')).not.toBeNull();
    expect(container.querySelector('.thesis-row')).not.toBeNull();
    // Verdict chips rendered, colored by verdict content.
    const positive = screen.getByText('BULLISH');
    const neutral = screen.getByText('NEUTRAL');
    const medium = screen.getByText('MEDIUM');
    expect(positive.className).toContain('v-positive');
    expect(neutral.className).toContain('v-neutral');
    expect(medium.className).toContain('v-neutral');
    // Scores shown.
    expect(screen.getByText('82')).toBeInTheDocument();
    expect(screen.getByText('61')).toBeInTheDocument();
    // Synthesis line from reasoning.
    expect(screen.getByText(/Synthesis:/)).toBeInTheDocument();
    // Raw narrative string must NOT be in the grid path.
    expect(screen.queryByText(/Strong moat but priced for perfection/)).toBeNull();
  });

  it('falls back to the raw investment_thesis paragraph when no traces', () => {
    render(<ResultsPanel result={makeResult()} />);
    expect(screen.getByText(/Strong moat but priced for perfection/)).toBeInTheDocument();
  });

  it('shows the MOCK-DISABLED banner when result.mockDisabled is set', () => {
    render(<ResultsPanel result={makeResult({ mockDisabled: true })} />);
    const banner = screen.getByTestId('mock-disabled-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/MOCK DATA DISABLED/i);
    expect(banner.textContent).toMatch(/not fabricated/i);
  });

  it('shows NO banner when mockDisabled is absent (default parity)', () => {
    render(<ResultsPanel result={makeResult()} />);
    expect(screen.queryByTestId('mock-disabled-banner')).toBeNull();
  });
});
