// src/tests/fuse.test.ts
// P2a acceptance tests for the multi-source fusion engine (fuse.ts).
// The CORE "weigh ALL sources" contract: weighted blend + honest consensus.

import { describe, it, expect } from '@jest/globals';
import { fuseNumeric, fuseSentiment } from '../registry/logic/fuse';
import { mkRecord } from '../registry/types/domains';
import type { NewsResult } from '../registry/logic/news';

// helper: a news_sentiment record with a given source id + score + confidence
function sent(sourceId: string, score: number, confidence = 1): ReturnType<typeof mkRecord<NewsResult>> {
  const data: NewsResult = {
    ticker: 'TEST',
    headlines: [
      { title: `${sourceId} headline`, url: '', source: sourceId, timestamp: new Date(score * 1000 + 1_700_000_000_000).toISOString(), sentiment: 'NEUTRAL', score },
    ],
    sentiment_score: score,
    sentiment_label: 'NEUTRAL',
    source: sourceId as NewsResult['source'],
  };
  return mkRecord<NewsResult>(sourceId, confidence > 0 ? 'ok' : 'fallback', data, confidence);
}

describe('fuseNumeric — weighted blend', () => {
  it('single live source => value passes through unchanged (parity invariant)', () => {
    const r = fuseNumeric([sent('finnhub', 40)], { extract: (x) => x.data.sentiment_score });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(40);
    expect(r.agreement).toBe(1);
    expect(r.low_consensus).toBe(false);
    expect(r.contributors).toEqual(['finnhub']);
  });

  it('equal weights => arithmetic mean', () => {
    const r = fuseNumeric([sent('finnhub', 40), sent('yahoo', 60)], { extract: (x) => x.data.sentiment_score });
    expect(r.value).toBe(50);
    expect(r.contributors.sort()).toEqual(['finnhub', 'yahoo']);
  });

  it('configured weights bias the blend toward the heavier source', () => {
    const r = fuseNumeric([sent('finnhub', 40), sent('yahoo', 60)], {
      extract: (x) => x.data.sentiment_score,
      weights: { finnhub: 3, yahoo: 1 }, // 0.75*40 + 0.25*60 = 45
    });
    expect(r.value).toBe(45);
  });

  it('confidence gates influence: a mock (confidence 0) source contributes nothing', () => {
    const r = fuseNumeric([sent('finnhub', 40, 1), sent('yahoo', 90, 0)], {
      extract: (x) => x.data.sentiment_score,
    });
    // yahoo confidence 0 => excluded => value is finnhub alone
    expect(r.value).toBe(40);
    expect(r.contributors).toEqual(['finnhub']);
  });

  it('confidence scales effective weight when both are live-but-uneven', () => {
    // finnhub w1*conf1 = 1 ; yahoo w1*conf0.5 = 0.5 ; norm => 0.667*30 + 0.333*90 = 50
    const r = fuseNumeric([sent('finnhub', 30, 1), sent('yahoo', 90, 0.5)], {
      extract: (x) => x.data.sentiment_score,
    });
    expect(r.value).toBeCloseTo(50, 6);
  });

  it('no usable source => ok:false so caller keeps its own fallback', () => {
    const r = fuseNumeric([sent('finnhub', 40, 0), sent('yahoo', 60, 0)], {
      extract: (x) => x.data.sentiment_score,
    });
    expect(r.ok).toBe(false);
    expect(r.contributors).toEqual([]);
  });
});

describe('fuseNumeric — consensus', () => {
  it('close values => high agreement, no low_consensus flag', () => {
    const r = fuseNumeric([sent('finnhub', 48), sent('yahoo', 52)], {
      extract: (x) => x.data.sentiment_score,
      scale: 100,
    });
    // dispersion = 0.5*|48-50| + 0.5*|52-50| = 2 ; agreement = 1 - 2/100 = 0.98
    expect(r.agreement).toBeCloseTo(0.98, 6);
    expect(r.low_consensus).toBe(false);
  });

  it('DIVERGENT sources => low agreement => low_consensus flagged + honest note', () => {
    // finnhub bullish +80, yahoo bearish -60 => blend 10, dispersion 70 => agreement 0.30
    const r = fuseNumeric([sent('finnhub', 80), sent('yahoo', -60)], {
      extract: (x) => x.data.sentiment_score,
      scale: 100,
      consensusThreshold: 0.7,
    });
    expect(r.value).toBe(10);
    expect(r.agreement).toBeCloseTo(0.3, 6);
    expect(r.low_consensus).toBe(true);
    expect(r.note).toMatch(/low consensus/i);
  });
});

describe('fuseSentiment — domain wrapper (the acceptance test)', () => {
  it('blends divergent Finnhub + Yahoo into one NewsResult with low_consensus note', () => {
    const res = fuseSentiment([sent('finnhub', 80), sent('yahoo', -60)], { consensusThreshold: 0.7 });
    expect(res).not.toBeNull();
    const { blended, fusion } = res!;
    // weighted (equal) blend of 80 & -60 => 10
    expect(blended.sentiment_score).toBe(10);
    expect(blended.source).toBe('mixed');
    // headlines from BOTH providers are present
    expect(blended.headlines.length).toBe(2);
    // note is HONEST: shows each source's score AND the consensus verdict
    expect(blended.note).toMatch(/finnhub=80/);
    expect(blended.note).toMatch(/yahoo=-60/);
    expect(blended.note).toMatch(/low consensus/i);
    expect(fusion.low_consensus).toBe(true);
    expect(fusion.contributors.sort()).toEqual(['finnhub', 'yahoo']);
  });

  it('single source => passthrough (byte-parity with P0/P1 single-source path)', () => {
    const single = sent('finnhub', 42);
    const res = fuseSentiment([single]);
    expect(res).not.toBeNull();
    expect(res!.blended).toBe(single.data); // same object, untouched
    expect(res!.fusion.contributors).toEqual(['finnhub']);
  });

  it('all sources mock (confidence 0) => still returns the seeded record, not null', () => {
    const res = fuseSentiment([sent('finnhub', 50, 0)]);
    expect(res).not.toBeNull();
    expect(res!.blended.sentiment_score).toBe(50);
  });

  it('contributions expose per-source share for the trace drawer', () => {
    const res = fuseSentiment([sent('finnhub', 40), sent('yahoo', 60)]);
    const c = res!.fusion.contributions;
    expect(c.map((x) => x.sourceId).sort()).toEqual(['finnhub', 'yahoo']);
    expect(c.reduce((s, x) => s + x.effectiveWeight, 0)).toBeCloseTo(1, 6);
    expect(c.reduce((s, x) => s + x.contribution, 0)).toBeCloseTo(50, 6);
  });
});
