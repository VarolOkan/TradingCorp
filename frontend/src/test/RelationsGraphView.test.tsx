// frontend/src/test/RelationsGraphView.test.tsx
import { render, screen, act } from '@testing-library/react';
import { RelationsGraphView } from '../components/RelationsGraphView';
import type { AnalysisResult } from '../types';

function result(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    decision: 'REJECT',
    confidence: 0.8,
    reasoning: 'r',
    preservation_rationale: null,
    conditions: [],
    tickers: ['AAPL'],
    company_name: 'Apple',
    investment_thesis: '',
    final_decision: '',
    error: null,
    fundamental_analysis: null,
    technical_analysis: null,
    sentiment_analysis: null,
    risk_assessment: { overall: 'MODERATE' },
    decisions: {},
    riskAssessments: {},
    ...overrides,
  };
}

describe('RelationsGraphView', () => {
  it('renders nothing without a result', () => {
    const { container } = render(<RelationsGraphView result={null} />);
    expect(container.querySelector('.relations-graph-view')).toBeNull();
  });

  it('renders the relations heading and an svg host when there is a result', () => {
    render(<RelationsGraphView result={result()} width={600} height={360} />);
    expect(screen.getByText('Relations')).toBeInTheDocument();
    // D3 mounts the svg into the host
    expect(document.querySelector('svg.relations-graph')).not.toBeNull();
    expect(document.querySelectorAll('g.node').length).toBeGreaterThan(0);
  });

  it('clears the host when result goes from set to null', () => {
    const { rerender } = render(<RelationsGraphView result={result()} />);
    expect(document.querySelector('svg.relations-graph')).not.toBeNull();
    act(() => {
      rerender(<RelationsGraphView result={null} />);
    });
    expect(document.querySelector('svg.relations-graph')).toBeNull();
  });
});
