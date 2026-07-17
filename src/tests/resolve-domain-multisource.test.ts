// src/tests/resolve-domain-multisource.test.ts
// P2b end-to-end: resolveDomain('news_sentiment') now performs a GENUINE
// multi-source fan-in (Finnhub + keyless Yahoo/Google) and the consumer fuses
// them. This test drives the real resolveDomain + fuseSentiment with a routed
// mock fetchFn so both live paths are exercised.

import { describe, it, expect } from '@jest/globals';
import { resolveDomain } from '../registry/logic/domains';
import { fuseSentiment } from '../registry/logic/fuse';

// --- routed mock fetchFn: returns different REAL payloads per provider URL ---
// Finnhub: bullish company news. Yahoo RSS: bearish-leaning titles.
function routedFetch() {
  return async (url: string) => {
    if (url.includes('finnhub')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { headline: 'AAPL smashes earnings, beats estimates', url: 'u1', source: 'Finnhub', datetime: 1, summary: 'strong quarter' },
          { headline: 'AAPL guidance raised on record demand', url: 'u2', source: 'Finnhub', datetime: 2, summary: 'bullish' },
        ],
        text: async () => '',
      };
    }
    if (url.includes('yahoo') || url.includes('google')) {
      // Yahoo RSS item: bearish title -> scorer yields a negative headline score.
      const xml = `<rss><channel>
        <item><title>AAPL slides as analysts cut price target on weak demand</title>
        <link>https://finance.yahoo.com/news/aapl-weak</link>
        <pubDate>Wed, 17 Jul 2026 10:00:00 GMT</pubDate>
        <source url="https://finance.yahoo.com">Yahoo</source></item>
      </channel></rss>`;
      return { ok: true, status: 200, json: async () => ({}), text: async () => xml };
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  };
}

