// frontend/src/api/registryClient.ts
// Client for the per-user agency re-org + agency CRUD endpoints (Phase 1).
// Mirrors analystConfigClient.ts: collects a userId from ?userId, never echoes
// secrets, and returns a safe summary.

import type { AgencyAnalystRef, AgencyDef, AnalystDef } from '../../../src/types/registry';

export interface CatalogAnalyst extends AnalystDef {
  /** true = user-created (editable/deletable); false = built-in (guarded). */
  custom: boolean;
}

export interface RegistryCatalog {
  catalog: CatalogAnalyst[];
  agencies: AgencySummary[];
  driver?: 'json' | 'sqlite';
}

export interface AgencySummary {
  id: string;
  name: string;
  horizon: string;
  instrument?: 'EQUITY' | 'OPTION';
  /** Asset class this agency screens (EQUITY / OPTION / CRYPTO). Phase 22. */
  assetClass?: 'EQUITY' | 'OPTION' | 'CRYPTO';
  /** Explicit screener bar interval (Phase 22). */
  screenerInterval?: '1m' | '5m' | '1h' | '4h' | '1d';
  /** Explicit screener lookback in days (Phase 22). */
  screenerLookbackDays?: number;
  /** Minimum average DAILY bar volume (shares) the agency screens for. Phase 25. */
  minVolumeDaily?: number;
  /** Ordered analyst ids that make up this agency. */
  analysts?: string[];
  analystCount: number;
  isDefault: boolean;
}

/** GET the live analyst catalog + the user's agencies. */
export async function getRegistry(userId = 'default'): Promise<RegistryCatalog> {
  const res = await fetch(`/registry?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error(`Failed to load registry: HTTP ${res.status}`);
  return (await res.json()) as RegistryCatalog;
}

/** PUT the analyst flow for an agency (ordered refs + optional feeds-into). */
export async function putAgencyAnalysts(
  agencyId: string,
  body: { analysts: AgencyAnalystRef[]; feedInto?: Record<string, string[]> },
  userId = 'default',
): Promise<{ ok: boolean; id: string; analysts: AgencyAnalystRef[] }> {
  const res = await fetch(
    `/registry/agency/${encodeURIComponent(agencyId)}?userId=${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) msg = d.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await res.json()) as { ok: boolean; id: string; analysts: AgencyAnalystRef[] };
}

/** POST a new agency definition. */
export async function postAgency(
  def: AgencyDef,
  userId = 'default',
): Promise<{ ok: boolean; id: string }> {
  const res = await fetch(
    `/registry/agency?userId=${encodeURIComponent(userId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
    },
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) msg = d.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await res.json()) as { ok: boolean; id: string };
}

/** PUT (edit) an existing agency: membership + name/horizon + Phase 22
 *  screener settings (assetClass / screenerInterval / screenerLookbackDays). */
export async function putAgency(
  agencyId: string,
  def: Partial<AgencyDef> & {
    analysts: AgencyAnalystRef[];
    assetClass?: 'EQUITY' | 'OPTION' | 'CRYPTO';
    screenerInterval?: '1m' | '5m' | '1h' | '4h' | '1d';
    screenerLookbackDays?: number;
    minVolumeDaily?: number;
  },
  userId = 'default',
): Promise<{ ok: boolean; id: string; analysts: AgencyAnalystRef[] }> {
  const res = await fetch(
    `/registry/agency/${encodeURIComponent(agencyId)}?userId=${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
    },
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) msg = d.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await res.json()) as { ok: boolean; id: string; analysts: AgencyAnalystRef[] };
}

/** DELETE a (non-default) agency. */
export async function deleteAgency(
  agencyId: string,
  userId = 'default',
): Promise<{ ok: boolean; id: string }> {
  const res = await fetch(
    `/registry/agency/${encodeURIComponent(agencyId)}?userId=${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) msg = d.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await res.json()) as { ok: boolean; id: string };
}

/** POST a new custom analyst definition. */
export async function postAnalyst(
  def: AnalystDef,
  userId = 'default',
): Promise<{ ok: boolean; id: string; analyst: AnalystDef }> {
  const res = await fetch(
    `/registry/analyst?userId=${encodeURIComponent(userId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
    },
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) msg = d.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await res.json()) as { ok: boolean; id: string; analyst: AnalystDef };
}

/** PUT (edit) an existing custom analyst definition. */
export async function putAnalyst(
  analystId: string,
  def: AnalystDef,
  userId = 'default',
): Promise<{ ok: boolean; id: string; analyst: AnalystDef }> {
  const res = await fetch(
    `/registry/analyst/${encodeURIComponent(analystId)}?userId=${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
    },
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) msg = d.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await res.json()) as { ok: boolean; id: string; analyst: AnalystDef };
}

/** DELETE a custom analyst. */
export async function deleteAnalyst(
  analystId: string,
  userId = 'default',
): Promise<{ ok: boolean; id: string }> {
  const res = await fetch(
    `/registry/analyst/${encodeURIComponent(analystId)}?userId=${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) msg = d.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await res.json()) as { ok: boolean; id: string };
}
