// frontend/src/components/analysts/SourcesTab.tsx
// SHARED "Source credentials" editor. Used by BOTH the per-analyst
// Settings dialog (AnalystSettingsDialog) and the global Settings dialog
// (SettingsDialog → Data Ingestion analyst). The markup + persistence are
// identical in both places: this one component owns the token/URI state and
// POSTs each credential via `postAnalystConfig`, which the server writes
// through the encrypted GPG/AES vault (llm-vault.ts) — the SAME path the LLM
// tokens use. Nothing is echoed back or written to disk/DB.
//
// DESIGN NOTE: this component renders ONLY the inputs (no Save button). Each
// parent dialog triggers `save()` via a ref from its OWN "Save" button, so
// there is exactly one save action and the two surfaces stay byte-identical.
import { forwardRef, useImperativeHandle, useState } from 'react';
import { postAnalystConfig, testAnalystConfig, type SourceTestResult } from '../../api/analystConfigClient';
import type { SourceCredField } from './analystConfigSchema';

interface SourceForm {
  token: string;
  uri: string;
}

export interface SourcesTabHandle {
  /** Persist all source credentials. Returns true on success. */
  save: () => Promise<boolean>;
}

export interface SourcesTabProps {
  /** Analyst whose sources are being configured (e.g. 'data_ingestion'). */
  analystId: string;
  /** Session id for POST /analyst-config (single-tenant today). */
  sessionId?: string;
  /** The credentialed sources for this analyst (label/auth/uriDefault). */
  sources: SourceCredField[];
  /** Called after a successful save so the parent can refresh/re-run. */
  onSaved?: (analystId: string) => void;
}

/**
 * Self-contained Sources editor. Mirrors the per-analyst Settings "Sources"
 * section exactly, so the Global Settings → Sources tab and the per-analyst
 * Sources tab are the SAME code and persist to the SAME GPG vault — and both
 * are committed through the parent dialog's single Save button.
 */
