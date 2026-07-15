// frontend/src/components/analysts/AgencyReorgDialog.tsx
// Per-agency re-org dialog (Phase 1). Opened from the [re-org] button in
// AgencySettingsDialog. Lets the user add / remove / reorder the analysts that
// make up the agency's flow, and wire "feeds into" (which later analysts depend
// on a re-orged one). Saves via PUT /registry/agency/:id; on success it mutates
// the frontend AGENCIES mirror and calls onSaved so the wall re-renders live.

import { useState, useEffect } from 'react';
import {
  getRegistry,
  putAgencyAnalysts,
} from '../../api/registryClient';
import { AGENCIES, DEFAULT_AGENCY } from './agencies';
import type { AgencyAnalystRef, AnalystDef } from '../../../../src/types/registry';

export interface AgencyReorgDialogProps {
  open: boolean;
  onClose: () => void;
  agencyId: string;
  agencyName: string;
  userId?: string;
  /** Called after a successful save with the new ordered analyst ids. */
  onSaved?: (agencyId: string, analystIds: string[]) => void;
}

interface Row {
  id: string;
  name: string;
  kind?: string;
}

export function AgencyReorgDialog({
  open,
  onClose,
  agencyId,
  agencyName,
  userId = 'default',
  onSaved,
}: AgencyReorgDialogProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [catalog, setCatalog] = useState<AnalystDef[]>([]);
  const [feedInto, setFeedInto] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    setFeedInto({});
    // Seed rows from the current frontend mirror IMMEDIATELY (synchronous),
    // so a transient /registry fetch failure can never blank the roster. Names
    // are enriched once the catalog arrives below.
    // NOTE: the frontend AGENCIES mirror stores analysts as string[] (not
    // AgencyAnalystRef objects) — mirror the id string directly.
    const ids = AGENCIES[agencyId]?.analysts ?? [];
    setRows(ids.map((id) => ({ id, name: id, kind: undefined })));
    getRegistry(userId)
      .then((data) => {
        setCatalog(data.catalog);
        const map = new Map(data.catalog.map((a) => [a.id, a]));
        // Enrich the already-seeded rows with display names/kinds.
        setRows((prev) =>
          prev.map((r) => ({
            ...r,
            name: map.get(r.id)?.name ?? r.name,
            kind: map.get(r.id)?.kind,
          })),
        );
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [open, agencyId, userId]);

  if (!open) return null;

  const move = (idx: number, dir: -1 | 1) => {
    setRows((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };
  const remove = (idx: number) => {
    setRows((prev) => {
      const removed = prev[idx];
      const next = prev.filter((_, i) => i !== idx);
      // Drop any feedInto wiring that referenced the removed analyst.
      if (removed) {
        setFeedInto((fi) => {
          const copy: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(fi)) {
            copy[k] = v.filter((c) => c !== removed.id);
          }
          delete copy[removed.id];
          return copy;
        });
      }
      return next;
    });
  };
  const add = (id: string) => {
    setRows((prev) => {
      if (prev.some((r) => r.id === id)) return prev;
      const def = catalog.find((a) => a.id === id);
      return [...prev, { id, name: def?.name ?? id, kind: def?.kind }];
    });
  };

  const toggleFeedConsumer = (producer: string, consumer: string) => {
    setFeedInto((fi) => {
      const cur = fi[producer] ?? [];
      const next = cur.includes(consumer)
        ? cur.filter((c) => c !== consumer)
        : [...cur, consumer];
      return { ...fi, [producer]: next };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const analysts: AgencyAnalystRef[] = rows.map((r) => ({ id: r.id }));
    try {
      await putAgencyAnalysts(agencyId, { analysts, feedInto }, userId);
      // Live-update the frontend mirror so the wall reflects the new flow now.
      // The frontend mirror stores analysts as string[], so mirror the ids.
      if (AGENCIES[agencyId]) {
        AGENCIES[agencyId].analysts = rows.map((r) => r.id);
      }
      onSaved?.(agencyId, rows.map((r) => r.id));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const available = catalog.filter((a) => !rows.some((r) => r.id === a.id));
  const isDefault = agencyId === DEFAULT_AGENCY;

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label={`Re-organize ${agencyName}`} onClick={onClose}>
      <div className="settings-panel reorg-panel" onClick={(e) => e.stopPropagation()}>
        <h2>Re-organize {agencyName}</h2>
        <p className="settings-hint">
          Add, remove, or reorder the analysts in this agency&rsquo;s flow. Changes apply to the
          next run and are saved per user.
        </p>

        <ul className="reorg-list">
          {rows.map((r, idx) => (
            <li key={r.id} className="reorg-row" data-testid={`reorg-row-${r.id}`}>
              <div className="reorg-row-main">
                <span className="reorg-order">{idx + 1}</span>
                <span className="reorg-name">{r.name}</span>
                <span className="reorg-kind">{r.kind}</span>
                <button type="button" className="reorg-up" aria-label={`Move ${r.name} up`} data-testid={`reorg-up-${r.id}`} disabled={idx === 0} onClick={() => move(idx, -1)}>↑</button>
                <button type="button" className="reorg-down" aria-label={`Move ${r.name} down`} data-testid={`reorg-down-${r.id}`} disabled={idx === rows.length - 1} onClick={() => move(idx, 1)}>↓</button>
                <button type="button" className="reorg-del" aria-label={`Remove ${r.name}`} data-testid={`reorg-remove-${r.id}`} onClick={() => remove(idx)}>✕</button>
              </div>

              {r.id !== 'orchestrator' && r.id !== 'data_ingestion' && (
                <details className="reorg-feed">
                  <summary className="reorg-feed-label">feeds into</summary>
                  <div className="reorg-feed-opts">
                    {catalog
                      .filter((c) => c.id !== r.id && c.id !== 'orchestrator' && c.id !== 'data_ingestion')
                      .map((c) => (
                        <label key={c.id} className="reorg-feed-opt">
                          <input
                            type="checkbox"
                            checked={(feedInto[r.id] ?? []).includes(c.id)}
                            onChange={() => toggleFeedConsumer(r.id, c.id)}
                          />
                          {c.name}
                        </label>
                      ))}
                  </div>
                </details>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="reorg-empty">No analysts in this flow.</li>}
        </ul>

        {available.length > 0 && (
          <fieldset className="reorg-add">
            <legend>Add analyst</legend>
            <select
              aria-label="Add analyst to flow"
              data-testid="reorg-add-select"
              value=""
              onChange={(e) => { if (e.target.value) add(e.target.value); }}
            >
              <option value="">+ add…</option>
              {available.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </fieldset>
        )}

        {isDefault && (
          <p className="settings-hint">This is the default agency; its membership can still be re-organized.</p>
        )}

        {error && <p className="settings-error" role="alert">{error}</p>}

        <div className="settings-actions">
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" data-testid="reorg-save" onClick={handleSave} disabled={saving || rows.length === 0}>
            {saving ? 'Saving…' : 'Save flow'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AgencyReorgDialog;
