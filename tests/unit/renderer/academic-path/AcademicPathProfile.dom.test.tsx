import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgramPlan } from '@renderer/pages/academic-path/types';

const navigateMock = vi.fn();
const parseProgramPlanMock = vi.hoisted(() => vi.fn());
const loadProgramGraphMock = vi.hoisted(() => vi.fn());
const loadCourseStatusesMock = vi.hoisted(() => vi.fn());
const saveCourseStatusesMock = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/pages/academic-path/programParser', () => ({
  adaptMcpPlan: () => testPlan,
  parseProgramPlan: parseProgramPlanMock,
  loadProgramGraph: loadProgramGraphMock,
  mergeProgramGraphWithPreview: (preview: ProgramPlan, graph: ProgramPlan) => ({
    ...graph,
    id: preview.id,
    recommendedSequences: preview.recommendedSequences,
  }),
}));
vi.mock('@renderer/pages/academic-path/progressClient', () => ({
  loadCourseStatuses: loadCourseStatusesMock,
  saveCourseStatuses: saveCourseStatusesMock,
}));
vi.mock('@renderer/pages/academic-path/components/EmptyState', () => ({
  default: ({
    onDebugInject,
    onUpload,
    parseError,
  }: {
    onDebugInject: (value: object) => void;
    onUpload: (path: string) => void;
    parseError?: { code: string } | null;
  }) => (
    <div>
      <button type='button' onClick={() => onDebugInject({})}>
        Import plan
      </button>
      <button type='button' onClick={() => onUpload('C:\\plans\\curriculum.pdf')}>
        Upload plan
      </button>
      {parseError && <span>{parseError.code}</span>}
    </div>
  ),
}));
vi.mock('@renderer/pages/academic-path/components/ConfirmPlan', () => ({
  default: ({ plan, onConfirm }: { plan: ProgramPlan; onConfirm: (value: ProgramPlan) => void }) => (
    <div>
      <span data-testid='confirm-plan'>{plan.id}</span>
      <span data-testid='confirm-course'>{plan.courses[0]?.id}</span>
      <button type='button' onClick={() => onConfirm(plan)}>
        Confirm plan
      </button>
    </div>
  ),
}));
vi.mock('@renderer/pages/academic-path/components/PathWorkbench', () => ({
  default: ({
    progress,
    onSync,
  }: {
    progress: { planId: string; courseStatuses: object };
    onSync: () => Promise<boolean>;
  }) => (
    <div>
      <span>Path content</span>
      <span data-testid='progress'>{JSON.stringify(progress)}</span>
      <button type='button' onClick={() => void onSync()}>
        Sync progress
      </button>
    </div>
  ),
}));
vi.mock('@renderer/pages/academic-path/components/PlanHistory', () => ({
  default: ({ onSwitch }: { onSwitch: (plan: ProgramPlan) => void }) => (
    <button type='button' onClick={() => onSwitch(historyPlan)}>
      Switch plan
    </button>
  ),
}));
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

const historyPlan: ProgramPlan = {
  ...testPlan,
  id: 'curriculum-history',
  name: 'History curriculum',
  courses: [
    {
      id: 'new-course',
      name: 'New course',
      credits: 3,
      category: 'required',
      categoryLabel: 'Required',
      semester: 1,
      prerequisites: [],
    },
  ],
};

import AcademicPathPage from '@renderer/pages/academic-path/AcademicPathPage';

