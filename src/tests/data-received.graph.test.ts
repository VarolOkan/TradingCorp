// src/tests/data-received.graph.test.ts
// Phase R (RAW_DATA_DUMP.md) — regression for the LIVE bug where the raw-data
// channels (ingested / optionsData / dataReceived) were silently dropped by
// LangGraph's state reduction because they were NOT declared as GraphState
// channels. This test builds a REAL StateGraph using the exact channel
// reducers the live graph uses (concat+dedupe for dataReceived, last-wins for
// ingested/optionsData) with mock nodes that append dataReceived the same way
// the real handlers do. It proves `invoke` threads the channels to the final
// state WITHOUT dropping or double-counting — without booting the full agency
// graph (which would pull the sqlite chain and is env-blocked here).
import { describe, it, expect } from '@jest/globals';
import { StateGraph, Annotation, END } from '@langchain/langgraph';
import { mergeDataReceived } from '../registry/logic/shared';
import type { DataReceivedEntry } from '../types/financial-analysis';

function entry(analyst: string, ticker: string, domain: string): DataReceivedEntry {
  return {
    analyst, ticker, channel: 'ingested',
    blocks: [{ domain: domain as any, source: 'mock' }],
    provenance: 'mock',
  };
}

describe('mergeDataReceived reducer (LangGraph boundary)', () => {
  it('concatenates distinct entries', () => {
    const out = mergeDataReceived([entry('a', 'H', 'bars')], [entry('b', 'H', 'market')]);
    expect(out).toHaveLength(2);
  });

  it('dedupes identical (analyst|ticker|channel|domains) entries — the serial double-count trap', () => {
    // Node B receives A's entry in its state and re-appends it, then LangGraph
    // concatenates channel[A] + nodeReturn[A,B]. Naive concat would yield 2x A.
    const a = [entry('a', 'H', 'bars')];
    const nodeReturn = [entry('a', 'H', 'bars'), entry('b', 'H', 'market')];
    const out = mergeDataReceived(a, nodeReturn);
    expect(out).toHaveLength(2);
    expect(out.filter((e) => e.analyst === 'a')).toHaveLength(1);
  });

  it('handles undefined inputs', () => {
    expect(mergeDataReceived(undefined, undefined)).toEqual([]);
    expect(mergeDataReceived([entry('a', 'H', 'bars')], undefined)).toHaveLength(1);
  });
});

describe('Phase R — live invoke threads raw-data channels', () => {
  // Mirror the live GraphState channels for the three raw-data fields.
  const GraphState = Annotation.Root({
    messages: Annotation<any[]>({ reducer: (a: any[], b: any[]) => a.concat(b), default: () => [] }),
    ingested: Annotation<any>({ reducer: (a: any, b: any) => b, default: () => null }),
    optionsData: Annotation<any>({ reducer: (a: any, b: any) => b, default: () => null }),
    dataReceived: Annotation<any[]>({ reducer: (a: any[], b: any[]) => mergeDataReceived(a, b), default: () => [] }),
  });

  // Mock analysts that behave like the real handlers: each receives the prior
  // state (which already carries earlier analysts' dataReceived), appends its
  // OWN entry via the same append pattern, and returns the full state.
  const makeNode = (analyst: string, domain: string) => async (state: any) => {
    const e = entry(analyst, 'H', domain);
    const existing = Array.isArray(state.dataReceived) ? state.dataReceived : [];
    return { ...state, dataReceived: [...existing, e] };
  };

  it('carries every analyst dataReceived entry to the final state (no drop)', async () => {
    const g = new StateGraph(GraphState);
    g.addNode('ingest', async (s: any) => ({ ...s, ingested: { bars: { '1d': [] }, source: 'mock' } }));
    g.addNode('technical', makeNode('technical', 'bars'));
    g.addNode('fundamental', makeNode('fundamental', 'fundamental'));
    g.addNode('risk', makeNode('risk', 'market'));
    g.addEdge('__start__', 'ingest');
    g.addEdge('ingest', 'technical');
    g.addEdge('technical', 'fundamental');
    g.addEdge('fundamental', 'risk');
    g.addEdge('risk', END);
    const app = g.compile();

    const final = await app.invoke({ messages: [], ingested: null, optionsData: null, dataReceived: [] });
    expect(final.ingested).toBeTruthy(); // channel was kept (not dropped)
    expect(final.dataReceived).toHaveLength(3); // technical + fundamental + risk
    const analysts = final.dataReceived.map((e: any) => e.analyst).sort();
    expect(analysts).toEqual(['fundamental', 'risk', 'technical']);
  });

  it('does not double-count under serial fan-through (the exact prior bug)', async () => {
    const g = new StateGraph(GraphState);
    g.addNode('a', makeNode('a', 'bars'));
    g.addNode('b', makeNode('b', 'market'));
    g.addEdge('__start__', 'a');
    g.addEdge('a', 'b');
    g.addEdge('b', END);
    const app = g.compile();
    const final = await app.invoke({ messages: [], ingested: null, optionsData: null, dataReceived: [] });
    expect(final.dataReceived).toHaveLength(2); // NOT 3 (a would be duplicated)
  });
});
