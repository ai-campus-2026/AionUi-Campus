import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgramPlan } from '@renderer/pages/academic-path/types';

const navigateMock = vi.fn();

vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/pages/academic-path/programParser', () => ({
  adaptMcpPlan: () => testPlan,
  parseProgramPlan: vi.fn(),
}));
vi.mock('@renderer/pages/academic-path/components/EmptyState', () => ({
  default: ({ onDebugInject }: { onDebugInject: (value: object) => void }) => (
    <button type='button' onClick={() => onDebugInject({})}>
      Import plan
    </button>
  ),
}));
vi.mock('@renderer/pages/academic-path/components/ConfirmPlan', () => ({
  default: ({ plan, onConfirm }: { plan: ProgramPlan; onConfirm: (value: ProgramPlan) => void }) => (
    <button type='button' onClick={() => onConfirm(plan)}>
      Confirm plan
    </button>
  ),
}));
vi.mock('@renderer/pages/academic-path/components/PathWorkbench', () => ({
  default: () => <div>Path content</div>,
}));
vi.mock('@renderer/pages/academic-path/components/PlanHistory', () => ({ default: () => null }));
vi.mock('@renderer/pages/academic-path/components/MyInfo', () => ({
  default: () => <div>Profile content</div>,
}));
vi.mock('@renderer/pages/academic-path/components/FloatingAIAssistant', () => ({ default: () => null }));

const testPlan: ProgramPlan = {
  id: 'curriculum-test',
  name: 'Test curriculum',
  major: 'Computer Science',
  grade: '2026',
  version: '1.0',
  totalCredits: 120,
  courses: [],
  createdAt: '2026-09-23T00:00:00.000Z',
  isCurrent: false,
};

import AcademicPathPage from '@renderer/pages/academic-path/AcademicPathPage';

describe('academic path profile navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    navigateMock.mockReset();
  });

  it('opens My Info from the top navigation and returns to the path', () => {
    render(<AcademicPathPage />);

    fireEvent.click(screen.getByRole('button', { name: '我的信息' }));

    expect(screen.getByText('Profile content')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '我的学业路径' }));
    expect(screen.getByText('Path content')).toBeInTheDocument();
  });

  it('exposes the original top-level navigation on the import view', () => {
    render(<AcademicPathPage />);

    expect(screen.getByRole('button', { name: '我的信息' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '培养方案历史' })).toBeInTheDocument();
  });
});
