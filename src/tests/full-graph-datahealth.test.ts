import Client from 'socket.io-client';
import { AnalysisServer } from '../server/index';
import { analystConfigStore } from '../server/analyst-config';

function waitFor(socket: any, event: string, timeout = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${event}`)), timeout);
    socket.once(event, (p: any) => { clearTimeout(t); resolve(p); });
  });
}

describe('FULL GRAPH run populates dataHealth (banner gate)', () => {
  let server: AnalysisServer; let port: number; let savedFetch: any;
  beforeAll(async () => {
    savedFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async (_u: string, _i: any) => ({
      ok: true, status: 200, headers: { get: () => 'application/json' },
      async json() { return { price: 190, symbol: 'AAPL', c: 190, 'Global Quote': { '05. price': '190' } }; },
    });
    for (const sid of ['yahoo', 'alphaVantage', 'finnhub']) {
      analystConfigStore.set({ sessionId: 'default', analystId: 'data_ingestion', sourceId: sid }, { token: `tok-${sid}`, extra: {} });
    }
    server = new AnalysisServer();
    await new Promise<void>((r) => (server as any).server.listen(0, () => r()));
    port = (server as any).server.address().port;
  }, 30000);
  afterAll(async () => {
    (globalThis as any).fetch = savedFetch;
    await new Promise<void>((r) => (server as any).server.close(() => r()));
  });

  it('long-term agency run reports sourcesOk>0 and mockDisabled=false', async () => {
    const client = Client(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
    const complete = waitFor(client, 'analysis_complete');
    await new Promise<void>((r) => client.on('connect', () => r()));
    client.emit('request_analysis', { tickers: ['MSFT'] });
    const result = await complete;
    client.close();
    console.log('FULL-GRAPH dataHealth =', JSON.stringify(result.dataHealth));
    console.log('FULL-GRAPH mockDisabled =', result.mockDisabled);
    expect(result.dataHealth).toBeDefined();
    expect(result.dataHealth.sourcesOk).toBeGreaterThan(0);
    expect(result.mockDisabled).toBe(false);
  }, 30000);
});
