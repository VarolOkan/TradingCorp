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
//
// KEY GROUPS: sources that share one upstream API key (e.g. Polygon/Massive's
// options snapshot + daily aggregates) declare a common `keyGroup`. Such a
// group renders a SINGLE token field; the typed key is fanned out to every
// member on save (under each member's own sourceId + analystId), and each
// member's endpoint URI is listed beneath the shared field.
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
  /** The credentialed sources for this tab (label/auth/uriDefault). A source
   *  MAY carry its own `analystId` (see SourceCredField) when it is stored
   *  under a DIFFERENT analyst than the tab's display analyst. */
  sources: SourceCredField[];
  /** Called after a successful save so the parent can refresh/re-run. */
  onSaved?: (analystId: string) => void;
}

/** A render row: either a standalone source, or a key-sharing group. */
type Row =
  | { kind: 'single'; source: SourceCredField }
  | { kind: 'group'; groupId: string; label: string; auth: SourceCredField['auth']; members: SourceCredField[] };

/** Partition sources into standalone rows + collapsed key groups, preserving
 *  first-seen order. Grouped members keep their original order within the group. */
function buildRows(sources: SourceCredField[]): Row[] {
  const rows: Row[] = [];
  const groupIndex = new Map<string, number>(); // keyGroup -> index in rows
  for (const s of sources) {
    if (s.keyGroup) {
      const existing = groupIndex.get(s.keyGroup);
      if (existing == null) {
        groupIndex.set(s.keyGroup, rows.length);
        rows.push({
          kind: 'group',
          groupId: s.keyGroup,
          label: s.keyGroupLabel ?? s.label,
          auth: s.auth,
          members: [s],
        });
      } else {
        (rows[existing] as Extract<Row, { kind: 'group' }>).members.push(s);
      }
    } else {
      rows.push({ kind: 'single', source: s });
    }
  }
  return rows;
}

