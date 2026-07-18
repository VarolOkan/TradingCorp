// frontend/src/components/analysts/DomainSourcesTab.tsx
// P3b — UI for the SWAPPABLE per-domain source mapping. For each data domain,
// shows the available sources as toggleable chips; the user enables / disables
// and reorders them. Saving POSTs the ordered enabled list to /domain-sources,
// which the engine reads on the next analysis run (resolveDomain ->
// DomainSourceConfigStore).
//
// Semantic-honesty bar: a domain with ZERO sources enabled is shown as
// "degraded" with an honest note — never a false "live" badge. The same
// contract as the backend: clearing every source degrades THAT domain only, not
// the whole pipeline.

import { forwardRef, useImperativeHandle, useEffect, useState } from 'react';
import {
  getDomainSources,
  setDomainSources,
  resetDomainSources,
  type DomainSourcesResponse,
  type DomainSourceView,
} from '../../api/domainSourceClient';

/** Human-readable domain labels (mirror backend DOMAIN_SOURCES keys). */
const DOMAIN_LABELS: Record<string, string> = {
  price_bars: 'Price bars',
  option_chain: 'Option chain',
  news_sentiment: 'News sentiment',
  fundamentals: 'Fundamentals',
  risk_free_rate: 'Risk-free rate',
  market_meta: 'Market meta',
};

export interface DomainSourcesTabHandle {
  save: () => Promise<boolean>;
}

export interface DomainSourcesTabProps {
  sessionId?: string;
  onSaved?: () => void;
}

/** Toggle membership of `id` in an ordered list, preserving order for kept ids. */
function toggleInList(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export const DomainSourcesTab = forwardRef<DomainSourcesTabHandle, DomainSourcesTabProps>(
  function DomainSourcesTab({ onSaved }, ref) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [data, setData] = useState<Record<string, DomainSourceView> | null>(null);
    // Local working copy: domain -> ordered enabled source ids.
    const [draft, setDraft] = useState<Record<string, string[]>>({});
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res: DomainSourcesResponse = await getDomainSources();
        setData(res.domains);
        // Seed the draft from the engine's CURRENT enabled list per domain.
        // Defensive: a domain missing `enabled` must not crash the render.
        const seed: Record<string, string[]> = {};
        for (const [d, v] of Object.entries(res.domains)) {
          seed[d] = Array.isArray(v?.enabled) ? v.enabled.slice() : [];
        }
        setDraft(seed);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => {
      void load();
    }, []);

    const orderUp = (domain: string, id: string) => {
      const list = draft[domain] ?? [];
      const i = list.indexOf(id);
      if (i <= 0) return;
      const next = list.slice();
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      setDraft((p) => ({ ...p, [domain]: next }));
    };
    const orderDown = (domain: string, id: string) => {
      const list = draft[domain] ?? [];
      const i = list.indexOf(id);
      if (i < 0 || i >= list.length - 1) return;
      const next = list.slice();
      [next[i + 1], next[i]] = [next[i], next[i + 1]];
      setDraft((p) => ({ ...p, [domain]: next }));
    };

    const isEnabled = (domain: string, id: string) => (draft[domain] ?? []).includes(id);
    const enabledCount = (domain: string) => (draft[domain] ?? []).length;

    useImperativeHandle(ref, () => ({
      async save() {
        setSaving(true);
        setError(null);
        setSaved(false);
        try {
          // Persist every domain's draft list (subset = sources left enabled).
          for (const [domain, list] of Object.entries(draft)) {
            await setDomainSources(domain, list);
          }
          setSaved(true);
          onSaved?.();
          return true;
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          return false;
        } finally {
          setSaving(false);
        }
      },
    }));

    if (loading) return <p className="settings-hint">Loading domain source mapping…</p>;
    if (error && !data) return <p className="settings-error" role="alert">{error}</p>;
    if (!data) return null;

    const dirty = Object.keys(data).some((d) => {
      const cur = data[d]?.enabled ?? [];
      const next = draft[d] ?? [];
      return cur.length !== next.length || cur.some((s, i) => s !== next[i]);
    });

    return (
      <div className="domain-sources-tab">
        <p className="settings-hint">
          Choose which data sources feed each domain and in what order. Disabling a
          source removes it from the next analysis run. Clearing <em>every</em> source
          for a domain degrades <em>that</em> domain (shown as “skipped”) — it does not
          break the rest of the pipeline. Changes apply on the next run.
        </p>
        {error && <p className="settings-error" role="alert">{error}</p>}
        {Object.entries(data).map(([domain, view]) => {
          const view0 = view ?? ({} as DomainSourceView);
          const available = Array.isArray(view0.available) ? view0.available : [];
          const enabled = draft[domain] ?? [];
          const degraded = enabled.length === 0;
          return (
            <fieldset key={domain} className="settings-group" disabled={saving}>
              <legend>
                {DOMAIN_LABELS[domain] ?? domain}
                {view0.overridden && (
                  <span className="source-chip" aria-label="customized">custom</span>
                )}
                {degraded && (
                  <span
                    className="source-chip degraded"
                    data-testid={`domain-degraded-${domain}`}
                    aria-label={`${domain} degraded`}
                  >
                    degraded
                  </span>
                )}
              </legend>
              {degraded && (
                <p className="settings-warn" role="status">
                  ⚠ All sources disabled — this domain will be skipped on the next run
                  (honest degrade, not an error). Re-enable a source to restore it.
                </p>
              )}
              <div className="domain-source-list">
                {available.map((src) => {
                  const on = isEnabled(domain, src);
                  const order = enabled.indexOf(src);
                  return (
                    <div key={src} className="domain-source-row">
                      <label className="domain-source-toggle">
                        <input
                          type="checkbox"
                          checked={on}
                          aria-label={`Toggle ${src} for ${domain}`}
                          onChange={() =>
                            setDraft((p) => ({
                              ...p,
                              [domain]: toggleInList(p[domain] ?? [], src),
                            }))
                          }
                        />
                        <span>{src}</span>
                      </label>
                      {on && (
                        <span className="domain-source-order">
                          <button
                            type="button"
                            className="link-btn"
                            aria-label={`Move ${src} up`}
                            disabled={order <= 0}
                            onClick={() => orderUp(domain, src)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="link-btn"
                            aria-label={`Move ${src} down`}
                            disabled={order >= enabled.length - 1}
                            onClick={() => orderDown(domain, src)}
                          >
                            ↓
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="settings-hint">
                {enabledCount(domain)} of {available.length} enabled
                {enabledCount(domain) > 0 && (
                  <> · order: {enabled.join(' › ')}</>
                )}
              </p>
            </fieldset>
          );
        })}
        <div className="settings-actions">
          <button
            type="button"
            className="link-btn"
            disabled={saving}
            onClick={async () => {
              setError(null);
              try {
                const res = await resetDomainSources();
                setData(res.domains);
                const seed: Record<string, string[]> = {};
                for (const [d, v] of Object.entries(res.domains)) seed[d] = v.enabled.slice();
                setDraft(seed);
                setSaved(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Reset to defaults
          </button>
        </div>
        {saved && dirty === false && (
          <p className="settings-saved" role="status">Saved — applies to the next analysis run</p>
        )}
        {saved && dirty && (
          <p className="settings-warn" role="status">Saved</p>
        )}
      </div>
    );
  },
);
