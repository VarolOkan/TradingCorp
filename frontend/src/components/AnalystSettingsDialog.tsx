// frontend/src/components/AnalystSettingsDialog.tsx
// Per-card Settings panel (docs/EXTENDING_ANALYSTS.md).
//
// Shown when the user clicks the gear on an analyst card. Renders ONLY the
// items that analyst can actually adjust (from its AnalystConfigSchema):
//   - tunable WEIGHTS (signalSensitivity / maxLookbackDays / maxStopLoss / baseAllocation)
//   - credentialed SOURCES, each with a token + a base URI
// If the schema has nothing (hasConfig === false), the gear is never shown, so
// this dialog is only ever opened for configurable analysts.
//
// Saving: weights are POSTed to /analyst-params; each source token+URI is
// POSTed to /analyst-config (URI carried in `extra.uri`). Nothing is echoed
// back or stored in the client bundle beyond the in-memory "configured" flags.

import { useState, useEffect, useRef } from 'react';
import type { AnalystConfigSchema } from './analysts/analystConfigSchema';
import { SourcesTab, type SourcesTabHandle } from './analysts/SourcesTab';
import { postAnalystParams, getAnalystParams } from '../api/analystParamsClient';
import { getAnalystFlavors, postAnalystFlavors } from '../api/analystFlavorsClient';
import type { AnalystFlavorDTO } from '../api/analystFlavorsClient';

export interface AnalystSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** The analyst being configured. */
  analystId: string;
  analystName: string;
  /** Agency currently selected (params are scoped per agency). */
  agencyId: string;
  schema: AnalystConfigSchema;
  sessionId: string;
  /** Called after a successful save so the parent can refresh/re-run. */
  onSaved?: (analystId: string) => void;
  /**
   * Called specifically after a FLAVOR save (Role & Instructions), so the
   * parent can re-fetch the live flavor set and the trace drawer reflects the
   * edit immediately (without a re-run). Distinct from onSaved so we don't
   * force a re-run of the whole analysis.
   */
  onFlavorSaved?: (analystId: string) => void;
}

type TabId = 'sources' | 'flavor' | 'weights';

