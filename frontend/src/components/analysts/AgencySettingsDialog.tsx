// frontend/src/components/analysts/AgencySettingsDialog.tsx
// Per-agency settings dialog. Opened from the ⚙ button next to the Agency
// dropdown. Currently hosts the "Default model for this agency" control that
// used to live in the main SettingsDialog LLM tab (§12.4.1) — moved here so the
// agency-scoped setting has an agency-scoped home.
//
// The "Accept" button saves the form and closes the dialog. It POSTs ONLY the
// per-agency override (configs: [] → the server skips the 3 role configs and
// just stores agencyModelRole for this session:agency).

import { useState, useEffect, FormEvent } from 'react';
import { getLlmConfig, postLlmConfig } from '../../api/llmConfigClient';
import { enableLlmForAllAnalysts, getAgencyFlavorSummary } from '../../api/analystFlavorsClient';
import AgencyReorgDialog from './AgencyReorgDialog';
import type { LlmRole } from '../../../../src/server/llm-config';

export interface AgencySettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Agency the settings apply to. */
  agencyId: string;
  /** Human-readable agency name for the dialog title. */
  agencyName: string;
  /** Session id for GET/POST /llm-config. */
  sessionId?: string;
  /** Test seam — called after a successful save. */
  onSaved?: (agencyModelRole: LlmRole | null) => void;
  /** Called after a re-org save so the wall/dropdown re-render live. */
  onRegistryChange?: () => void;
}

export function AgencySettingsDialog({
  open,
  onClose,
  agencyId,
  agencyName,
  sessionId = 'default',
  onSaved,
  onRegistryChange,
}: AgencySettingsDialogProps) {
  const [agencyModelRole, setAgencyModelRole] = useState<LlmRole | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // §10.7 — reflect the stored LLM opt-in state so the dialog visibly shows the
  // persisted "Enable LLM for all analysts" flag (not just blind buttons).
  const [llmEnabledCount, setLlmEnabledCount] = useState<number | null>(null);
  const [llmTotal, setLlmTotal] = useState<number | null>(null);
  // Re-org dialog open state.
  const [reorgOpen, setReorgOpen] = useState(false);

  // Load the current per-agency override + LLM opt-in summary each time the
  // dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    setLlmEnabledCount(null);
    setLlmTotal(null);
    getLlmConfig(sessionId, agencyId)
      .then((data) => setAgencyModelRole((data.agencyModelRole ?? '') as LlmRole | ''))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    getAgencyFlavorSummary(sessionId, agencyId)
      .then((s) => {
        setLlmEnabledCount(s.enabledCount);
        setLlmTotal(s.total);
      })
      .catch(() => {
        /* non-fatal: indicator simply stays blank */
      });
  }, [open, sessionId, agencyId]);

  if (!open) return null;

  const handleBulkEnable = async (enabled: boolean) => {
    setBulkBusy(true);
    setBulkMsg(null);
    setError(null);
    try {
      const res = await enableLlmForAllAnalysts(sessionId, agencyId, enabled);
      setBulkMsg(
        `LLM ${enabled ? 'enabled' : 'disabled'} for all ${res.analystsTouched} analysts in ${agencyName} ` +
          `(next run applies).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await postLlmConfig({
        // Empty configs → server leaves the 3 role configs untouched and only
        // stores the per-agency override below.
        configs: [],
        agencyId,
        agencyModelRole: agencyModelRole === '' ? null : (agencyModelRole as LlmRole),
        sessionId,
      });
      onSaved?.(res.agencyModelRole ?? null);
      onClose(); // Accept = save + close.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${agencyName} settings`}
      onClick={onClose}
    >
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <h2>{agencyName} — Settings</h2>
          <p className="settings-hint">
            Choose the default LLM model role every analyst in this agency uses,
            unless an individual analyst flavor overrides it.
          </p>

          <fieldset className="llm-agency">
            <legend>Default model for this agency</legend>
            <label>
              Model role
              <select
                value={agencyModelRole}
                aria-label="Default agency model role"
                data-testid="agency-model-role"
                onChange={(e) => setAgencyModelRole(e.target.value as LlmRole | '')}
              >
                <option value="">inherit (deep-thought)</option>
                <option value="deep-thought">Deep Thought</option>
                <option value="scanner">Scanner</option>
                <option value="flexible">Flexible</option>
              </select>
            </label>
          </fieldset>

          <fieldset className="llm-bulk">
            <legend>LLM for all analysts</legend>
            {llmTotal != null && (
              <p
                className={`agency-llm-state ${llmEnabledCount === llmTotal ? 'all-on' : llmEnabledCount === 0 ? 'all-off' : 'partial'}`}
                data-testid="agency-llm-state"
                role="status"
              >
                {llmEnabledCount === llmTotal
                  ? `LLM enabled for all ${llmTotal} analysts (persisted).`
                  : llmEnabledCount === 0
                    ? `LLM disabled for all ${llmTotal} analysts.`
                    : `LLM enabled for ${llmEnabledCount} of ${llmTotal} analysts.`}
              </p>
            )}
            <p className="settings-hint">
              Turn the LLM step on for every analyst in this agency at once
              (flipped on each analyst&rsquo;s selected flavor; your existing
              Role &amp; Instructions are kept).
            </p>
            <button
              type="button"
              className="btn-secondary"
              data-testid="enable-llm-all"
              onClick={() => handleBulkEnable(true)}
              disabled={bulkBusy}
            >
              {bulkBusy ? 'Working…' : 'Enable LLM for all analysts'}
            </button>
            <button
              type="button"
              className="btn-secondary btn-danger"
              data-testid="disable-llm-all"
              onClick={() => handleBulkEnable(false)}
              disabled={bulkBusy}
            >
              Disable LLM for all analysts
            </button>
            {bulkMsg && <p className="settings-saved" role="status" data-testid="bulk-msg">{bulkMsg}</p>}
          </fieldset>

          <fieldset className="agency-reorg">
            <legend>Agency flow</legend>
            <p className="settings-hint">
              Add, remove, or reorder the analysts that make up this agency&rsquo;s
              flow, and wire which analysts feed into others.
            </p>
            <button
              type="button"
              className="btn-secondary"
              data-testid="reorg-open"
              onClick={() => setReorgOpen(true)}
            >
              [re-org] Edit analyst flow
            </button>
          </fieldset>

          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}

          <div className="settings-actions">
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Accept'}
            </button>
          </div>
        </form>
      </div>

      <AgencyReorgDialog
        open={reorgOpen}
        onClose={() => setReorgOpen(false)}
        agencyId={agencyId}
        agencyName={agencyName}
        onSaved={() => onRegistryChange?.()}
      />
    </div>
  );
}

export default AgencySettingsDialog;
