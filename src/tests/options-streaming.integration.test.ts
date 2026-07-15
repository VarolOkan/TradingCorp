// src/tests/options-streaming.integration.test.ts
// Phase E live gate: boot the real AnalysisServer (socket.io) and emit a
// request_analysis with agencyId:'options-intraday' and 'options-swing'. The
// server must route each to the right AgencyGraph, run the full options
// pipeline through governance, and ship a populated final_decision + the
// per-analyst option traces on analysis_complete.

import Client from 'socket.io-client';
import { AnalysisServer } from '../server/index';

function waitFor(socket: any, event: string, timeout = 20000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    socket.once(event, (payload: any) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function collectRun(port: number, agencyId: string, tickers: string[]) {
  const client = Client(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
  const starts: any[] = [];
  const dones: any[] = [];
  client.on('analyst_start', (p: any) => starts.push(p));
  client.on('analyst_done', (p: any) => dones.push(p));

  const complete = waitFor(client, 'analysis_complete');
  await new Promise<void>((r) => client.on('connect', () => r()));
  client.emit('request_analysis', { tickers, agencyId });

  const result = await complete;
  client.close();
  return { starts, dones, result };
}

const OPTION_ANALYSTS = [
  'options_ingestion', 'vol_surface', 'options_pricing',
  'options_greeks', 'options_flow', 'options_risk',
];

describe('Phase E — live options agency run (server socket gate)', () => {
  let server: AnalysisServer;
  let port: number;

  beforeAll(async () => {
    server = new AnalysisServer();
    await new Promise<void>((resolve) => (server as any).server.listen(0, () => resolve()));
    port = (server as any).server.address().port;
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server as any).server.close(() => resolve()));
  });

  it('options-intraday: request_analysis returns a populated decision + option traces', async () => {
    const { starts, result } = await collectRun(port, 'options-intraday', ['TSLA']);

    // The server streamed the options pipeline in node order.
    const startIds = starts.map((s) => s.analyst);
    expect(startIds).toContain('options_ingestion');
    expect(startIds).toContain('options_risk');
    expect(startIds).toContain('governance');

    // Terminal result is populated, not empty.
    expect(result.error).toBeFalsy();
    expect(['APPROVE', 'REJECT']).toContain(result.final_decision ?? result.decision);
    expect(Array.isArray(result.analystTraces)).toBe(true);

    const ids = (result.analystTraces ?? []).map((t: any) => t.analyst);
    for (const a of OPTION_ANALYSTS) expect(ids).toContain(a);
    // intraday also carries the options_technical timing node.
    expect(ids).toContain('options_technical');
  }, 30000);

  it('options-swing: request_analysis returns a populated decision + option traces', async () => {
    const { starts, result } = await collectRun(port, 'options-swing', ['AAPL']);

    const startIds = starts.map((s) => s.analyst);
    expect(startIds).toContain('options_ingestion');
    expect(startIds).toContain('governance');

    expect(result.error).toBeFalsy();
    expect(['APPROVE', 'REJECT']).toContain(result.final_decision ?? result.decision);

    const ids = (result.analystTraces ?? []).map((t: any) => t.analyst);
    for (const a of OPTION_ANALYSTS) expect(ids).toContain(a);
    // swing does NOT carry options_technical.
    expect(ids).not.toContain('options_technical');
  }, 30000);
});
