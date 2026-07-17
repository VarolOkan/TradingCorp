// frontend/src/components/SettingsDialog.tsx
// In-app settings dialog (Option B). Tabs (§12.5):
//   - Connection: backend URI / access token / extra params (POST /config)
//   - LLM Models: the 3 preconfigured LLM roles (deep-thought/scanner/flexible)
//     as editable rows + a per-agency "default model" control (POST /llm-config)
//   - Agencies: create / delete agencies (POST/DELETE /registry/agency)
//   - Server Log: live tail of logs/server.log
// Tokens are sent to the server but never logged or echoed (hasToken chip only).

import { useState, useEffect, FormEvent, Fragment, useRef, useMemo } from 'react';
import { postSettings } from '../api/configClient';
import { getLlmConfig, postLlmConfig, postLlmConfigTest, type LlmModelConfigPublic } from '../api/llmConfigClient';
import {
  getRegistry,
  postAgency,
  putAgency,
  deleteAgency,
  postAnalyst,
  putAnalyst,
  deleteAnalyst,
  type AgencySummary,
  type CatalogAnalyst,
} from '../api/registryClient';
import { applyRegistryAgencies, AGENCIES } from './analysts/agencies';
import type { ConnectionSettings } from '../types';
import type { LlmRole, LlmProvider } from '../../../src/server/llm-config';
import type { AnalystKind } from '../../../src/types/registry';
import { getServerLog } from '../api/serverLogClient';
import { getAnalystFlavors, postAnalystFlavors } from '../api/analystFlavorsClient';
import { getAnalystSourceCatalog, type AnalystSourceCatalogAnalyst } from '../api/analystConfigClient';
import { DomainSourcesTab, type DomainSourcesTabHandle } from './analysts/DomainSourcesTab';
import { buildAnalystConfigSchema, type SourceCredField } from './analysts/analystConfigSchema';
import { SourcesTab, type SourcesTabHandle } from './analysts/SourcesTab';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Current settings (prefilled when reopening). */
  initial?: Partial<ConnectionSettings>;
  /** Optional session id for POST /config and /llm-config. */
  sessionId?: string;
  /** Agency id for the per-agency "default model" control. */
  agencyId?: string;
  /** Test seam. */
  onSaved?: (settings: ConnectionSettings) => void;
  /** Called after an agency is created/deleted so the parent re-renders live. */
  onRegistryChange?: () => void;
}

type Tab = 'connection' | 'llm' | 'agencies' | 'analysts' | 'sources' | 'domains' | 'log';

const DEFAULTS: ConnectionSettings = {
  baseUri: 'http://localhost:3001',
  accessToken: '',
  extra: {},
};

const PROVIDERS: LlmProvider[] = ['openrouter', 'openai', 'anthropic', 'azure', 'ollama'];
const PROVIDER_BASE: Record<LlmProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  azure: 'https://your-resource.openai.azure.com/openai',
  ollama: 'http://localhost:11434/v1',
};
const ROLE_LABELS: Record<LlmRole, string> = {
  'deep-thought': 'Deep Thought',
  scanner: 'Scanner',
  flexible: 'Flexible',
};