describe('academic path profile navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    loadProgramGraphMock.mockResolvedValue({ type: 'failed', errorCode: 'CATALOG_NOT_READY' });
    loadCourseStatusesMock.mockResolvedValue(null);
    saveCourseStatusesMock.mockResolvedValue(true);
  });

  it('opens My Info from the top navigation and returns to the path', () => {
    localStorage.setItem('academic-path:current-plan', JSON.stringify(testPlan));
    localStorage.setItem('academic-path:progress', JSON.stringify({ planId: testPlan.id, courseStatuses: {} }));
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

  it('does not seed mock plan, progress, or history on first entry', () => {
    render(<AcademicPathPage />);

    expect(localStorage.getItem('academic-path:current-plan')).toBeNull();
    expect(localStorage.getItem('academic-path:progress')).toBeNull();
    expect(localStorage.getItem('academic-path:history')).toBeNull();
  });

  it('allows another upload attempt after parsing fails', async () => {
    parseProgramPlanMock.mockResolvedValue({ type: 'failed', errorCode: 'INGEST_FAILED' });
    render(<AcademicPathPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Upload plan' }));
    await screen.findByText('INGEST_FAILED');
    fireEvent.click(screen.getByRole('button', { name: 'Upload plan' }));

    await waitFor(() => expect(parseProgramPlanMock).toHaveBeenCalledTimes(2));
  });

  it('shows the upload preview without waiting for full graph extraction', async () => {
    let resolveGraph!: (value: { type: 'ready'; plan: ProgramPlan; warnings: string[] }) => void;
    const graphPromise = new Promise<{ type: 'ready'; plan: ProgramPlan; warnings: string[] }>((resolve) => {
      resolveGraph = resolve;
    });
    parseProgramPlanMock.mockResolvedValue({ type: 'ready', plan: testPlan, warnings: [] });
    loadProgramGraphMock.mockReturnValue(graphPromise);
    render(<AcademicPathPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Upload plan' }));

    expect(await screen.findByTestId('confirm-plan')).toHaveTextContent(testPlan.id);
    expect(screen.getByTestId('confirm-course')).toBeEmptyDOMElement();

    resolveGraph({ type: 'ready', plan: historyPlan, warnings: [] });
    await waitFor(() => expect(screen.getByTestId('confirm-course')).toHaveTextContent('new-course'));
  });

  it('keeps the real preview when full graph extraction is not ready', async () => {
    parseProgramPlanMock.mockResolvedValue({ type: 'ready', plan: testPlan, warnings: [] });
    render(<AcademicPathPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Upload plan' }));

    expect(await screen.findByTestId('confirm-plan')).toHaveTextContent(testPlan.id);
  });

  it('does not mark progress as synced when backend persistence fails', async () => {
    localStorage.setItem('academic-path:current-plan', JSON.stringify(testPlan));
    localStorage.setItem(
      'academic-path:progress',
      JSON.stringify({ planId: testPlan.id, courseStatuses: {}, lastSyncedAt: 'before' })
    );
    saveCourseStatusesMock.mockResolvedValue(false);
    render(<AcademicPathPage />);

    fireEvent.click(screen.getByRole('button', { name: '我的学业路径' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sync progress' }));

    await waitFor(() => expect(saveCourseStatusesMock).toHaveBeenCalledWith(testPlan.id, {}));
    expect(JSON.parse(localStorage.getItem('academic-path:progress') ?? '{}').lastSyncedAt).toBe('before');
  });

  it('isolates course statuses when switching plans and restores only the target plan statuses', async () => {
    const currentPlan = { ...testPlan, courses: [{ ...historyPlan.courses[0], id: 'old-course' }] };
    localStorage.setItem('academic-path:current-plan', JSON.stringify(currentPlan));
    localStorage.setItem(
      'academic-path:progress',
      JSON.stringify({ planId: currentPlan.id, courseStatuses: { 'old-course': 'passed' } })
    );
    localStorage.setItem('academic-path:history', JSON.stringify([currentPlan, historyPlan]));
    loadCourseStatusesMock.mockResolvedValue({ 'new-course': 'failed' });
    render(<AcademicPathPage />);

    fireEvent.click(screen.getByRole('button', { name: '培养方案历史' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch plan' }));

    await waitFor(() => expect(screen.getByTestId('progress')).toHaveTextContent('"new-course":"failed"'));
    expect(screen.getByTestId('progress')).not.toHaveTextContent('old-course');
  });
});
