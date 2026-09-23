import React from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@renderer/pages/policy-comparison/PolicyEntryView', () => ({ default: () => <div>Policy entry</div> }));
vi.mock('@renderer/pages/policy-comparison/PolicyDiffView', () => ({ default: () => null }));
vi.mock('@renderer/pages/policy-comparison/PolicyHistoryView', () => ({ default: () => null }));

import PolicyComparisonPage from '@renderer/pages/policy-comparison/PolicyComparisonPage';

describe('policy comparison production data', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts with empty history instead of seeding mock records', () => {
    render(<PolicyComparisonPage />);

    expect(JSON.parse(localStorage.getItem('policy-comparison:history') ?? 'null')).toEqual([]);
  });
});