export function SettingsDialog({
  open,
  onClose,
  initial,
  sessionId = 'default',
  agencyId,
  onSaved,
  onRegistryChange,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<Tab>('connection');

  // ---- Connection tab state ----
  const [baseUri, setBaseUri] = useState(DEFAULTS.baseUri);
  const [accessToken, setAccessToken] = useState('');
  const [extraKeys, setExtraKeys] = useState<string[]>([]);
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});
  const [parallelAnalysts, setParallelAnalysts] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [connSaving, setConnSaving] = useState(false);
  const [connSaved, setConnSaved] = useState(false);

  // ---- LLM Models tab state ----
  const [llmConfigs, setLlmConfigs] = useState<LlmModelConfigPublic[]>([]);
  const [llmTokens, setLlmTokens] = useState<Record<string, string>>({});
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmSaved, setLlmSaved] = useState(false);
  // Per-role connection-test state.
  const [llmTesting, setLlmTesting] = useState<Record<string, boolean>>({});
  const [llmTestResult, setLlmTestResult] = useState<Record<
    string,
    { ok: boolean; message: string }
  >>({});
  // Tracks unsaved LLM-tab edits so a background refetch (e.g. triggered by
  // saving another tab) never clobbers the model/provider/token the user is
  // still editing. Cleared after a successful load or save.
  const llmDirty = useRef(false);

  // ---- Sources tab state (global Data Ingestion source credentials) ----
  // Reuses the SAME shared SourcesTab component the per-analyst dialog uses,
  // so the code is identical and BOTH persist to the GPG vault.
  // We pull BOTH the `data_ingestion` catalog (Alpha Vantage / Finnhub)
  // AND the `options_ingestion` catalog (Polygon Options / Aggregates /
  // Treasury RFR) so the options sources can be configured here too — without
  // touching the per-analyst dialogs. Polygon sources are tagged with their
  // own `analystId` ('options_ingestion') so the saved key lands where the
  // options engine resolves it, while still rendering in this one tab.
  const [sourceCatalog, setSourceCatalog] = useState<AnalystSourceCatalogAnalyst | null>(null);
  const [sourceCatalogOpt, setSourceCatalogOpt] = useState<AnalystSourceCatalogAnalyst | null>(null);
  const [sourceCatalogError, setSourceCatalogError] = useState<string | null>(null);
  const [vaultDisabled, setVaultDisabled] = useState(false);
  const sourcesRef = useRef<SourcesTabHandle>(null);
  const domainSourcesRef = useRef<DomainSourcesTabHandle>(null);
  const diSources = useMemo(() => {
    if (!sourceCatalog) return [];
    const di = buildAnalystConfigSchema('data_ingestion', 'Data Ingestion', sourceCatalog.sources).sources;
    const optCatalog = sourceCatalogOpt;
    if (!optCatalog) return di;
    const opt = buildAnalystConfigSchema('options_ingestion', 'Options Ingestion', optCatalog.sources).sources
      .map((s) => {
        const base = { ...s, analystId: 'options_ingestion' as const };
        // Polygon/Massive options snapshot + daily aggregates share ONE Massive
        // API key. Collapse them into a single key group so the user enters the
        // key once; each endpoint is listed beneath the shared token field.
        if (s.sourceId === 'polygonOptions') {
          return { ...base, keyGroup: 'massive', keyGroupLabel: 'Massive/Polygon Options', endpointLabel: 'Options snapshot' };
        }
        if (s.sourceId === 'polygonHist') {
          return { ...base, keyGroup: 'massive', keyGroupLabel: 'Massive/Polygon Options', endpointLabel: 'Daily aggregates' };
        }
        return base;
      });
    // Merge, de-dup by sourceId (defensive).
    const byId = new Map<string, SourceCredField>();
    for (const s of [...di, ...opt]) byId.set(s.sourceId, s);
    return Array.from(byId.values());
  }, [sourceCatalog, sourceCatalogOpt]);

  // Fetch the catalog as soon as the dialog opens (not lazily on tab switch)
  // so the Sources tab already has its inputs populated when the user opens it.
  // Pull BOTH analysts' catalogs: data_ingestion (Alpha Vantage /
  // Finnhub) and options_ingestion (Polygon Options / Aggregates / Treasury
  // RFR) so the options sources are configurable here too.
  useEffect(() => {
    if (!open) return;
    setSourceCatalogError(null);
    getAnalystSourceCatalog()
      .then((cat) => {
        setSourceCatalog(cat.analysts.find((a) => a.analystId === 'data_ingestion') ?? null);
        setSourceCatalogOpt(cat.analysts.find((a) => a.analystId === 'options_ingestion') ?? null);
        setVaultDisabled(cat.vaultDisabled === true);
      })
      .catch((err) => setSourceCatalogError(err instanceof Error ? err.message : String(err)));
  }, [open]);

  // ---- Server Log tab state ----
  const [logLines, setLogLines] = useState(200);
  const [logContent, setLogContent] = useState('');
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  // ---- Agencies tab state ----
  const [agencyList, setAgencyList] = useState<AgencySummary[]>([]);
  const [catalog, setCatalog] = useState<CatalogAnalyst[]>([]);
  const [agencyError, setAgencyError] = useState<string | null>(null);
  const [agencyBusy, setAgencyBusy] = useState(false);
  // Edit target: when set, the New-agency form edits an existing agency; null = create mode.
  const [editAgency, setEditAgency] = useState<AgencySummary | null>(null);
  // New-agency form.
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newHorizon, setNewHorizon] = useState('LONG_TERM');
  const [newAssetClass, setNewAssetClass] = useState<'EQUITY' | 'OPTION' | 'CRYPTO'>('EQUITY');
  const [newInterval, setNewInterval] = useState<'1m' | '5m' | '1h' | '4h' | '1d'>('1d');
  const [newLookback, setNewLookback] = useState<number>(90);
  const [newMinVolume, setNewMinVolume] = useState<number>(100_000);
  const [newAnalysts, setNewAnalysts] = useState<string[]>(['orchestrator', 'data_ingestion']);

  // ---- Analysts tab state ----
  const [analystError, setAnalystError] = useState<string | null>(null);
  const [analystBusy, setAnalystBusy] = useState(false);
  // Edit target: when set, the form edits an existing custom analyst; null = create mode.
  const [editAnalyst, setEditAnalyst] = useState<CatalogAnalyst | null>(null);
  // Filter for the analyst list: 'all' or a specific stage (1 | 2 | 3).
  const [stageFilter, setStageFilter] = useState<1 | 2 | 3>(1);
  // New/edit analyst form.
  const [aId, setAId] = useState('');
  const [aName, setAName] = useState('');
  const [aRole, setARole] = useState('');
  const [aKind, setAKind] = useState<AnalystKind>('analyst');
  const [aStage, setAStage] = useState<'1' | '2' | '3'>('2');
  const [aAccent, setAAccent] = useState('#6366f1');
  const [aDependsOn, setADependsOn] = useState('');
  // Input data sources (dataSources[]) — each: id, label, from, fields, sources.
  const [aSources, setASources] = useState<Array<{ id: string; label: string; from: string; fields: string; sources: string }>>([]);
  // Output data — channels, verdictField, scoreField, storeInMessages.
  const [aOutChannels, setAOutChannels] = useState('');
  const [aOutVerdict, setAOutVerdict] = useState('');
  const [aOutScore, setAOutScore] = useState('');
  const [aOutStore, setAOutStore] = useState(false);
  // Sub-tab within the New/edit analyst form: GENERAL / INPUT / ANALYSIS / OUTPUT.
  const [analystEditTab, setAnalystEditTab] = useState<'general' | 'input' | 'analysis' | 'output'>('general');
  // GENERAL — extra def fields currently missing from the form.
  const [aMonogram, setAMonogram] = useState('');
  const [aOnFail, setAOnFail] = useState<'fail' | 'degrade' | 'useMock' | ''>('');
  // ANALYSIS — Role & Instructions (single editable flavor, saved as def.flavors).
  const [aFlavorName, setAFlavorName] = useState('');
  const [aFlavorRole, setAFlavorRole] = useState('');
  const [aFlavorInstructions, setAFlavorInstructions] = useState('');
  const [aFlavorEnabled, setAFlavorEnabled] = useState(false);
  const [aFlavorModelRole, setAFlavorModelRole] = useState<'deep-thought' | 'scanner' | 'flexible'>('deep-thought');

  const resetAnalystForm = () => {
    setEditAnalyst(null);
    setAId('');
    setAName('');
    setARole('');
    setAKind('analyst');
    setAStage('2');
    setAAccent('#6366f1');
    setADependsOn('');
    setASources([]);
    setAOutChannels('');
    setAOutVerdict('');
    setAOutScore('');
    setAOutStore(false);
    setAnalystEditTab('general');
    setAMonogram('');
    setAOnFail('');
    setAFlavorName('');
    setAFlavorRole('');
    setAFlavorInstructions('');
    setAFlavorEnabled(false);
    setAFlavorModelRole('deep-thought');
    setAnalystError(null);
  };

  const loadAnalysts = async () => {
    setAnalystError(null);
    try {
      const data = await getRegistry(sessionId);
      setCatalog(data.catalog);
    } catch (err) {
      setAnalystError(err instanceof Error ? err.message : String(err));
    }
  };

  const openEditAnalyst = (a: CatalogAnalyst) => {
    setEditAnalyst(a);
    setAId(a.id);
    setAName(a.name);
    setARole(a.role ?? '');
    setAKind(a.kind);
    setAStage(String(a.stage) as typeof aStage);
    setAAccent(a.accent ?? '#6366f1');
    setADependsOn((a.dependsOn ?? []).join(', '));
    setASources(
      (a.dataSources ?? []).map((s) => ({
        id: s.id ?? '',
        label: s.label ?? '',
        from: s.from ?? '',
        fields: (s.fields ?? []).join(', '),
        sources: (s.sources ?? []).join(', '),
      })),
    );
    const out = a.output ?? {};
    setAOutChannels((out.channels ?? []).join(', '));
    setAOutVerdict(out.verdictField ?? '');
    setAOutScore(out.scoreField ?? '');
    setAOutStore(out.storeInMessages === true);
    setAnalystEditTab('general');
    setAMonogram(a.monogram ?? '');
    setAOnFail(a.onAllSourcesFailed?.action ?? '');
    // Prefer the per-analyst FLAVOR STORE (the same one the analyst card's
    // "Role & Instructions" editor writes to) over the registry's def.flavors.
    // The store is the source of truth the trace/LLM actually run from, so the
    // ANALYSIS tab must show it — not the (often empty) def.flavors.
    if (agencyId) {
      getAnalystFlavors(sessionId, agencyId, a.id)
        .then((data) => {
          const f = data.flavors.find((x) => x.id === data.selectedId) ?? data.flavors[0];
          if (!f) return;
          setAFlavorName(f.name ?? '');
          setAFlavorRole(f.role ?? '');
          setAFlavorInstructions(f.instructions ?? '');
          setAFlavorEnabled(f.enabled === true);
          setAFlavorModelRole((f as { modelRole?: string }).modelRole ?? 'deep-thought');
        })
        .catch(() => {
          /* no saved flavor store entry — fall back to def.flavors below */
        });
    }
    // Fallback: registry-defined flavors (shipped defs, no card override).
    const f = a.flavors?.[0];
    setAFlavorName(f?.name ?? '');
    setAFlavorRole(f?.role ?? '');
    setAFlavorInstructions(f?.instructions ?? '');
    setAFlavorEnabled(f?.enabled === true);
    setAFlavorModelRole(f?.modelRole ?? 'deep-thought');
    setAnalystError(null);
  };

  const addSourceRow = () =>
    setASources((prev) => [...prev, { id: '', label: '', from: '', fields: '', sources: '' }]);
  const updateSourceRow = (idx: number, patch: Partial<{ id: string; label: string; from: string; fields: string; sources: string }>) =>
    setASources((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeSourceRow = (idx: number) =>
    setASources((prev) => prev.filter((_, i) => i !== idx));

  const buildAnalystDef = (): AnalystDef => {
    const dataSources = aSources
      .filter((s) => s.id.trim() || s.label.trim())
      .map((s) => ({
        id: s.id.trim() || undefined,
        from: s.from.trim() || undefined,
        fields: s.fields.split(',').map((x) => x.trim()).filter(Boolean),
        label: s.label.trim(),
        sources: s.sources.split(',').map((x) => x.trim()).filter(Boolean),
      }));
    const output = {
      ...(aOutChannels.trim() || aOutVerdict.trim() || aOutScore.trim() || aOutStore
        ? {
            channels: aOutChannels.split(',').map((x) => x.trim()).filter(Boolean),
            verdictField: aOutVerdict.trim() || undefined,
            scoreField: aOutScore.trim() || undefined,
            storeInMessages: aOutStore,
          }
        : {}),
    };
    return {
      id: aId.trim(),
      name: aName.trim(),
      kind: aKind,
      stage: Number(aStage) as 1 | 2 | 3,
      accent: aAccent.trim() || '#6366f1',
      role: aRole.trim() || undefined,
      dependsOn: aDependsOn.split(',').map((x) => x.trim()).filter(Boolean),
      dataSources: dataSources.length > 0 ? dataSources : undefined,
      output: Object.keys(output).length > 0 ? output : undefined,
      // GENERAL extras (previously missing from the form).
      monogram: aMonogram.trim() || undefined,
      onAllSourcesFailed: aOnFail ? { action: aOnFail } : undefined,
      // ANALYSIS / Role & Instructions — emit a single flavor when the user
      // wrote a name OR instructions. modelRole drives the LLM provider;
      // enabled gates the LLM step. Empty → omit so built-in parity holds.
      flavorId: aFlavorName.trim() || aFlavorInstructions.trim() ? 'default' : undefined,
      flavors:
        aFlavorName.trim() || aFlavorInstructions.trim()
          ? [
              {
                id: 'default',
                name: aFlavorName.trim() || aId.trim() || 'default',
                role: aFlavorRole.trim(),
                instructions: aFlavorInstructions,
                isDefault: true,
                enabled: aFlavorEnabled,
                modelRole: aFlavorModelRole,
              },
            ]
          : undefined,
      // Required by validation; logic is non-optional. A custom analyst ships a
      // declarative no-op logic so it survives the backend's isValidAnalystDef
      // check (id/name/kind/stage/logic). The graph won't actually run it unless
      // wired into an agency — this is a registry CRUD entry, not a live handler.
      logic: { mode: 'declarative', weighting: [] },
    };
  };

  const handleSaveAnalyst = async () => {
    setAnalystBusy(true);
    setAnalystError(null);
    try {
      const def = buildAnalystDef();
      if (!def.id) throw new Error('Analyst id is required');
      if (!def.name) throw new Error('Analyst name is required');
      if (editAnalyst) {
        await putAnalyst(def.id, def, sessionId);
      } else {
        await postAnalyst(def, sessionId);
      }
      // Persist the ANALYSIS / Role & Instructions fields to the SAME per-analyst
      // flavor store the card editor writes to (POST /analyst-flavors), so the
      // two entry points stay in sync and the box is populated on re-open.
      const hasFlavor = aFlavorName.trim() || aFlavorInstructions.trim();
      if (hasFlavor && agencyId) {
        await postAnalystFlavors({
          sessionId,
          agencyId,
          analystId: def.id,
          flavors: [
            {
              id: 'default',
              name: aFlavorName.trim() || def.id,
              role: aFlavorRole.trim(),
              instructions: aFlavorInstructions,
              isDefault: true,
              enabled: aFlavorEnabled,
            },
          ],
          selectedId: 'default',
        });
      }
      await loadAnalysts();
      onRegistryChange?.();
      resetAnalystForm();
    } catch (err) {
      setAnalystError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalystBusy(false);
    }
  };

  const handleDeleteAnalyst = async (id: string) => {
    setAnalystBusy(true);
    setAnalystError(null);
    try {
      await deleteAnalyst(id, sessionId);
      await loadAnalysts();
      onRegistryChange?.();
    } catch (err) {
      setAnalystError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalystBusy(false);
    }
  };

  const loadAgencies = async () => {
    setAgencyError(null);
    try {
      const data = await getRegistry(sessionId);
      setAgencyList(data.agencies);
      setCatalog(data.catalog);
      // Reflect into the shared mirror so the dropdown stays in sync.
      applyRegistryAgencies(data.agencies);
    } catch (err) {
      setAgencyError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleNewAnalyst = (id: string) => {
    setNewAnalysts((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
  };

  const resetAgencyForm = () => {
    setEditAgency(null);
    setNewId('');
    setNewName('');
    setNewHorizon('LONG_TERM');
    setNewAssetClass('EQUITY');
    setNewInterval('1d');
    setNewLookback(90);
    setNewAnalysts(['orchestrator', 'data_ingestion']);
    setAgencyError(null);
  };

  // Populate the New-agency form from an existing agency (row click / Edit).
  const openEditAgency = (a: AgencySummary) => {
    setEditAgency(a);
    setNewId(a.id);
    setNewName(a.name);
    setNewHorizon(a.horizon);
    setNewAssetClass(a.assetClass ?? a.instrument ?? 'EQUITY');
    setNewInterval(a.screenerInterval ?? (a.horizon === 'INTRADAY' ? '5m' : '1d'));
    setNewLookback(a.screenerLookbackDays ?? (a.horizon === 'INTRADAY' ? 5 : 90));
    setNewMinVolume(a.minVolumeDaily ?? 100_000);
    // The full analyst membership isn't in the summary, so default the checkboxes
    // to the analyst ids carried by the frontend AGENCIES mirror (kept in sync
    // via applyRegistryAgencies on every load).
    const full = AGENCIES[a.id];
    if (full?.analysts?.length) {
      // The mirror's `analysts` may be plain string ids (default static map,
      // or a GET that returned strings) OR AgencyAnalystRef[] ({id,...}) from a
      // backend payload. Normalize to string ids either way so the checkboxes
      // match and the saved PUT is clean (a bare `.map(r => r.id)` breaks when
      // the entries are already strings, yielding [undefined,...]).
      const members = full.analysts as Array<string | { id: string }>;
      setNewAnalysts(members.map((r) => (typeof r === 'string' ? r : r.id)));
    } else {
      setNewAnalysts([]);
    }
    setAgencyError(null);
  };

  const handleSaveAgency = async () => {
    setAgencyBusy(true);
    setAgencyError(null);
    try {
      const id = newId.trim();
      if (!id) throw new Error('Agency id is required');
      if (newAnalysts.length === 0) throw new Error('Select at least one analyst');
      const def = {
        id,
        name: newName.trim() || id,
        horizon: newHorizon,
        // Phase 22: persist the agency-level screener settings. CRYPTO has no
        // equity/option instrument intent yet, so its `instrument` falls back to
        // EQUITY (the screener ranks equity underlyings until a crypto source lands).
        assetClass: newAssetClass,
        instrument: newAssetClass === 'OPTION' ? 'OPTION' : 'EQUITY',
        screenerInterval: newInterval,
        screenerLookbackDays: newLookback,
        minVolumeDaily: newMinVolume > 0 ? newMinVolume : 0,
        analysts: newAnalysts.map((a) => ({ id: a })),
      } as never;
      if (editAgency) {
        await putAgency(id, def, sessionId);
      } else {
        await postAgency(def, sessionId);
      }
      await loadAgencies();
      onRegistryChange?.();
      resetAgencyForm();
    } catch (err) {
      setAgencyError(err instanceof Error ? err.message : String(err));
    } finally {
      setAgencyBusy(false);
    }
  };

  const handleDeleteAgency = async (id: string) => {
    setAgencyBusy(true);
    setAgencyError(null);
    try {
      await deleteAgency(id, sessionId);
      await loadAgencies();
      onRegistryChange?.();
    } catch (err) {
      setAgencyError(err instanceof Error ? err.message : String(err));
    } finally {
      setAgencyBusy(false);
    }
  };

  // Load agencies when the Agencies tab opens.
  useEffect(() => {
    if (!open || tab !== 'agencies') return;
    loadAgencies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  // Close-on-unmount instead of a fire-and-forget setTimeout: the previous
  // handlers scheduled `setTimeout(() => onClose(), 400)` whose timer leaked
  // into the next render/test, calling a stale onClose. Capturing the latest
  // onClose in a ref keeps the effect stable while still closing exactly once
  // when the dialog is unmounted.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => () => { onCloseRef.current(); }, []);

  // Load the analyst catalog when the Analysts tab opens.
  useEffect(() => {
    if (!open || tab !== 'analysts') return;
    loadAnalysts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);


  const loadLog = async () => {
    setLogLoading(true);
    setLogError(null);
    try {
      const text = await getServerLog(logLines);
      setLogContent(text);
    } catch (err) {
      setLogError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogLoading(false);
    }
  };

  // Load + auto-refresh the log while the tab is open.
  useEffect(() => {
    if (!open || tab !== 'log') return;
    let timer: ReturnType<typeof setInterval> | undefined;
    loadLog();
    timer = setInterval(loadLog, 3000);
    return () => { if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, logLines]);

  // Reset the forms each time the dialog opens, prefilling from `initial`.
  useEffect(() => {
    if (!open) return;
    const merged = { ...DEFAULTS, ...initial };
    setBaseUri(merged.baseUri ?? DEFAULTS.baseUri);
    setAccessToken(merged.accessToken ?? '');
    setExtraKeys(Object.keys(merged.extra ?? {}));
    setExtraValues(merged.extra ?? {});
    setParallelAnalysts(merged.parallelAnalysts === true);
    setConnError(null);
    setConnSaved(false);
    setConnSaving(false);
    setTab('connection');
  }, [open, initial]);

  // Load LLM config when the dialog opens (or the session/agency changes).
  // Crucially this does NOT depend on `initial` (the connection settings
  // object), so saving the Connection tab can't re-run it and clobber unsaved
  // LLM edits. And if the user has unsaved LLM edits (llmDirty), we skip the
  // refetch entirely so their in-progress model/provider/token is preserved.
  useEffect(() => {
    if (!open) return;
    if (llmDirty.current) return;
    setLlmError(null);
    setLlmSaved(false);
    setLlmTokens({});
    getLlmConfig(sessionId, agencyId)
      .then((data) => {
        setLlmConfigs(data.configs);
        llmDirty.current = false;
      })
      .catch((err) => setLlmError(err instanceof Error ? err.message : String(err)));
  }, [open, sessionId, agencyId]);

  if (!open) return null;

  const handleLlmTest = async (role: LlmRole) => {
    const cfg = llmConfigs.find((c) => c.role === role);
    if (!cfg) return;
    setLlmTesting((t) => ({ ...t, [role]: true }));
    setLlmTestResult((r) => ({ ...r, [role]: { ok: false, message: 'Testing…' } }));
    try {
      const res = await postLlmConfigTest({
        role,
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        token: llmTokens[role] ?? '',
        sessionId,
      });
      setLlmTestResult((r) => ({
        ...r,
        [role]: {
          ok: res.ok,
          message: res.ok
            ? `Connected (HTTP ${res.status ?? 200})`
            : res.error ?? 'Connection failed',
        },
      }));
    } catch (err) {
      setLlmTestResult((r) => ({
        ...r,
        [role]: { ok: false, message: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setLlmTesting((t) => ({ ...t, [role]: false }));
    }
  };

  // ---------------- Connection tab handlers ----------------
  const addExtraRow = () => {
    setExtraKeys((k) => [...k, '']);
    setExtraValues((v) => ({ ...v, '': '' }));
  };
  const updateExtraKey = (idx: number, value: string) => {
    setExtraKeys((keys) => {
      const next = [...keys];
      const oldKey = next[idx];
      next[idx] = value;
      setExtraValues((vals) => {
        const out = { ...vals };
        const prev = out[oldKey] ?? '';
        delete out[oldKey];
        out[value] = prev;
        return out;
      });
      return next;
    });
  };
  const updateExtraValue = (key: string, value: string) => {
    setExtraValues((v) => ({ ...v, [key]: value }));
  };
  const removeExtraRow = (idx: number) => {
    setExtraKeys((keys) => {
      const key = keys[idx];
      setExtraValues((vals) => {
        const out = { ...vals };
        delete out[key];
        return out;
      });
      return keys.filter((_, i) => i !== idx);
    });
  };
  const buildSettings = (): ConnectionSettings => {
    const extra: Record<string, string> = {};
    for (const k of extraKeys) {
      if (k.trim().length > 0) extra[k.trim()] = extraValues[k] ?? '';
    }
    return { baseUri: baseUri.trim(), accessToken: accessToken.trim(), extra, parallelAnalysts };
  };
  const validate = (s: ConnectionSettings): string | null => {
    if (!s.baseUri) return 'Backend URI is required';
    if (!/^https?:\/\//i.test(s.baseUri)) return 'Backend URI must start with http:// or https://';
    return null;
  };
  const handleConnSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const settings = buildSettings();
    const validationError = validate(settings);
    if (validationError) {
      setConnError(validationError);
      return;
    }
    setConnSaving(true);
    setConnError(null);
    try {
      await postSettings(settings, sessionId);
      setConnSaved(true);
      onSaved?.(settings);
      onClose(); // Accept = save + close the dialog.
    } catch (err) {
      setConnError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnSaving(false);
    }
  };

  // ---------------- LLM Models tab handlers ----------------
  const updateLlmField = (role: LlmRole, patch: Partial<LlmModelConfigPublic>) => {
    llmDirty.current = true;
    setLlmConfigs((cs) => cs.map((c) => (c.role === role ? { ...c, ...patch } : c)));
  };
  const setLlmToken = (role: LlmRole, value: string) => {
    llmDirty.current = true;
    setLlmTokens((t) => ({ ...t, [role]: value }));
  };
  const handleLlmSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLlmSaving(true);
    setLlmError(null);
    try {
      const res = await postLlmConfig({
        configs: llmConfigs.map((c) => ({
          role: c.role,
          provider: c.provider,
          baseUrl: c.baseUrl,
          model: c.model,
          token: llmTokens[c.role] ?? '',
        })),
        sessionId,
      });
      setLlmConfigs(res.configs);
      setLlmTokens({});
      setLlmSaved(true);
      llmDirty.current = false;
      onClose(); // Accept = save + close the dialog.
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : String(err));
    } finally {
      setLlmSaving(false);
    }
  };

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(e) => {
        if (e.target === e.currentTarget && !connSaving && !llmSaving) onClose();
      }}
    >
      <div className="settings-panel">
        <div className="settings-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'connection'}
            className={tab === 'connection' ? 'settings-tab active' : 'settings-tab'}
            data-testid="tab-connection"
            onClick={() => setTab('connection')}
          >
            Connection
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'llm'}
            className={tab === 'llm' ? 'settings-tab active' : 'settings-tab'}
            data-testid="tab-llm"
            onClick={() => setTab('llm')}
          >
            LLM Models
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'agencies'}
            className={tab === 'agencies' ? 'settings-tab active' : 'settings-tab'}
            data-testid="tab-agencies"
            onClick={() => setTab('agencies')}
          >
            Agencies
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'analysts'}
            className={tab === 'analysts' ? 'settings-tab active' : 'settings-tab'}
            data-testid="tab-analysts"
            onClick={() => setTab('analysts')}
          >
            Analysts
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sources'}
            className={tab === 'sources' ? 'settings-tab active' : 'settings-tab'}
            data-testid="tab-sources"
            onClick={() => setTab('sources')}
          >
            Sources
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'domains'}
            className={tab === 'domains' ? 'settings-tab active' : 'settings-tab'}
            data-testid="tab-domains"
            onClick={() => setTab('domains')}
          >
            Data Sources
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'log'}
            className={tab === 'log' ? 'settings-tab active' : 'settings-tab'}
            data-testid="tab-log"
            onClick={() => setTab('log')}
          >
            Server Log
          </button>
        </div>

        {tab === 'connection' && (
          <form onSubmit={handleConnSubmit}>
            <h2>Connection Settings</h2>
            <label>
              Backend URI
              <input
                type="text"
                value={baseUri}
                placeholder="http://localhost:3001"
                onChange={(e) => setBaseUri(e.target.value)}
                aria-label="Backend URI"
              />
            </label>
            <label>
              Access Token
              <input
                type="password"
                value={accessToken}
                placeholder="optional"
                onChange={(e) => setAccessToken(e.target.value)}
                aria-label="Access token"
              />
            </label>
            <label className="settings-field parallel-toggle">
              <input
                type="checkbox"
                checked={parallelAnalysts}
                onChange={(e) => setParallelAnalysts(e.target.checked)}
                aria-label="Run analysts in parallel"
                data-testid="parallel-analysts"
              />
              <span>
                Run independent analysts in parallel
                <small>
                  After data ingestion, analysts that don&rsquo;t depend on each
                  other execute concurrently (fan-out / fan-in). Off by default to
                  keep the legacy serial order.
                </small>
              </span>
            </label>
            <fieldset>
              <legend>Extra parameters</legend>
              {extraKeys.map((key, idx) => (
                <div className="extra-row" key={`${key}-${idx}`}>
                  <input
                    type="text"
                    value={key}
                    placeholder="key"
                    aria-label="extra key"
                    onChange={(e) => updateExtraKey(idx, e.target.value)}
                  />
                  <input
                    type="text"
                    value={extraValues[key] ?? ''}
                    placeholder="value"
                    aria-label="extra value"
                    onChange={(e) => updateExtraValue(key, e.target.value)}
                  />
                  <button
                    type="button"
                    className="extra-remove"
                    aria-label="Remove parameter"
                    onClick={() => removeExtraRow(idx)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" className="extra-add" onClick={addExtraRow}>
                + Add parameter
              </button>
            </fieldset>
            <fieldset>
              <legend>API documentation</legend>
              <p className="settings-hint">
                Browse the server&rsquo;s REST API (Swagger / OpenAPI). Opens in a
                new tab against the Backend URI above.
              </p>
              <button
                type="button"
                className="btn-secondary api-docs-btn"
                data-testid="view-api-docs"
                onClick={() => {
                  // Open the docs through the SAME origin the SPA is served
                  // from. In dev Vite proxies /api-docs to the backend; in
                  // production the backend serves the SPA and /api-docs from the
                  // same origin. This avoids "This site can't be reached" when
                  // the Settings Backend URI is a bare localhost:3001 or a LAN
                  // host the browser can't reach.
                  const url = `${window.location.origin}/api-docs/`;
                  window.open(url, '_blank', 'noopener,noreferrer');
                }}
              >
                View API docs ↗
              </button>
            </fieldset>
            {connError && <p className="settings-error" role="alert">{connError}</p>}
            {connSaved && <p className="settings-saved" role="status">Saved</p>}
            <div className="settings-actions">
              <button type="button" onClick={onClose} disabled={connSaving}>
                Cancel
              </button>
              <button type="submit" disabled={connSaving}>
                {connSaving ? 'Saving…' : 'Accept'}
              </button>
            </div>
          </form>
        )}

        {tab === 'llm' && (
          <form onSubmit={handleLlmSubmit}>
            <h2>LLM Models</h2>
            <p className="settings-hint">
              Configure one of three model roles. Tokens are never echoed back (a
              configured chip is shown instead).
            </p>
            {llmConfigs.map((c) => (
              <fieldset className="llm-role" key={c.role} data-testid={`llm-role-${c.role}`}>
                <legend>
                  {ROLE_LABELS[c.role]}{' '}
                  {c.provider && c.model ? (
                    <span className="llm-chip configured" aria-label={`${c.role} configured`}>
                      configured
                    </span>
                  ) : (
                    <span className="llm-chip" aria-label={`${c.role} not configured`}>
                      not configured
                    </span>
                  )}
                  {!c.hasToken && !llmTokens[c.role] && (
                    <span className="llm-chip" aria-label={`${c.role} no token`}>
                      no token
                    </span>
                  )}
                </legend>
                <label>
                  Provider
                  <select
                    value={c.provider}
                    aria-label={`${c.role} provider`}
                    onChange={(e) =>
                      updateLlmField(c.role, {
                        provider: e.target.value as LlmProvider,
                        baseUrl: PROVIDER_BASE[e.target.value as LlmProvider],
                      })
                    }
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Base URL
                  <input
                    type="text"
                    value={c.baseUrl}
                    aria-label={`${c.role} base URL`}
                    onChange={(e) => updateLlmField(c.role, { baseUrl: e.target.value })}
                  />
                </label>
                <label>
                  Model
                  <input
                    type="text"
                    value={c.model}
                    aria-label={`${c.role} model`}
                    onChange={(e) => updateLlmField(c.role, { model: e.target.value })}
                  />
                </label>
                <label>
                  Token
                  <input
                    type="password"
                    value={llmTokens[c.role] ?? ''}
                    placeholder={c.hasToken ? '•••••• already saved' : 'optional — leave blank to keep existing'}
                    aria-label={`${c.role} token`}
                    onChange={(e) => setLlmToken(c.role, e.target.value)}
                  />
                </label>
                <div className="llm-test-row">
                  <button
                    type="button"
                    className="llm-test-btn"
                    aria-label={`Test ${c.role} connection`}
                    disabled={llmTesting[c.role]}
                    onClick={() => handleLlmTest(c.role)}
                  >
                    {llmTesting[c.role] ? 'Testing…' : 'Test'}
                  </button>
                  {llmTestResult[c.role] && (
                    <span
                      className={`llm-test-result ${llmTestResult[c.role].ok ? 'ok' : 'fail'}`}
                      role="status"
                    >
                      {llmTestResult[c.role].message}
                    </span>
                  )}
                </div>
              </fieldset>
            ))}

            {llmError && <p className="settings-error" role="alert">{llmError}</p>}
            {llmSaved && <p className="settings-saved" role="status">Saved</p>}
            <div className="settings-actions">
              <button type="button" onClick={onClose} disabled={llmSaving}>
                Cancel
              </button>
              <button type="submit" disabled={llmSaving}>
                {llmSaving ? 'Saving…' : 'Accept'}
              </button>
            </div>
          </form>
        )}

        {tab === 'agencies' && (
          <div className="agencies-panel">
            <h2>Agencies</h2>
            <p className="settings-hint">
              Create or delete agencies. The default agency cannot be deleted. Use
              the ⚙ next to the agency selector to re-organize an agency&rsquo;s
              analyst flow.
            </p>

            <ul className="agency-admin-list" data-testid="agency-admin-list">
              {agencyList.map((a) => (
                <li
                  key={a.id}
                  className="agency-admin-row"
                  data-testid={`agency-admin-${a.id}`}
                  onClick={() => openEditAgency(a)}
                  style={{ cursor: 'pointer' }}
                  title={`Edit ${a.name}`}
                >
                  <span className="agency-admin-name">{a.name}</span>
                  <span className="agency-admin-meta">
                    {a.analystCount} analysts · {a.horizon}
                    {a.isDefault ? ' · default' : ''}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary btn-danger"
                    data-testid={`agency-delete-${a.id}`}
                    disabled={a.isDefault || agencyBusy}
                    title={a.isDefault ? 'The default agency cannot be deleted' : 'Delete agency'}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteAgency(a.id);
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
              {agencyList.length === 0 && <li className="agency-admin-empty">No agencies loaded.</li>}
            </ul>

            <fieldset className="agency-create">
              <legend>{editAgency ? `Edit agency · ${editAgency.id}` : 'New agency'}</legend>
              <p className="settings-hint">
                Give the agency an id and a display name, pick a horizon, then
                select which analysts run in its flow. At least one analyst and
                an id are required — {editAgency ? '“Save changes” updates the agency' : '“Create agency” adds it to the list above'}.
                Click an agency above to load it here.
              </p>
              <label>
                Id
                <input
                  type="text"
                  value={newId}
                  placeholder="my-custom-agency"
                  aria-label="New agency id"
                  data-testid="new-agency-id"
                  disabled={!!editAgency}
                  onChange={(e) => setNewId(e.target.value)}
                />
              </label>
              <label>
                Name
                <input
                  type="text"
                  value={newName}
                  placeholder="My Custom Agency"
                  aria-label="New agency name"
                  data-testid="new-agency-name"
                  onChange={(e) => setNewName(e.target.value)}
                />
              </label>
              <label>
                Horizon
                <select
                  value={newHorizon}
                  aria-label="New agency horizon"
                  data-testid="new-agency-horizon"
                  onChange={(e) => setNewHorizon(e.target.value)}
                >
                  <option value="LONG_TERM">Long-term</option>
                  <option value="MEDIUM_TERM">Medium-term</option>
                  <option value="INTRADAY">Intraday</option>
                </select>
              </label>
              <div className="agency-screener-row">
                <label>
                  Asset class
                  <select
                    value={newAssetClass}
                    aria-label="New agency asset class"
                    data-testid="new-agency-assetclass"
                    onChange={(e) => setNewAssetClass(e.target.value as 'EQUITY' | 'OPTION' | 'CRYPTO')}
                  >
                    <option value="EQUITY">Equity</option>
                    <option value="OPTION">Option</option>
                    <option value="CRYPTO">Crypto{newAssetClass === 'CRYPTO' ? ' (source TBD)' : ''}</option>
                  </select>
                </label>
                <label>
                  Screener interval
                  <select
                    value={newInterval}
                    aria-label="New agency screener interval"
                    data-testid="new-agency-interval"
                    onChange={(e) => setNewInterval(e.target.value as '1m' | '5m' | '1h' | '4h' | '1d')}
                  >
                    <option value="1m">1m</option>
                    <option value="5m">5m</option>
                    <option value="1h">1h</option>
                    <option value="4h">4h</option>
                    <option value="1d">1d</option>
                  </select>
                </label>
                <label>
                  Lookback days
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={newLookback}
                    aria-label="New agency lookback days"
                    data-testid="new-agency-lookback"
                    onChange={(e) => setNewLookback(Math.max(1, Math.min(365, Number(e.target.value) || 90)))}
                  />
                </label>
                <label>
                  Min volume (shares)
                  <input
                    type="number"
                    min={0}
                    step={100000}
                    value={newMinVolume}
                    aria-label="New agency minimum average daily volume"
                    data-testid="new-agency-minvolume"
                    onChange={(e) => setNewMinVolume(Math.max(0, Number(e.target.value) || 0))}
                  />
                </label>
              </div>
              <p className="settings-hint agency-screener-hint">
                Timeframe + asset class are the agency&apos;s screener defaults — the Stock
                Screener reads them automatically (no per-run picker). Crypto screens the
                equity universe for now (crypto source is TBD). Min volume (0 = off) drops
                any candidate averaging fewer shares/day than the floor.
              </p>
              <div className="agency-create-analysts">
                <span className="agency-create-label">Analysts</span>
                <div className="agency-create-grid">
                  {catalog.map((c) => (
                    <label key={c.id} className="agency-create-opt">
                      <input
                        type="checkbox"
                        checked={newAnalysts.includes(c.id)}
                        onChange={() => toggleNewAnalyst(c.id)}
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              </div>
              <div className="agency-create-actions">
                {editAgency && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={resetAgencyForm}
                    disabled={agencyBusy}
                  >
                    Cancel edit
                  </button>
                )}
                <button
                  type="button"
                  className="btn-primary"
                  data-testid="save-agency"
                  disabled={agencyBusy || !newId.trim() || newAnalysts.length === 0}
                  onClick={handleSaveAgency}
                >
                  {agencyBusy ? 'Working…' : editAgency ? 'Save changes' : 'Create agency'}
                </button>
              </div>
            </fieldset>

            {agencyError && <p className="settings-error" role="alert" data-testid="agency-error">{agencyError}</p>}
          </div>
        )}

        {tab === 'analysts' && (
          <div className="analysts-panel">
            <h2>Analysts</h2>
            <p className="settings-hint">
              Built-in analysts are listed read-only (cannot be edited or deleted).
              Create your own custom analysts, or edit/delete the ones you created.
              Click any analyst row (e.g. Fundamental) to load it into the form below.
              Use the agency <span className="mono">re-org</span> dialog to add a custom
              analyst into a flow.
            </p>

            <div className="analyst-stage-tabs" role="tablist" aria-label="Filter analysts by stage">
              {([1, 2, 3] as const).map((s) => (
                <Fragment key={String(s)}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={stageFilter === s}
                    className={stageFilter === s ? 'settings-tab active' : 'settings-tab'}
                    data-testid={`analyst-stage-${s}`}
                    onClick={() => setStageFilter(s)}
                  >
                    {`Stage ${s}`}
                  </button>
                  {s < 3 && (
                    <span className="stage-arrow" aria-hidden="true" data-testid={`stage-arrow-${s}`}>
                      →
                    </span>
                  )}
                </Fragment>
              ))}
            </div>

            <ul className="analyst-admin-list" data-testid="analyst-admin-list">
              {catalog
                .filter((a) => a.stage === stageFilter)
                .map((a) => {
                const inputs = a.dataSources?.length ?? 0;
                const outputs = a.output?.channels?.length ?? 0;
                return (
                  <li
                    key={a.id}
                    className="analyst-admin-row"
                    data-testid={`analyst-admin-${a.id}`}
                    onClick={() => openEditAnalyst(a)}
                    style={{ cursor: 'pointer' }}
                    title={a.custom ? `Edit ${a.name}` : `${a.name} (built-in — read only)`}
                  >
                    <span className="analyst-admin-name">
                      {a.name}
                      {a.custom && <span className="analyst-admin-tag">custom</span>}
                    </span>
                    <span className="analyst-admin-meta">
                      {a.kind} · stage {a.stage}
                      {inputs > 0 ? ` · ${inputs} input source${inputs === 1 ? '' : 's'}` : ''}
                      {outputs > 0 ? ` · ${outputs} output channel${outputs === 1 ? '' : 's'}` : ''}
                      {!a.custom ? ' · built-in' : ''}
                    </span>
                    {a.custom ? (
                      <>
                        <button
                          type="button"
                          className="btn-secondary"
                          data-testid={`analyst-edit-${a.id}`}
                          disabled={analystBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditAnalyst(a);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn-secondary btn-danger"
                          data-testid={`analyst-delete-${a.id}`}
                          disabled={analystBusy}
                          title={`Delete custom analyst ${a.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteAnalyst(a.id);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn-secondary btn-danger"
                        data-testid={`analyst-delete-${a.id}`}
                        disabled
                        title="Built-in analysts cannot be deleted"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Delete
                      </button>
                    )}
                  </li>
                );
              })}
              {catalog.length === 0 && <li className="analyst-admin-empty">No analysts loaded.</li>}
              {catalog.length > 0 && catalog.filter((a) => a.stage === stageFilter).length === 0 && (
                <li className="analyst-admin-empty">No analysts in this stage.</li>
              )}
            </ul>

            <fieldset className="analyst-create">
              <legend>{editAnalyst ? `Edit analyst · ${editAnalyst.id}` : 'New analyst'}</legend>
              <p className="settings-hint">
                Configure the analyst across four sections. At least id + name (General tab) are
                required; input data, Role &amp; Instructions, and output data are optional.
              </p>

              <div className="analyst-stage-tabs" role="tablist" aria-label="Analyst edit sections">
                {(['general', 'input', 'analysis', 'output'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={analystEditTab === t}
                    className={analystEditTab === t ? 'settings-tab active' : 'settings-tab'}
                    data-testid={`analyst-edit-tab-${t}`}
                    onClick={() => setAnalystEditTab(t)}
                  >
                    {t === 'general' ? 'General' : t === 'input' ? 'Input' : t === 'analysis' ? 'Analysis' : 'Output'}
                  </button>
                ))}
              </div>

              {analystEditTab === 'general' && (
                <div className="analyst-edit-panel" data-testid="analyst-edit-general">
                  <div className="analyst-create-grid2">
                    <label>
                      Id
                      <input
                        type="text"
                        value={aId}
                        placeholder="my-custom-analyst"
                        aria-label="New analyst id"
                        data-testid="new-analyst-id"
                        disabled={!!editAnalyst}
                        onChange={(e) => setAId(e.target.value)}
                      />
                    </label>
                    <label>
                      Name
                      <input
                        type="text"
                        value={aName}
                        placeholder="My Custom Analyst"
                        aria-label="New analyst name"
                        data-testid="new-analyst-name"
                        onChange={(e) => setAName(e.target.value)}
                      />
                    </label>
                    <label>
                      Role
                      <input
                        type="text"
                        value={aRole}
                        placeholder="short role line"
                        aria-label="New analyst role"
                        onChange={(e) => setARole(e.target.value)}
                      />
                    </label>
                    <label>
                      Monogram
                      <input
                        type="text"
                        value={aMonogram}
                        placeholder="e.g. FA"
                        maxLength={2}
                        aria-label="New analyst monogram"
                        data-testid="new-analyst-monogram"
                        onChange={(e) => setAMonogram(e.target.value)}
                      />
                    </label>
                    <label>
                      Kind
                      <select
                        value={aKind}
                        aria-label="New analyst kind"
                        data-testid="new-analyst-kind"
                        onChange={(e) => setAKind(e.target.value as AnalystKind)}
                      >
                        <option value="orchestrator">orchestrator</option>
                        <option value="ingestion">ingestion</option>
                        <option value="analyst">analyst</option>
                        <option value="gatekeeper">gatekeeper</option>
                      </select>
                    </label>
                    <label>
                      Stage
                      <select
                        value={aStage}
                        aria-label="New analyst stage"
                        onChange={(e) => setAStage(e.target.value as typeof aStage)}
                      >
                        <option value="1">1 · intake</option>
                        <option value="2">2 · analysis</option>
                        <option value="3">3 · decision</option>
                      </select>
                    </label>
                    <label>
                      Accent
                      <input
                        type="color"
                        value={aAccent}
                        aria-label="New analyst accent color"
                        onChange={(e) => setAAccent(e.target.value)}
                      />
                    </label>
                    <label>
                      On all sources failed
                      <select
                        value={aOnFail}
                        aria-label="New analyst on-all-sources-failed policy"
                        data-testid="new-analyst-onfail"
                        onChange={(e) => setAOnFail(e.target.value as typeof aOnFail)}
                      >
                        <option value="">(default)</option>
                        <option value="fail">fail</option>
                        <option value="degrade">degrade</option>
                        <option value="useMock">useMock</option>
                      </select>
                    </label>
                  </div>

                  <label>
                    Depends on (comma-separated analyst ids)
                    <input
                      type="text"
                      value={aDependsOn}
                      placeholder="e.g. data_ingestion, fundamental"
                      aria-label="New analyst dependencies"
                      onChange={(e) => setADependsOn(e.target.value)}
                    />
                  </label>
                </div>
              )}

              {analystEditTab === 'input' && (
                <div className="analyst-edit-panel" data-testid="analyst-edit-input">
                  <div className="analyst-create-sources">
                    <span className="agency-create-label">Input data (dataSources)</span>
                    {aSources.map((s, idx) => (
                      <div className="source-row" key={idx} data-testid={`analyst-src-${idx}`}>
                        <input
                          type="text"
                          placeholder="id"
                          aria-label="source id"
                          value={s.id}
                          onChange={(e) => updateSourceRow(idx, { id: e.target.value })}
                        />
                        <input
                          type="text"
                          placeholder="label"
                          aria-label="source label"
                          value={s.label}
                          onChange={(e) => updateSourceRow(idx, { label: e.target.value })}
                        />
                        <input
                          type="text"
                          placeholder="from"
                          aria-label="source from"
                          value={s.from}
                          onChange={(e) => updateSourceRow(idx, { from: e.target.value })}
                        />
                        <input
                          type="text"
                          placeholder="fields (csv)"
                          aria-label="source fields"
                          value={s.fields}
                          onChange={(e) => updateSourceRow(idx, { fields: e.target.value })}
                        />
                        <input
                          type="text"
                          placeholder="sources (csv)"
                          aria-label="source names"
                          value={s.sources}
                          onChange={(e) => updateSourceRow(idx, { sources: e.target.value })}
                        />
                        <button
                          type="button"
                          className="btn-secondary"
                          aria-label="Remove source"
                          data-testid={`analyst-src-remove-${idx}`}
                          onClick={() => removeSourceRow(idx)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <button type="button" className="extra-add" onClick={addSourceRow} disabled={analystBusy}>
                      + Add input source
                    </button>
                  </div>
                </div>
              )}

              {analystEditTab === 'analysis' && (
                <div className="analyst-edit-panel" data-testid="analyst-edit-analysis">
                  <p className="settings-hint">
                    Role &amp; Instructions — the system prompt this analyst runs under (a single
                    flavor). Saved as the analyst&rsquo;s default flavor; the LLM step uses it when
                    enabled and a provider token is set in Settings → LLM Models.
                  </p>
                  <div className="analyst-create-grid2">
                    <label>
                      Flavor name
                      <input
                        type="text"
                        value={aFlavorName}
                        placeholder="e.g. Balanced"
                        aria-label="Flavor name"
                        data-testid="new-analyst-flavor-name"
                        onChange={(e) => setAFlavorName(e.target.value)}
                      />
                    </label>
                    <label>
                      Role (short summary)
                      <input
                        type="text"
                        value={aFlavorRole}
                        placeholder="e.g. Skew · term structure · IV rank"
                        aria-label="Flavor role"
                        data-testid="new-analyst-flavor-role"
                        onChange={(e) => setAFlavorRole(e.target.value)}
                      />
                    </label>
                  </div>
                  <label>
                    Instructions
                    <textarea
                      className="flavor-instructions"
                      value={aFlavorInstructions}
                      rows={10}
                      placeholder="ROLE / OBJECTIVE / METHOD / OUTPUT CONTRACT / SCORING …"
                      aria-label="Flavor instructions"
                      data-testid="new-analyst-flavor-instructions"
                      onChange={(e) => setAFlavorInstructions(e.target.value)}
                    />
                  </label>
                  <div className="analyst-create-grid2">
                    <label>
                      LLM model role
                      <select
                        value={aFlavorModelRole}
                        aria-label="Flavor model role"
                        data-testid="new-analyst-flavor-modelrole"
                        onChange={(e) => setAFlavorModelRole(e.target.value as typeof aFlavorModelRole)}
                      >
                        <option value="deep-thought">deep-thought</option>
                        <option value="scanner">scanner</option>
                        <option value="flexible">flexible</option>
                      </select>
                    </label>
                    <label className="settings-field flavor-llm-toggle">
                      <input
                        type="checkbox"
                        checked={aFlavorEnabled}
                        onChange={(e) => setAFlavorEnabled(e.target.checked)}
                        aria-label="Use LLM for this flavor"
                        data-testid="new-analyst-flavor-enabled"
                      />
                      <span>Use LLM for this flavor</span>
                    </label>
                  </div>
                </div>
              )}

              {analystEditTab === 'output' && (
                <div className="analyst-edit-panel" data-testid="analyst-edit-output">
                  <fieldset className="analyst-output">
                    <legend>Output data (output)</legend>
                    <label>
                      Channels (comma-separated)
                      <input
                        type="text"
                        value={aOutChannels}
                        placeholder="e.g. my_analysis"
                        aria-label="Output channels"
                        onChange={(e) => setAOutChannels(e.target.value)}
                      />
                    </label>
                    <div className="analyst-create-grid2">
                      <label>
                        Verdict field
                        <input
                          type="text"
                          value={aOutVerdict}
                          placeholder="verdict"
                          aria-label="Output verdict field"
                          onChange={(e) => setAOutVerdict(e.target.value)}
                        />
                      </label>
                      <label>
                        Score field
                        <input
                          type="text"
                          value={aOutScore}
                          placeholder="score"
                          aria-label="Output score field"
                          onChange={(e) => setAOutScore(e.target.value)}
                        />
                      </label>
                    </div>
                    <label className="settings-field flavor-llm-toggle">
                      <input
                        type="checkbox"
                        checked={aOutStore}
                        onChange={(e) => setAOutStore(e.target.checked)}
                        aria-label="Store in messages"
                      />
                      <span>Store output in messages</span>
                    </label>
                  </fieldset>
                </div>
              )}

              <div className="analyst-create-actions">
                {editAnalyst && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={resetAnalystForm}
                    disabled={analystBusy}
                  >
                    Cancel edit
                  </button>
                )}
                <button
                  type="button"
                  className="btn-primary"
                  data-testid="save-analyst"
                  disabled={analystBusy || !aId.trim() || !aName.trim() || (editAnalyst ? !editAnalyst.custom : false)}
                  onClick={handleSaveAnalyst}
                >
                  {analystBusy ? 'Working…' : editAnalyst ? 'Save changes' : 'Create analyst'}
                </button>
              </div>
            </fieldset>

            {analystError && <p className="settings-error" role="alert" data-testid="analyst-error">{analystError}</p>}
          </div>
        )}

        {tab === 'sources' && (
          <div className="sources-tab">
            <h2>Data Ingestion — Source Credentials</h2>
            <p className="settings-hint">
              Per-source API keys &amp; Base URIs for the Data Ingestion analyst. Saved
              credentials are encrypted (GPG/AES) and persist across restarts. Alpha Vantage
              and Finnhub Base URIs are pre-filled — just confirm or edit.
            </p>
            {sourceCatalogError && (
              <p className="settings-error" role="alert">{sourceCatalogError}</p>
            )}
            {vaultDisabled && (
              <p className="settings-warn" role="alert" data-testid="vault-disabled-warning">
                ⚠ Token storage is disabled on the server (no LLM_VAULT_PASSPHRASE set). Saved
                credentials are kept in memory only and will be lost on restart. Set the
                LLM_VAULT_PASSPHRASE env var to enable encrypted persistence.
              </p>
            )}
            {!sourceCatalogError && diSources.length === 0 && !sourceCatalog && (
              <p className="settings-hint">Loading source catalog…</p>
            )}
            {diSources.length === 0 && sourceCatalog && (
              <p className="settings-hint">Data Ingestion has no credentialed sources.</p>
            )}
            {diSources.length > 0 && (
              <SourcesTab
                ref={sourcesRef}
                analystId="data_ingestion"
                sessionId={sessionId}
                sources={diSources}
              />
            )}
            {diSources.length > 0 && (
              <div className="settings-actions">
                <button type="button" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await sourcesRef.current?.save();
                    // Re-fetch so the "stored" indicator is truthful on reopen,
                    // then close the dialog (the Accept button commits + dismisses).
                    getAnalystSourceCatalog()
                      .then((cat) => {
                        setSourceCatalog(cat.analysts.find((a) => a.analystId === 'data_ingestion') ?? null);
                        setVaultDisabled(cat.vaultDisabled === true);
                      })
                      .catch(() => {})
                      .finally(() => onClose());
                  }}
                  data-testid="sources-save"
                >
                  Accept
                </button>
              </div>
            )}
          </div>
        )}

        {tab === 'domains' && (
          <div className="domain-sources-tab-wrap">
            <h2>Data Sources per Domain</h2>
            <DomainSourcesTab
              ref={domainSourcesRef}
              sessionId={sessionId}
              onSaved={() => { /* keep dialog open; changes apply next run */ }}
            />
            <div className="settings-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="domains-save"
                disabled={saving}
                onClick={async () => {
                  const ok = await domainSourcesRef.current?.save();
                  if (ok) onClose();
                }}
              >
                Accept
              </button>
            </div>
          </div>
        )}

        {tab === 'log' && (
          <div className="server-log-panel">
            <h2>Server Log</h2>
            <p className="settings-hint">
              Live tail of <code>logs/server.log</code> — shows LLM call attempts,
              vault status, and analysis runs (auto-refreshes every 3s).
            </p>
            <div className="server-log-controls">
              <label>
                Lines
                <select
                  value={logLines}
                  aria-label="Log line count"
                  onChange={(e) => setLogLines(Number(e.target.value))}
                >
                  <option value={50}>50</option>
                  <option value={200}>200</option>
                  <option value={500}>500</option>
                  <option value={1000}>1000</option>
                </select>
              </label>
              <button type="button" className="extra-add" onClick={loadLog} disabled={logLoading}>
                {logLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            {logError && <p className="settings-error" role="alert">{logError}</p>}
            <pre className="server-log-view" data-testid="server-log" aria-label="Server log">
{logContent}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default SettingsDialog;
