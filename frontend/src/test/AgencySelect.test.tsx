// frontend/src/test/AgencySelect.test.tsx
// §15 — agency dropdown renders one <option> per agency and the styled pill.
import { render, screen, fireEvent } from '@testing-library/react';
import { AgencySelect } from '../components/analysts/AgencySelect';
import { AGENCY_IDS, AGENCIES } from '../components/analysts/agencies';

describe('AgencySelect', () => {
  it('renders one <option> per agency', () => {
    render(<AgencySelect value={AGENCY_IDS[0]} onChange={() => {}} />);
    const options = screen.getAllByRole('option');
    expect(options.length).toBe(AGENCY_IDS.length);
    for (const id of AGENCY_IDS) {
      expect(screen.getByRole('option', { name: AGENCIES[id].name })).toBeInTheDocument();
    }
  });

  it('uses the restyled pill markup (accent left-bar, custom chevron)', () => {
    const { container } = render(<AgencySelect value={AGENCY_IDS[0]} onChange={() => {}} />);
    expect(container.querySelector('.agency-select-field')).not.toBeNull();
    expect(container.querySelector('.agency-select-input')).not.toBeNull();
    expect(container.querySelector('.agency-select-chevron')).not.toBeNull();
    expect(container.querySelector('.agency-select-meta')).not.toBeNull();
  });

  it('calls onChange with the new agency id', () => {
    const onChange = vi.fn();
    render(<AgencySelect value={AGENCY_IDS[0]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Select analysis agency'), {
      target: { value: AGENCY_IDS[1] },
    });
    expect(onChange).toHaveBeenCalledWith(AGENCY_IDS[1]);
  });

  it('is disabled when disabled=true (blocks agency switching while running)', () => {
    const onChange = vi.fn();
    render(<AgencySelect value={AGENCY_IDS[0]} onChange={onChange} disabled />);
    const select = screen.getByLabelText('Select analysis agency') as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect(select.disabled).toBe(true);
  });
});