export const SourcesTab = forwardRef<SourcesTabHandle, SourcesTabProps>(function SourcesTab(
  { analystId, sessionId = 'default', sources, onSaved },
  ref,
) {
  const [forms, setForms] = useState<Record<string, SourceForm>>(() => {
    const init: Record<string, SourceForm> = {};
    for (const s of sources) init[s.sourceId] = { token: '', uri: s.uriDefault };
    return init;
  });
  // Local override for the "stored" chip so it flips IMMEDIATELY on Save (the
  // parent re-fetch of the catalog is async/optional). Keyed by sourceId.
  const [storedOverride, setStoredOverride] = useState<Record<string, boolean>>({});
  const isStored = (s: SourceCredField) => storedOverride[s.sourceId] ?? s.hasToken;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-source health-probe result keyed by sourceId (mirrors the LLM Test row).
  const [testState, setTestState] = useState<Record<string, { loading: boolean; result?: SourceTestResult; error?: string }>>({});

  const runTest = async (sourceId: string) => {
    setTestState((prev) => ({ ...prev, [sourceId]: { loading: true } }));
    // DIAGNOSTIC (temporary): echo the Test request params + response to the
    // browser console so we can see exactly what is sent and what the server returns.
    console.log(`[SourcesTab Test] requesting analystId=${analystId} sourceId=${sourceId} sessionId=${sessionId}`);
    try {
      const result = await testAnalystConfig(analystId, sourceId, sessionId);
      console.log(`[SourcesTab Test] response:`, JSON.stringify(result));
      setTestState((prev) => ({ ...prev, [sourceId]: { loading: false, result } }));
    } catch (err) {
      console.log(`[SourcesTab Test] error:`, err instanceof Error ? err.message : String(err));
      setTestState((prev) => ({
        ...prev,
        [sourceId]: { loading: false, error: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const setField = (sourceId: string, field: keyof SourceForm, value: string) =>
    setForms((prev) => ({ ...prev, [sourceId]: { ...prev[sourceId], [field]: value } }));

  useImperativeHandle(ref, () => ({
    async save() {
      setSaving(true);
      setError(null);
      setSaved(false);
      try {
        for (const s of sources) {
          const form = forms[s.sourceId];
          if (!form) continue;
          const tokenTyped = form.token.trim();
          // Did the user request clearing? (explicit Clear link)
          const wantsClear = clearTokens[s.sourceId] === true;
          const uriChanged = form.uri.trim() !== (s.uriDefault ?? '');
          // Only POST when there is a real change: a new token typed, an
          // explicit clear, or a changed URI. A blank token field on its own
          // MUST NOT clobber a previously stored token (the field only ever
          // shows a placeholder, never the real value).
          if (tokenTyped || wantsClear || uriChanged) {
            await postAnalystConfig(
              {
                analystId,
                sourceId: s.sourceId,
                token: wantsClear ? '' : tokenTyped,
                extra: { uri: form.uri.trim() },
                ...(wantsClear ? { clearToken: true } : {}),
              },
              sessionId,
            );
            // Flip the "stored" chip optimistically for this source.
            setStoredOverride((prev) => ({
              ...prev,
              [s.sourceId]: tokenTyped.length > 0,
            }));
          }
        }
        setSaved(true);
        onSaved?.(analystId);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setSaving(false);
      }
    },
  }));

  // Explicit "clear this token" requests (set via the Clear link). Distinct
  // from a blank field (which means "keep existing").
  const [clearTokens, setClearTokens] = useState<Record<string, boolean>>({});
  const clearToken = (sourceId: string) => {
    setClearTokens((prev) => ({ ...prev, [sourceId]: true }));
    setField(sourceId, 'token', '');
  };

  if (sources.length === 0) {
    return <p className="settings-hint">This analyst has no credentialed sources.</p>;
  }

  return (
    <fieldset className="settings-group" disabled={saving}>
      <legend>Source credentials</legend>
      {sources.map((s) => (
        <div key={s.sourceId} className="source-block">
          <h4>
            {s.label}{' '}
            {isStored(s) ? (
              <span className="source-chip configured" aria-label={`${s.label} token stored`}>
                stored
              </span>
            ) : (
              <span className="source-chip" aria-label={`${s.label} not stored`}>
                not stored
              </span>
            )}
          </h4>
          <label className="settings-field">
            <span>
              {s.auth === 'bearer' ? 'Bearer token' : s.auth === 'apikey' ? 'API key' : s.auth === 'finnhub' ? 'Finnhub token' : 'Token'}
              {isStored(s) && !clearTokens[s.sourceId] && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => clearToken(s.sourceId)}
                  aria-label={`Clear ${s.label} token`}
                  style={{ marginLeft: '0.5rem' }}
                >
                  Clear
                </button>
              )}
            </span>
            <input
              type="password"
              value={forms[s.sourceId]?.token ?? ''}
              placeholder={isStored(s) && !clearTokens[s.sourceId] ? '•••••• already saved' : 'paste a new token to replace'}
              onChange={(e) => setField(s.sourceId, 'token', e.target.value)}
              aria-label={`${s.label} token`}
            />
          </label>
          <label className="settings-field">
            <span>{s.uriLabel}</span>
            <input
              type="text"
              value={forms[s.sourceId]?.uri ?? ''}
              placeholder="https://…"
              onChange={(e) => setField(s.sourceId, 'uri', e.target.value)}
              aria-label={`${s.label} ${s.uriLabel}`}
            />
          </label>
          <div className="source-test-row">
            <button
              type="button"
              className="source-test-btn"
              aria-label={`Test ${s.label} connection`}
              disabled={saving || testState[s.sourceId]?.loading}
              onClick={() => runTest(s.sourceId)}
            >
              {testState[s.sourceId]?.loading ? 'Testing…' : 'Test'}
            </button>
            {testState[s.sourceId]?.result && (
              <span
                className={`source-test-result ${testState[s.sourceId].result!.ok ? 'ok' : 'fail'}`}
                role="status"
              >
                {testState[s.sourceId].result!.ok
                  ? `OK${testState[s.sourceId].result!.latencyMs != null ? ` · ${testState[s.sourceId].result!.latencyMs}ms` : ''}`
                  : testState[s.sourceId].result!.error ?? 'Failed'}
              </span>
            )}
            {testState[s.sourceId]?.error && (
              <span className="source-test-result fail" role="status">
                {testState[s.sourceId].error}
              </span>
            )}
          </div>
        </div>
      ))}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="settings-saved" role="status">
          Saved — applies to the next analysis run
        </p>
      )}
    </fieldset>
  );
});
