// src/tests/orchestrator.node.test.ts
// Unit tests for the orchestrator handler (registry/logic/orchestrator.ts).
// Replaces the old OrchestratorNode tests; parseQuery is tested directly via
// the extracted util.

import { orchestratorHandler } from '../registry/logic/orchestrator';
import { makeNodeSurface } from '../registry/logic/shared';
import { parseQuery } from '../utils/parse-query';
import { AgentState } from '../types/financial-analysis';

const surface = makeNodeSurface();

describe('Orchestrator handler', () => {
  describe('process', () => {
    it('should parse a simple ticker query', async () => {
      const initialState: AgentState = {
        messages: [
          { role: 'user', content: 'Analyze AAPL', timestamp: new Date().toISOString() },
        ],
        current_date: '',
        tickers: [],
        company_name: '',
        investment_thesis: '',
        final_decision: '',
        error: null,
        current_step: 'start',
      };

      const result = await orchestratorHandler(initialState, surface);

      expect(result.tickers).toEqual(['AAPL']);
      expect(result.company_name).toBe('AAPL');
      expect(result.error).toBeNull();
      expect(result.current_step).toBe('orchestrator_processing');
    });

    it('should parse multiple tickers', async () => {
      const initialState: AgentState = {
        messages: [
          { role: 'user', content: 'Analyze AAPL, MSFT, GOOGL', timestamp: new Date().toISOString() },
        ],
        current_date: '',
        tickers: [],
        company_name: '',
        investment_thesis: '',
        final_decision: '',
        error: null,
        current_step: 'start',
      };

      const result = await orchestratorHandler(initialState, surface);

      expect(result.tickers).toEqual(['AAPL', 'MSFT', 'GOOGL']);
      expect(result.company_name).toBe('AAPL, MSFT, GOOGL');
      expect(result.error).toBeNull();
    });

    it('should handle lowercase tickers', async () => {
      const initialState: AgentState = {
        messages: [
          { role: 'user', content: 'analyze aapl msft', timestamp: new Date().toISOString() },
        ],
        current_date: '',
        tickers: [],
        company_name: '',
        investment_thesis: '',
        final_decision: '',
        error: null,
        current_step: 'start',
      };

      const result = await orchestratorHandler(initialState, surface);

      expect(result.tickers).toEqual(['AAPL', 'MSFT']);
      expect(result.error).toBeNull();
    });

    it('should handle explicit ticker patterns', async () => {
      const initialState: AgentState = {
        messages: [
          { role: 'user', content: 'What about MSFT? Should I invest?', timestamp: new Date().toISOString() },
        ],
        current_date: '',
        tickers: [],
        company_name: '',
        investment_thesis: '',
        final_decision: '',
        error: null,
        current_step: 'start',
      };

      const result = await orchestratorHandler(initialState, surface);

      expect(result.tickers).toEqual(['MSFT']);
      expect(result.error).toBeNull();
    });

    it('should handle empty input gracefully', async () => {
      const initialState: AgentState = {
        messages: [
          { role: 'user', content: '', timestamp: new Date().toISOString() },
        ],
        current_date: '',
        tickers: [],
        company_name: '',
        investment_thesis: '',
        final_decision: '',
        error: null,
        current_step: 'start',
      };

      const result = await orchestratorHandler(initialState, surface);

      expect(result.tickers).toEqual([]);
      expect(result.error).toContain('Orchestrator error');
    });

    it('should handle invalid input gracefully', async () => {
      const initialState: AgentState = {
        messages: [
          { role: 'user', content: null as any, timestamp: new Date().toISOString() },
        ],
        current_date: '',
        tickers: [],
        company_name: '',
        investment_thesis: '',
        final_decision: '',
        error: null,
        current_step: 'start',
      };

      const result = await orchestratorHandler(initialState, surface);

      expect(result.error).toContain('Orchestrator error');
    });
  });

  describe('parseQuery', () => {
    it('should extract tickers from a string', () => {
      const result = parseQuery('Check AAPL and MSFT stocks');
      expect(result.tickers).toEqual(['AAPL', 'MSFT']);
    });

    it('should remove duplicate tickers', () => {
      const result = parseQuery('Analyze AAPL, MSFT, AAPL');
      expect(result.tickers).toEqual(['AAPL', 'MSFT']);
    });

    it('should return empty array for no tickers', () => {
      const result = parseQuery('How is the market today?');
      expect(result.tickers).toEqual([]);
    });

    it('should detect quick analysis modifier', () => {
      const result = parseQuery('Do a quick analysis of AAPL');
      expect(result.options.depth).toBe('QUICK');
    });

    it('should detect deep analysis modifier', () => {
      const result = parseQuery('Give me a deep dive on MSFT');
      expect(result.options.depth).toBe('DEEP');
    });

    it('should detect short term horizon', () => {
      const result = parseQuery('Analyze AAPL for short term trading');
      expect(result.options.time_horizon).toBe('SHORT_TERM');
    });

    it('should detect long term horizon', () => {
      const result = parseQuery('Invest in MSFT for long term growth');
      expect(result.options.time_horizon).toBe('LONG_TERM');
    });

    it('should detect conservative risk tolerance', () => {
      const result = parseQuery('Give me a conservative analysis of AAPL');
      expect(result.options.risk_tolerance).toBe('CONSERVATIVE');
    });

    it('should detect aggressive risk tolerance', () => {
      const result = parseQuery('I want an aggressive strategy for TSLA');
      expect(result.options.risk_tolerance).toBe('AGGRESSIVE');
    });
  });

  describe('parseQuery — real-world / free-form queries (KNOWN_ISSUES #1)', () => {
    it('should extract tickers from free-form phrasing not in the old hardcoded set', () => {
      const result = parseQuery('What do you think about NVDA and AMD right now?');
      expect(result.tickers).toEqual(['NVDA', 'AMD']);
    });

    it('should extract a single casual ticker mention', () => {
      const result = parseQuery('Is GOOGL a good buy?');
      expect(result.tickers).toEqual(['GOOGL']);
    });

    it('should combine detected depth with detected tickers', () => {
      const result = parseQuery('Give me a quick take on TSLA and NVDA');
      expect(result.tickers).toEqual(['TSLA', 'NVDA']);
      expect(result.options.depth).toBe('QUICK');
    });

    it('should detect short term horizon on arbitrary phrasing', () => {
      const result = parseQuery('plan a short term swing trade on AMD');
      expect(result.tickers).toEqual(['AMD']);
      expect(result.options.time_horizon).toBe('SHORT_TERM');
    });

    it('should not drop a valid ticker that the old denylist would have swallowed via fallback', () => {
      // IRON is a real ticker; must never be silently discarded.
      const result = parseQuery('Compare IRON against SPY');
      expect(result.tickers).toContain('IRON');
      expect(result.tickers).toContain('SPY');
    });

    it('should validate query-parsed tickers and drop non-symbols (KNOWN_ISSUES #1/#6)', async () => {
      // Yahoo-shaped fake: a real chart.result for AAPL/MSFT, a chart.error
      // ("No data found") for GGGGGG (a junk symbol). 404 + chart.error is how
      // Yahoo reports an unknown symbol.
      const fetchFn = ((url: string) => {
        const isJunk = /GGGGGG/i.test(url);
        const payload = isJunk
          ? { chart: { error: { description: 'No data found, symbol may be delisted' } } }
          : { chart: { result: [{ meta: { regularMarketPrice: 1 } }] } };
        return Promise.resolve({ ok: !isJunk, status: isJunk ? 404 : 200, json: async () => payload } as any);
      }) as unknown as typeof fetch;
      const universeCheck = async () => 'unknown' as const; // force Layer-2 (Yahoo) path

      const initialState: AgentState = {
        messages: [
          { role: 'user', content: 'Compare GGGGGG against AAPL and MSFT', timestamp: new Date().toISOString() },
        ],
        current_date: '',
        tickers: [],
        company_name: '',
        investment_thesis: '',
        final_decision: '',
        error: null,
        current_step: 'start',
      };

      const result = await orchestratorHandler(initialState, surface, undefined, fetchFn, universeCheck);

      // GGGGGG is not a real symbol; it must be dropped, leaving the two real tickers.
      expect(result.tickers).toEqual(['AAPL', 'MSFT']);
      expect(result.error).toBeNull();
    });

    it('should fail OPEN and keep all tickers when validation errors (network down)', async () => {
      const fetchFn = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
      const universeCheck = async () => 'unknown' as const;

      const initialState: AgentState = {
        messages: [
          { role: 'user', content: 'Compare IRON against SPY', timestamp: new Date().toISOString() },
        ],
        current_date: '',
        tickers: [],
        company_name: '',
        investment_thesis: '',
        final_decision: '',
        error: null,
        current_step: 'start',
      };

      const result = await orchestratorHandler(initialState, surface, undefined, fetchFn, universeCheck);
      expect(result.tickers.sort()).toEqual(['IRON', 'SPY']);
      expect(result.error).toBeNull();
    });

    it('should NOT validate explicit state.tickers (user-confirmed symbols)', async () => {
      const fetchFn = (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch;
      const universeCheck = async () => 'unknown' as const;

      const initialState: AgentState = {
        messages: [],
        current_date: '',
        tickers: ['IRON', 'CAT'],
        company_name: '',
        investment_thesis: '',
        final_decision: '',
        error: null,
        current_step: 'start',
      };

      const result = await orchestratorHandler(initialState, surface, undefined, fetchFn, universeCheck);
      expect(result.tickers).toEqual(['IRON', 'CAT']);
    });
  });
});