export function AnalystSettingsDialog({
  open,
  onClose,
  analystId,
  analystName,
  agencyId,
  schema,
  sessionId,
  onSaved,
  onFlavorSaved,
}: AnalystSettingsDialogProps) {
  const [weights, setWeights] = useState<Record<string, number>>({});
  // Ref to the shared SourcesTab so the dialog's single Save button can commit
  // the source credentials (token + Base URI) through the GPG-persisting path.
  const sourcesRef = useRef<SourcesTabHandle>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Phase F/§10.6: the analyst's full editable flavor set (loaded from GET
  // /analyst-flavors) + the selected flavor id. Editing name/role/instructions,
  // adding a draft, and deleting (≥1 guard) all operate on this list; Save posts
  // the full set back to POST /analyst-flavors.
  const [flavors, setFlavors] = useState<AnalystFlavorDTO[]>([]);
  const [selectedFlavorId, setSelectedFlavorId] = useState<string | null>(null);
  const [flavorsLoading, setFlavorsLoading] = useState(false);
  // Phase H: unified dialog tabs — only the sections this analyst actually
  // supports are shown (mirrors the main Settings dialog's [Connection]/
  // [LLM Models] pattern). Default to the most interesting tab (flavor).
  // `schema` may be an empty stub when the dialog is closed, so read the
  // arrays defensively.
  const srcLen = schema.sources?.length ?? 0;
  const flvLen = schema.flavors?.length ?? 0;
  const wgtLen = schema.weights?.length ?? 0;
  const availableTabs = [
    srcLen > 0 ? 'sources' : null,
    flvLen > 0 ? 'flavor' : null,
    wgtLen > 0 ? 'weights' : null,
  ].filter(Boolean) as TabId[];
  const [tab, setTab] = useState<TabId>('flavor');
  const activeTab = availableTabs.includes(tab) ? tab : availableTabs[0];

  // Initialize form state whenever the dialog opens for an analyst.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaved(false);
    setSaving(false);
    setTab('flavor');
    const initialWeights: Record<string, number> = {};
    for (const w of schema.weights) initialWeights[w.key] = w.default;
    setWeights(initialWeights);
    setFlavors([]);
    setSelectedFlavorId(null);

    // Phase F/§10.6: load the analyst's FULL flavor set (with instructions) so
    // the user can edit / add / delete, not just select.
    if (schema.flavors.length > 0) {
      setFlavorsLoading(true);
      getAnalystFlavors(sessionId, agencyId, analystId)
        .then((data) => {
          setFlavors(data.flavors.map((f) => ({ ...f })));
          setSelectedFlavorId(data.selectedId);
        })
        .catch(() => {
          /* non-fatal: fall back to no flavor editing */
        })
        .finally(() => setFlavorsLoading(false));
    }

    // Load any previously saved weights so the user edits the current value.
    if (schema.weights.length > 0) {
      getAnalystParams(sessionId, agencyId)
        .then((data) => {
          const saved = data.params[analystId];
          if (saved) setWeights((prev) => ({ ...prev, ...saved }));
        })
        .catch(() => {
          /* non-fatal: keep defaults */
        });
    }
  }, [open, analystId, agencyId, sessionId, schema]);

  if (!open) return null;

  const setWeight = (key: string, value: number) =>
    setWeights((prev) => ({ ...prev, [key]: value }));

  // ── §10.6 flavor CRUD helpers ──────────────────────────────────────────────
  // Edit a field of the currently selected flavor.
  const updateSelectedFlavor = (
    field: 'name' | 'role' | 'instructions' | 'enabled',
    value: string | boolean,
  ) =>
    setFlavors((prev) =>
      prev.map((f) => (f.id === selectedFlavorId ? { ...f, [field]: value } : f)),
    );

  // Add a new editable draft flavor and select it (§10.4: new flavor is
  // immediately selectable; ids are unique).
  const addFlavor = () => {
    const base = 'custom';
    let n = 1;
    const existing = new Set(flavors.map((f) => f.id));
    while (existing.has(`${base}-${n}`)) n += 1;
    const id = `${base}-${n}`;
    const draft: AnalystFlavorDTO = {
      id,
      name: `New flavor ${n}`,
      role: '',
      instructions: '',
      isDefault: false,
      enabled: false,
    };
    setFlavors((prev) => [...prev, draft]);
    setSelectedFlavorId(id);
  };

  // Delete the selected flavor (§10.4: refuse to delete the last one; deleting
  // the selected flavor resets selection to the default flavor).
  const deleteSelectedFlavor = () => {
    if (flavors.length <= 1 || !selectedFlavorId) return;
    const remaining = flavors.filter((f) => f.id !== selectedFlavorId);
    setFlavors(remaining);
    const fallback = remaining.find((f) => f.isDefault) ?? remaining[0];
    setSelectedFlavorId(fallback ? fallback.id : null);
  };

  const selectedFlavor = flavors.find((f) => f.id === selectedFlavorId) ?? null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // 1) Save weights (if any).
      if (schema.weights.length > 0) {
        await postAnalystParams({
          sessionId,
          agencyId,
          analystId,
          params: { ...weights },
        });
      }
      // 2) Save each source token + URI through the shared SourcesTab, which
      //    POSTs to /analyst-config (the GPG-persisting path). Triggered here,
      //    from the dialog's single Save button, so there is exactly one save
      //    action across the per-analyst and global Settings dialogs.
      if (schema.sources.length > 0) {
        const ok = await sourcesRef.current?.save();
        if (ok === false) return; // surface the error and stop the save chain
      }
      // instructions — so we post the user's real edits, not placeholders.
      if (schema.flavors.length > 0 && flavors.length > 0 && selectedFlavorId) {
        const flavorsForPost = flavors.map((f) => ({
          id: f.id,
          name: f.name.trim() || f.id,
          role: f.role,
          instructions: f.instructions,
          isDefault: f.isDefault === true,
          enabled: f.enabled === true,
        }));
        // Guarantee exactly one default (fall back to the selected, else first).
        if (!flavorsForPost.some((f) => f.isDefault)) {
          const anchor =
            flavorsForPost.find((f) => f.id === selectedFlavorId) ?? flavorsForPost[0];
          if (anchor) anchor.isDefault = true;
        }
        await postAnalystFlavors({
          sessionId,
          agencyId,
          analystId,
          flavors: flavorsForPost,
          selectedId: selectedFlavorId,
        });
        // Phase I: re-fetch the live flavor set so the trace drawer shows the
        // edited Role & Instructions IMMEDIATELY (no re-run needed).
        onFlavorSaved?.(analystId);
      }
      setSaved(true);
      onSaved?.(analystId);
      setTimeout(() => onClose(), 450);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Configure ${analystName}`}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="settings-panel">
        <h2>{analystName} · Settings</h2>
        <p className="settings-sub">
          Adjust only what this analyst supports. Saved settings apply to the next run for the{' '}
          <code>{agencyId}</code> agency.
        </p>

        <form onSubmit={handleSubmit}>
          {availableTabs.length > 0 && (
            <div className="settings-tabs" role="tablist" aria-label={`${analystName} settings`}>
              {availableTabs.includes('flavor') && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'flavor'}
                  className={activeTab === 'flavor' ? 'settings-tab active' : 'settings-tab'}
                  data-testid="tab-flavor"
                  onClick={() => setTab('flavor')}
                >
                  Role &amp; Instructions
                </button>
              )}
              {availableTabs.includes('sources') && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'sources'}
                  className={activeTab === 'sources' ? 'settings-tab active' : 'settings-tab'}
                  data-testid="tab-sources"
                  onClick={() => setTab('sources')}
                >
                  Sources
                </button>
              )}
              {availableTabs.includes('weights') && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'weights'}
                  className={activeTab === 'weights' ? 'settings-tab active' : 'settings-tab'}
                  data-testid="tab-weights"
                  onClick={() => setTab('weights')}
                >
                  Weights
                </button>
              )}
            </div>
          )}

          {activeTab === 'weights' && schema.weights.length > 0 && (
            <fieldset className="settings-group">
              <legend>Weights</legend>
              {schema.weights.map((w) => (
                <label key={w.key} className="settings-field">
                  <span>
                    {w.label}
                    {w.hint && <small className="field-hint">{w.hint}</small>}
                  </span>
                  <input
                    type="number"
                    value={weights[w.key] ?? w.default}
                    min={w.min}
                    max={w.max}
                    step={w.step}
                    onChange={(e) => setWeight(w.key, Number(e.target.value))}
                    aria-label={w.label}
                  />
                </label>
              ))}
            </fieldset>
          )}

          {activeTab === 'flavor' && schema.flavors.length > 0 && (
            <fieldset className="settings-group">
              <legend>Flavor (Role &amp; Instructions)</legend>
              <p className="settings-hint flavor-hint">
                Edits save to the server and take effect on the <strong>next analysis
                run</strong> for the <code>{agencyId}</code> agency — re-running the
                analysis refreshes the analyst's Role &amp; Instructions in its trace.
              </p>
              <label className="settings-field">
                <span>Active flavor</span>
                <select
                  value={selectedFlavorId ?? ''}
                  onChange={(e) => setSelectedFlavorId(e.target.value)}
                  aria-label={`${analystName} flavor`}
                  disabled={flavorsLoading || flavors.length === 0}
                >
                  {flavors.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                      {f.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flavor-actions">
                <button
                  type="button"
                  className="flavor-add"
                  onClick={addFlavor}
                  disabled={flavorsLoading}
                >
                  + Add flavor
                </button>
                <button
                  type="button"
                  className="flavor-delete"
                  onClick={deleteSelectedFlavor}
                  disabled={flavorsLoading || flavors.length <= 1 || !selectedFlavorId}
                  title={flavors.length <= 1 ? 'An analyst must keep at least one flavor' : 'Delete this flavor'}
                >
                  Delete flavor
                </button>
              </div>

              {selectedFlavor && (
                <div className="flavor-editor">
                  <label className="settings-field">
                    <span>Name</span>
                    <input
                      type="text"
                      value={selectedFlavor.name}
                      onChange={(e) => updateSelectedFlavor('name', e.target.value)}
                      aria-label="Flavor name"
                    />
                  </label>
                  <label className="settings-field">
                    <span>Role (short summary)</span>
                    <input
                      type="text"
                      value={selectedFlavor.role}
                      onChange={(e) => updateSelectedFlavor('role', e.target.value)}
                      aria-label="Flavor role"
                      placeholder="e.g. Skew · term structure · IV rank"
                    />
                  </label>
                  <label className="settings-field">
                    <span>Instructions</span>
                    <textarea
                      className="flavor-instructions"
                      value={selectedFlavor.instructions}
                      onChange={(e) => updateSelectedFlavor('instructions', e.target.value)}
                      aria-label="Flavor instructions"
                      rows={10}
                      placeholder="ROLE / OBJECTIVE / METHOD / OUTPUT CONTRACT / SCORING …"
                    />
                    <small className="field-hint">
                      This is the Role &amp; Instructions the LLM runs for this flavor. Must be non-empty to save.
                    </small>
                  </label>
                  <label className="settings-field flavor-default-toggle">
                    <span>Default flavor</span>
                    <input
                      type="checkbox"
                      checked={selectedFlavor.isDefault === true}
                      onChange={(e) =>
                        setFlavors((prev) =>
                          prev.map((f) => ({
                            ...f,
                            // Exactly one default: set the selected, clear the rest.
                            isDefault: e.target.checked
                              ? f.id === selectedFlavorId
                              : f.id === selectedFlavorId
                                ? false
                                : f.isDefault,
                          })),
                        )
                      }
                      aria-label="Mark this flavor as the default"
                    />
                  </label>
                  <label className="settings-field flavor-llm-toggle">
                    <span>Use LLM for this flavor</span>
                    <input
                      type="checkbox"
                      checked={selectedFlavor.enabled === true}
                      onChange={(e) => updateSelectedFlavor('enabled', e.target.checked)}
                      aria-label="Enable the LLM analysis step for this flavor"
                    />
                  </label>
                  <p className="flavor-llm-hint">
                    When on (and a provider token is set in Settings → LLM Models), the LLM
                    reads these instructions and performs the analysis, replacing this
                    analyst&apos;s computed verdict. Off keeps the static verdict (parity).
                  </p>
                </div>
              )}
            </fieldset>
          )}

          {activeTab === 'sources' && schema.sources.length > 0 && (
            <SourcesTab
              ref={sourcesRef}
              analystId={analystId}
              sessionId={sessionId}
              sources={schema.sources}
              onSaved={onSaved}
            />
          )}

          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
          {saved && (
            <p className="settings-saved" role="status">
              Saved — applies to the next analysis run for {agencyId}
            </p>
          )}

          <div className="settings-actions">
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AnalystSettingsDialog;
