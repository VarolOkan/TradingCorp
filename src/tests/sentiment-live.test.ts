import Client from 'socket.io-client';
import { AnalysisServer } from '../server/index';
import { analystConfigStore } from '../server/analyst-config';

function waitFor(socket: any, event: string, timeout = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${event}`)), timeout);
    socket.once(event, (p: any) => { clearTimeout(t); resolve(p); });
  });
}

const yahooPayload = {
  chart: {
    result: [
      {
        meta: { symbol: 'AAPL' },
        indicators: { quote: [{ close: [190], high: [191], low: [189], open: [188], volume: [1] }] },
        timestamp: [1],
      },
    ],
  },
};

const finnhubPayload = [
  { headline: 'AAPL beats earnings expectations', source: 'Reuters', datetime: 1700000000, summary: 'Strong quarter', url: 'http://x' },
  { headline: 'AAPL faces regulatory probe', source: 'Bloomberg', datetime: 1700000001, summary: 'Scrutiny', url: 'http://y' },
];

describe('Sentiment uses LIVE Finnhub news (no mocked label)', () => {
  let server: AnalysisServer;
  let port: number;
  let savedFetch: any;

  beforeAll(async () => {
    savedFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string) => {
      const isFinnhub = typeof url === 'string' && url.includes('finnhub.io');
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async json() {
          return isFinnhub ? finnhubPayload : yahooPayload;
        },
      };
    };
    for (const sid of ['yahoo', 'alphaVantage', 'finnhub']) {
      analystConfigStore.set(
        { sessionId: 'default', analystId: 'data_ingestion', sourceId: sid },
        { token: `tok-${sid}`, extra: {} },
      );
    }
    server = new AnalysisServer();
    await new Promise<void>((r) => (server as any).server.listen(0, () => r()));
    port = (server as any).server.address().port;
  }, 30000);

  afterAll(async () => {
    (globalThis as any).fetch = savedFetch;
    await new Promise<void>((r) => (server as any).server.close(() => r()));
  });

  it('sentiment trace reflects live Finnhub news, not "mocked"', async () => {
    const client = Client(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
    const complete = waitFor(client, 'analysis_complete');
    await new Promise<void>((r) => client.on('connect', () => r()));
    client.emit('request_analysis', { tickers: ['AAPL'] });
    const result = await complete;
    client.close();

    const traces = result.analystTraces ?? [];
    console.log('RESULT ERROR =', JSON.stringify(result.error));
    console.log('TRACE ANALYSTS =', JSON.stringify(traces.map((t: any) => t.analyst)));
    console.log('ALL TRACES (analyst+hasNotes) =', JSON.stringify(traces.map((t:any)=>({a:t.analyst, notes:t.notes, src:t.inputs?.[0]?.sources}))));
    const sentTrace = traces.find((t: any) => t.analyst === 'sentiment');
    console.log('SENTIMENT trace notes =', JSON.stringify(sentTrace?.notes));
    console.log('SENTIMENT trace sources =', JSON.stringify(sentTrace?.inputs?.[0]?.sources));
    console.log('SENTIMENT ingested.data_source =', JSON.stringify(result.ingested?.sentiment?.AAPL?.data_source));
    expect(sentTrace).toBeDefined();
    expect(JSON.stringify(sentTrace?.notes ?? [])).not.toMatch(/mocked/i);
    expect(JSON.stringify(sentTrace?.inputs?.[0]?.sources ?? [])).toMatch(/live/i);
    expect(result.ingested?.sentiment?.AAPL?.data_source).toMatch(/live/);
  }, 30000);
});
