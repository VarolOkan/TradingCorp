// src/tests/streaming.integration.test.ts
// Integration test: the real analysis server streams per-analyst events
// (analyst_start / analyst_done) as the LangGraph executes, in addition to the
// terminal analysis_complete. Verifies the contract the AnalystWall consumes.

import Client from 'socket.io-client';
import { AnalysisServer } from '../server/index';

function waitFor(socket: any, event: string, timeout = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    socket.once(event, (payload: any) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function collectRun(port: number, tickers: string[]) {
  const client = Client(`http://localhost:${port}`, {
    transports: ['websocket'],
    forceNew: true,
  });
  const starts: any[] = [];
  const dones: any[] = [];
  client.on('analyst_start', (p: any) => starts.push(p));
  client.on('analyst_done', (p: any) => dones.push(p));

  const complete = waitFor(client, 'analysis_complete');
  await new Promise<void>((r) => client.on('connect', () => r()));
  client.emit('request_analysis', { tickers });

  const result = await complete;
  client.close();
  return { starts, dones, result };
}

describe('real-time per-analyst streaming (integration)', () => {
  let server: AnalysisServer;
  let port: number;

  beforeAll(async () => {
    // AnalysisServer builds its own http.Server + io. Listen on an ephemeral
    // port (0) to avoid colliding with any running dev server.
    server = new AnalysisServer();
    await new Promise<void>((resolve) => {
      (server as any).server.listen(0, () => resolve());
    });
    port = (server as any).server.address().port;
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server as any).server.close(() => resolve()));
  });

  it('emits analyst_start for each analyst in pipeline order, then done', async () => {
    const { starts, dones, result } = await collectRun(port, ['AAPL', 'MSFT']);

    const startIds = starts.map((s) => s.analyst);
    expect(startIds).toEqual([
      'orchestrator',
      'data_ingestion',
      'fundamental',
      'technical',
      'sentiment',
      'bull_researcher',
      'bear_researcher',
      'risk',
      'governance',
    ]);

    const doneIds = dones.map((d) => d.analyst);
    expect(doneIds).toEqual(startIds);

    // Each start/done carried the tickers it processed.
    expect(starts[0].tickers).toEqual(['AAPL', 'MSFT']);
    // Governance done exposes the decision + confidence.
    const gov = dones.find((d) => d.analyst === 'governance');
    expect(['APPROVE', 'REJECT']).toContain(gov.decision);
    expect(typeof gov.confidence).toBe('number');

    // Terminal event still fires with the normalized result.
    expect(result).toHaveProperty('decision');
    expect(result.tickers).toEqual(['AAPL', 'MSFT']);
  }, 30000);

  it('runs the tickers supplied via request_analysis (contract fix)', async () => {
    const { result } = await collectRun(port, ['TSLA']);
    expect(result.tickers).toEqual(['TSLA']);
    // Real run must not error out due to empty messages.
    expect(result.error).toBeFalsy();
  }, 30000);

  it('ships a structured per-analyst trace on analysis_complete (Phase 1)', async () => {
    const { result } = await collectRun(port, ['AAPL', 'MSFT']);

    // The trace array is keyed by analyst id and carries the drill-down record.
    expect(Array.isArray(result.analystTraces)).toBe(true);
    // Parity invariant: the SET of analysts is identical regardless of whether
    // the run is serial or parallel. Stage-2 analysts finish in non-deterministic
    // order under parallel execution, so assert the SET, not the order.
    const idSet = new Set(result.analystTraces.map((t: any) => t.analyst));
    expect(idSet).toEqual(new Set([
      'bull_researcher',
      'bear_researcher',
      'data_ingestion',
      'fundamental',
      'governance',
      'orchestrator',
      'risk',
      'sentiment',
      'technical',
    ]));

    // Every trace must expose the four drill-down pillars.
    for (const trace of result.analystTraces) {
      expect(typeof trace.instructions).toBe('string');
      expect(trace.instructions.length).toBeGreaterThan(0);
      expect(Array.isArray(trace.inputs)).toBe(true);
      expect(trace.inputs.length).toBeGreaterThan(0);
      expect(Array.isArray(trace.weighting)).toBe(true);
      expect(trace.weighting.length).toBeGreaterThan(0);
      expect(trace.output).toHaveProperty('summary');
    }

    // A non-orchestrator trace should carry per-ticker inputs with sources.
    const fundamental = result.analystTraces.find((t: any) => t.analyst === 'fundamental');
    expect(fundamental.inputs[0]).toHaveProperty('ticker', 'AAPL');
    expect(Array.isArray(fundamental.inputs[0].sources)).toBe(true);
    expect(fundamental.inputs[0].sources.length).toBeGreaterThan(0);
    // Weighting steps expose how the output was derived.
    expect(fundamental.weighting[0]).toHaveProperty('weight');
    expect(fundamental.weighting[0]).toHaveProperty('contribution');
  }, 30000);
});
