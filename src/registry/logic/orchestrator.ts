// src/registry/logic/orchestrator.ts
// Pure orchestrator handler (replaces OrchestratorNode). Parses the resolved
// tickers / query and seeds the pipeline. Uses parseQuery from utils so the
// parsing rules stay independently unit-testable.

import type { AgentState } from '../../types/financial-analysis';
import { instructionFor } from '../prompts';
import { makeNodeSurface, type NodeSurface } from './shared';
import { parseQuery } from '../../utils/parse-query';
import type { AnalystTuning } from '../../types/registry';

export type { NodeSurface };

export async function orchestratorHandler(
  state: AgentState,
  node: NodeSurface,
  _tuning?: AnalystTuning,
): Promise<AgentState> {
  let updatedState = node.updateStep(state, 'orchestrator_processing');

  try {
    let tickers: string[];
    const defaultOptions = { depth: 'STANDARD', time_horizon: 'MEDIUM_TERM', risk_tolerance: 'MODERATE' } as {
      depth: 'QUICK' | 'STANDARD' | 'DEEP';
      time_horizon: 'SHORT_TERM' | 'MEDIUM_TERM' | 'LONG_TERM';
      risk_tolerance: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';
    };
    let options = defaultOptions;

    if (Array.isArray(state.tickers) && state.tickers.length > 0) {
      tickers = state.tickers
        .map((t) => String(t).trim().toUpperCase())
        .filter((t) => t.length > 0);
      updatedState = node.addMessage(
        updatedState,
        'system',
        `Parsed analysis request: ${tickers.length} ticker(s) - ${tickers.join(', ')}`,
      );
    } else {
      const userMessage = state.messages?.[state.messages.length - 1];
      if (!userMessage || !userMessage.content) {
        throw new Error('No user message or tickers provided');
      }
      const query = userMessage.content.trim();
      const parsed = parseQuery(query);
      tickers = parsed.tickers;
      options = parsed.options;
      updatedState = node.addMessage(
        updatedState,
        'system',
        `Starting financial analysis for query: ${query}`,
      );
    }

    node.emitProgress(state, 'analyst:start', 'orchestrator', { stage: 1, tickers });

    updatedState = {
      ...updatedState,
      tickers,
      company_name: tickers.length > 0 ? tickers.join(', ') : 'Unknown',
      current_date: new Date().toISOString().split('T')[0]!,
      investment_thesis: '',
      final_decision: '',
      error: null,
    };

    updatedState = node.captureTrace(updatedState, {
      analyst: 'orchestrator',
      name: 'Orchestrator',
      stage: 1,
      instructions: instructionFor('orchestrator'),
      inputs: [
        {
          ticker: tickers.join(', '),
          label: 'Requested universe + resolved options',
          data: { tickers, options },
          sources: ['Client request (request_analysis tickers)'],
        },
      ],
      weighting: [
        {
          label: 'Routing',
          inputs: ['tickers'],
          weight: 1,
          rationale: 'Every ticker is fanned out to Fundamental/Technical/Sentiment/Risk, then Governance.',
          contribution: 100,
          scale: 'routing weight',
        },
      ],
      output: {
        verdict: 'ROUTED',
        summary: `Parsed ${tickers.length} ticker(s) (${tickers.join(', ')}) and seeded the pipeline.`,
        details: { tickers, options },
      },
    });

    node.emitProgress(state, 'analyst:done', 'orchestrator', { tickers, stage: 1 });
    return updatedState;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    node.emitProgress(state, 'analyst:done', 'orchestrator', { error: errorMessage, stage: 1 });
    return {
      ...updatedState,
      error: `Orchestrator error: ${errorMessage}`,
      current_step: 'orchestrator_error',
      final_decision: 'ERROR: Failed to parse input',
    };
  }
}