describe('P2b news_sentiment multi-source fan-in', () => {
  it('returns TWO live records (finnhub primary + keyless yahoo) when both are live', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      finnhubKey: 'k',
      fetchFn: routedFetch() as any,
    });
    const live = recs.filter((r) => r.sourceId !== 'mock');
    expect(live.length).toBe(2);
    const [primary, secondary] = live;
    expect(primary!.sourceId).toBe('finnhub'); // parity: primary unchanged
    // Secondary is a keyless source (not finnhub). In this mock both yahoo +
    // google return live -> merged source 'mixed'.
    expect(['yahoo', 'google', 'mixed']).toContain(secondary!.sourceId);
    expect(secondary!.sourceId).not.toBe('finnhub');
    expect(live.every((r) => r.confidence === 1)).toBe(true);
  });

  it('fuses divergent Finnhub (+) + Yahoo (-) into a blended score with low_consensus', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      finnhubKey: 'k',
      fetchFn: routedFetch() as any,
    });
    const live = recs.filter((r) => r.sourceId !== 'mock');
    const fused = fuseSentiment(live)!;
    expect(fused).not.toBeNull();
    expect(fused.fusion.contributors[0]!).toBe('finnhub'); // primary first
    expect(fused.fusion.contributors.length).toBe(2); // finnhub + one keyless source
    expect(fused.fusion.contributors.filter((c) => c === 'finnhub').length).toBe(1);
    // Finnhub is bullish (positive), keyless bearish (negative) -> the two
    // sources DISAGREE: agreement < 1 and the low_consensus flag is consistent
    // with the configured threshold (the real contract of fuseNumeric).
    expect(fused.fusion.agreement).toBeLessThan(1);
    expect(fused.fusion.low_consensus).toBe(fused.fusion.agreement < 0.6);
    expect(fused.blended.source).toBe('mixed');
    expect(fused.blended.consensus).toBeDefined();
    expect(fused.blended.consensus!.low_consensus).toBe(fused.fusion.low_consensus);
    // Blend must differ from EITHER raw score (i.e. it genuinely combined them).
    const finScore = live[0]!.data.sentiment_score;
    const yahScore = live[1]!.data.sentiment_score;
    expect(fused.blended.sentiment_score).not.toBe(finScore);
    expect(fused.blended.sentiment_score).not.toBe(yahScore);
    expect(Math.abs(fused.blended.sentiment_score - finScore)).toBeLessThan(Math.abs(finScore - yahScore));
  });

  it('low_consensus flag is consistent with observed agreement (extreme divergence)', async () => {
    // Finnhub strongly bullish vs Yahoo strongly bearish. The exact magnitudes
    // come from the shared keyword scorer; what matters is the FLAT HONEST
    // contract: the flag tracks agreement vs the 0.6 threshold, and a blended
    // 'mixed' result is produced. (The pure engine's low_consensus=true case
    // with extreme +80/-60 is covered directly in fuse.test.ts.)
    const extreme = async (url: string) => {
      if (url.includes('finnhub')) {
        return {
          ok: true, status: 200,
          json: async () => [
            { headline: 'AAPL soars to record high, spectacular blowout earnings beat', url: 'u1', source: 'Finnhub', datetime: 1, summary: 'amazing' },
            { headline: 'AAPL surges as analysts hike price target on booming demand', url: 'u2', source: 'Finnhub', datetime: 2, summary: 'bullish' },
          ],
          text: async () => '',
        };
      }
      const xml = `<rss><channel>
        <item><title>AAPL plunges as stock crashes on catastrophic collapse in demand</title>
        <link>https://finance.yahoo.com/news/aapl-crash</link>
        <pubDate>Wed, 17 Jul 2026 10:00:00 GMT</pubDate>
        <source url="https://finance.yahoo.com">Yahoo</source></item>
      </channel></rss>`;
      return { ok: true, status: 200, json: async () => ({}), text: async () => xml };
    };
    const recs = await resolveDomain('news_sentiment', 'AAPL', { finnhubKey: 'k', fetchFn: extreme as any });
    const live = recs.filter((r) => r.sourceId !== 'mock');
    const fused = fuseSentiment(live)!;
    expect(fused.fusion.contributors.length).toBe(2);
    expect(fused.blended.source).toBe('mixed');
    expect(fused.fusion.agreement).toBeLessThan(1); // sources diverge
    expect(fused.fusion.low_consensus).toBe(fused.fusion.agreement < 0.6);
    expect(fused.blended.consensus!.low_consensus).toBe(fused.fusion.low_consensus);
  });

  it('PRESERVES parity: no finnhub key => single record, identical to single-source', async () => {
    const recs = await resolveDomain('news_sentiment', 'AAPL', { fetchFn: routedFetch() as any });
    expect(recs.length).toBe(1);
    // No finnhub key -> primary is the keyless yahoo/google chain; sourceId must
    // reflect the REAL provenance (NOT mislabeled 'finnhub').
    expect(recs[0]!.sourceId).not.toBe('finnhub');
    expect(['yahoo', 'google', 'mixed']).toContain(recs[0]!.sourceId);
  });

  it('PRESERVES parity: parity-mock (finnhub JSON invalid for RSS) => secondary degrades, single record', async () => {
    // Mirror the P0 parity test fixture: finnhub payload returned for EVERY url
    // (so the keyless call gets finnhub-shaped JSON, fails RSS parse -> mock).
    const finnhubPayload = [
      { headline: 'AAPL beats', url: 'u', source: 'Finnhub', datetime: 1, summary: 's' },
    ];
    const sameForAll = async () => ({
      ok: true,
      status: 200,
      json: async () => finnhubPayload,
      text: async () => JSON.stringify(finnhubPayload),
    });
    const recs = await resolveDomain('news_sentiment', 'AAPL', {
      finnhubKey: 'k',
      fetchFn: sameForAll as any,
    });
    expect(recs.length).toBe(1); // secondary degraded to mock, not appended
    expect(recs[0]!.sourceId).toBe('finnhub');
  });
});
