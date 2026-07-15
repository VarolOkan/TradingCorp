// frontend/src/components/analysts/AgencySelect.tsx
// Dropdown that lets the user pick which AGENCY (node composition) to run.
// The selected agency drives the wall's panel set (see AnalysisView), so
// agencies with a different node count / different analysts (e.g. the 4-node
// crypto-screener) render correctly instead of the hardcoded 7-panel layout.

import React from 'react';
import { AGENCIES, AGENCY_IDS, type AgencyId } from './agencies';

export interface AgencySelectProps {
  value: AgencyId;
  onChange: (id: AgencyId) => void;
  /** Disable the dropdown (e.g. while an analysis is running). */
  disabled?: boolean;
}

export function AgencySelect({ value, onChange, disabled = false }: AgencySelectProps) {
  const current = AGENCIES[value];
  return (
    <label className="agency-select" title={current?.description ?? ''}>
      <span className="agency-select-label">Agency</span>
      <span className="agency-select-field">
        <select
          className="agency-select-input"
          value={value}
          onChange={(e) => onChange(e.target.value as AgencyId)}
          aria-label="Select analysis agency"
          disabled={disabled}
        >
          {AGENCY_IDS.map((id) => (
            <option key={id} value={id}>
              {AGENCIES[id].name}
            </option>
          ))}
        </select>
        <span className="agency-select-chevron" aria-hidden>▾</span>
      </span>
      <span className="agency-select-meta">{current?.description}</span>
    </label>
  );
}