const authLabel = (auth: SourceCredField['auth']) =>
  auth === 'bearer' ? 'Bearer token' : auth === 'apikey' ? 'API key' : auth === 'finnhub' ? 'Finnhub token' : 'Token';

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
  const rows = buildRows(sources);
  const [forms, setForms] = useState<Record<string, SourceForm>>(() => {
    const init: Record<string, SourceForm> = {};
    for (const s of sources) init[s.sourceId] = { token: '', uri: s.uriDefault };
    return init;
  });
  // A key group shares ONE token input, keyed by the groupId. URIs remain
  // per-member (each endpoint is distinct) and live in `forms[sourceId].uri`.
  const [groupTokens, setGroupTokens] = useState<Record<string, string>>({});
  // Local override for the "stored" chip so it flips IMMEDIATELY on Save (the
  // parent re-fetch of the catalog is async/optional). Keyed by sourceId.
  const [storedOverride, setStoredOverride] = useState<Record<string, boolean>>({});
  const isStored = (s: SourceCredField) => storedOverride[s.sourceId] ?? s.hasToken;
  // A group counts as "stored" when EVERY member has a token stored.
  const groupStored = (members: SourceCredField[]) => members.every((m) => isStored(m));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-source health-probe result keyed by sourceId (mirrors the LLM Test row).
  const [testState, setTestState] = useState<Record<string, { loading: boolean; result?: SourceTestResult; error?: string }>>({});
  // Explicit "clear this token" requests (set via the Clear link). Distinct
  // from a blank field (which means "keep existing").
  const [clearTokens, setClearTokens] = useState<Record<string, boolean>>({});

  const runTest = async (sourceId: string) => {
    setTestState((prev) => ({ ...prev, [sourceId]: { loading: true } }));
    const effectiveAnalyst = sources.find((s) => s.sourceId === sourceId)?.analystId ?? analystId;
    try {
      const result = await testAnalystConfig(effectiveAnalyst, sourceId, sessionId);
      setTestState((prev) => ({ ...prev, [sourceId]: { loading: false, result } }));
    } catch (err) {
      setTestState((prev) => ({
        ...prev,
        [sourceId]: { loading: false, error: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const setField = (sourceId: string, field: keyof SourceForm, value: string) =>
    setForms((prev) => ({ ...prev, [sourceId]: { ...prev[sourceId], [field]: value } }));

  // Persist ONE source. Returns nothing; throws on failure.
  const persistSource = async (s: SourceCredField, tokenTyped: string, wantsClear: boolean) => {
    const form = forms[s.sourceId];
    const uri = (form?.uri ?? s.uriDefault ?? '').trim();
    const uriChanged = uri !== (s.uriDefault ?? '');
    // Only POST when there is a real change: a new token typed, an explicit
    // clear, or a changed URI. A blank token field on its own MUST NOT clobber
    // a previously stored token (the field only ever shows a placeholder).
    if (!(tokenTyped || wantsClear || uriChanged)) return;
    const effectiveAnalyst = s.analystId ?? analystId;
    await postAnalystConfig(
      {
        analystId: effectiveAnalyst,
        sourceId: s.sourceId,
        token: wantsClear ? '' : tokenTyped,
        extra: { uri },
        ...(wantsClear ? { clearToken: true } : {}),
      },
      sessionId,
    );
    setStoredOverride((prev) => ({ ...prev, [s.sourceId]: tokenTyped.length > 0 }));
  };

  useImperativeHandle(ref, () => ({
    async save() {
      setSaving(true);
      setError(null);
      setSaved(false);
      try {
        for (const row of rows) {
          if (row.kind === 'single') {
            const s = row.source;
            await persistSource(s, forms[s.sourceId]?.token.trim() ?? '', clearTokens[s.sourceId] === true);
          } else {
            // A key group shares ONE token: fan it out to every member so the
            // engine resolves the same key for each endpoint. A member-level
            // URI change still saves even when the token is unchanged.
            const groupTyped = (groupTokens[row.groupId] ?? '').trim();
            const groupClear = clearTokens[row.groupId] === true;
            for (const m of row.members) {
              await persistSource(m, groupTyped, groupClear);
            }
            if (groupTyped || groupClear) {
              setStoredOverride((prev) => {
                const next = { ...prev };
                for (const m of row.members) next[m.sourceId] = groupTyped.length > 0;
                return next;
              });
            }
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

  const clearToken = (sourceId: string) => {
    setClearTokens((prev) => ({ ...prev, [sourceId]: true }));
    setField(sourceId, 'token', '');
  };
  const clearGroupToken = (groupId: string) => {
    setClearTokens((prev) => ({ ...prev, [groupId]: true }));
    setGroupTokens((prev) => ({ ...prev, [groupId]: '' }));
  };

  if (sources.length === 0) {
    return <p className="settings-hint">This analyst has no credentialed sources.</p>;
  }

  const renderTestRow = (s: SourceCredField) => (
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
  );

  return (
    <fieldset className="settings-group" disabled={saving}>
      <legend>Source credentials</legend>
      {rows.map((row) =>
        row.kind === 'single' ? (
          <div key={row.source.sourceId} className="source-block">
            <h4>
              {row.source.label}{' '}
              {isStored(row.source) ? (
                <span className="source-chip configured" aria-label={`${row.source.label} token stored`}>
                  stored
                </span>
              ) : (
                <span className="source-chip" aria-label={`${row.source.label} not stored`}>
                  not stored
                </span>
              )}
            </h4>
            <label className="settings-field">
              <span>
                {authLabel(row.source.auth)}
                {isStored(row.source) && !clearTokens[row.source.sourceId] && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => clearToken(row.source.sourceId)}
                    aria-label={`Clear ${row.source.label} token`}
                    style={{ marginLeft: '0.5rem' }}
                  >
                    Clear
                  </button>
                )}
              </span>
              <input
                type="password"
                value={forms[row.source.sourceId]?.token ?? ''}
                placeholder={isStored(row.source) && !clearTokens[row.source.sourceId] ? '•••••• already saved' : 'paste a new token to replace'}
                onChange={(e) => setField(row.source.sourceId, 'token', e.target.value)}
                aria-label={`${row.source.label} token`}
              />
            </label>
            <label className="settings-field">
              <span>{row.source.uriLabel}</span>
              <input
                type="text"
                value={forms[row.source.sourceId]?.uri ?? ''}
                placeholder="https://…"
                onChange={(e) => setField(row.source.sourceId, 'uri', e.target.value)}
                aria-label={`${row.source.label} ${row.source.uriLabel}`}
              />
            </label>
            {renderTestRow(row.source)}
          </div>
        ) : (
          <div key={`group:${row.groupId}`} className="source-block source-group">
            <h4>
              {row.label}{' '}
              {groupStored(row.members) ? (
                <span className="source-chip configured" aria-label={`${row.label} key stored`}>
                  stored
                </span>
              ) : (
                <span className="source-chip" aria-label={`${row.label} not stored`}>
                  not stored
                </span>
              )}
            </h4>
            <p className="settings-hint">
              One API key is shared across the endpoints below.
            </p>
            <label className="settings-field">
              <span>
                {authLabel(row.auth)}
                {groupStored(row.members) && !clearTokens[row.groupId] && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => clearGroupToken(row.groupId)}
                    aria-label={`Clear ${row.label} key`}
                    style={{ marginLeft: '0.5rem' }}
                  >
                    Clear
                  </button>
                )}
              </span>
              <input
                type="password"
                value={groupTokens[row.groupId] ?? ''}
                placeholder={groupStored(row.members) && !clearTokens[row.groupId] ? '•••••• already saved' : 'paste a new key to replace'}
                onChange={(e) => setGroupTokens((prev) => ({ ...prev, [row.groupId]: e.target.value }))}
                aria-label={`${row.label} token`}
              />
            </label>
            <div className="source-endpoints">
              <span className="settings-field-label">Endpoints</span>
              {row.members.map((m) => (
                <div key={m.sourceId} className="source-endpoint">
                  <label className="settings-field">
                    <span>{m.endpointLabel ?? m.label}</span>
                    <input
                      type="text"
                      value={forms[m.sourceId]?.uri ?? ''}
                      placeholder="https://…"
                      onChange={(e) => setField(m.sourceId, 'uri', e.target.value)}
                      aria-label={`${m.label} ${m.uriLabel}`}
                    />
                  </label>
                  {renderTestRow(m)}
                </div>
              ))}
            </div>
          </div>
        ),
      )}
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
