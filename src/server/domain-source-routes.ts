// src/server/domain-source-routes.ts
// P3b REST surface for the SWAPPABLE per-domain source mapping. Let an operator
// enable / disable / reorder the sources feeding each data domain from the
// Settings UI, persisted so it survives a restart.
//
// GET  /domain-sources        -> current override map (only domains the UI has
//                                 touched) + the resolved effective list per
//                                 domain + the available source ids per domain.
// POST /domain-sources        -> set one domain's enabled list, body:
//                                 { domain, sources: string[] }
// POST /domain-sources/reset  -> clear all UI overrides (revert to defaults)

import { Express } from 'express';
import { domainSourceConfigStore, type ConfigurableDomain } from './domain-source-config';
import { DOMAIN_SOURCES } from '../registry/analyst-config-schema';

const DOMAINS: ConfigurableDomain[] = [
  'price_bars',
  'option_chain',
  'news_sentiment',
  'fundamentals',
  'risk_free_rate',
  'market_meta',
];

export function registerDomainSourceRoutes(
  app: Express,
  store: typeof domainSourceConfigStore = domainSourceConfigStore,
): void {
  // Effective view: every domain with its available sources, the current
  // override (if any), and the resolved enabled list the engine will use.
  const effective = () => {
    const out: Record<
      string,
      { available: string[]; override: string[] | undefined; enabled: string[]; overridden: boolean }
    > = {};
    for (const d of DOMAINS) {
      out[d] = {
        available: (DOMAIN_SOURCES as Record<string, string[]>)[d] ?? [],
        override: store.isOverridden(d) ? store.get(d) : undefined,
        enabled: store.get(d),
        overridden: store.isOverridden(d),
      };
    }
    return out;
  };

  app.get('/domain-sources', (_req, res) => {
    res.status(200).json({ domains: effective(), overrides: store.all() });
  });

  app.post('/domain-sources', (req, res) => {
    const body = req.body as { domain?: string; sources?: unknown };
    const domain = body.domain as ConfigurableDomain | undefined;
    if (!domain || !DOMAINS.includes(domain)) {
      res.status(400).json({ error: `Unknown or missing domain: ${String(body.domain)}` });
      return;
    }
    if (!Array.isArray(body.sources) || !body.sources.every((s) => typeof s === 'string')) {
      res.status(400).json({ error: 'sources must be an array of source-id strings' });
      return;
    }
    // Validate each requested source is a known id for this domain (reorder /
    // subset allowed; unknown ids rejected to keep the engine honest).
    const available = (DOMAIN_SOURCES as Record<string, string[]>)[domain] ?? [];
    const requested = body.sources as string[];
    const unknown = requested.filter((s) => !available.includes(s));
    if (unknown.length > 0) {
      res.status(400).json({
        error: `Unknown source(s) for domain '${domain}': ${unknown.join(', ')}`,
        available,
      });
      return;
    }
    store.set(domain, requested);
    res.status(200).json({ ok: true, domain, enabled: store.get(domain) });
  });

  app.post('/domain-sources/reset', (_req, res) => {
    store.reset();
    res.status(200).json({ ok: true, domains: effective() });
  });
}
