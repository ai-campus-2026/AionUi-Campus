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
vi.mock('@renderer/pages/academic-path/progressClient', () => ({
  clearCourseStatuses: vi.fn(),
  loadCourseStatuses: vi.fn().mockResolvedValue(null),
  saveCourseStatuses: vi.fn(),
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
  default: ({ onViewProfile }: { onViewProfile: () => void }) => (
    <button type='button' onClick={onViewProfile}>
      Open profile
    </button>
  ),
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

  it('opens My Info after a curriculum is confirmed and returns to the path', async () => {
    render(<AcademicPathPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Import plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));

    expect(screen.getByText('Profile content')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'mcp.curriculumBackToPath' }));
    expect(screen.getByRole('button', { name: 'Open profile' })).toBeInTheDocument();
  });

  it('does not expose My Info before a curriculum is confirmed', () => {
    render(<AcademicPathPage />);

    expect(screen.queryByRole('button', { name: 'Open profile' })).not.toBeInTheDocument();
  });
});
