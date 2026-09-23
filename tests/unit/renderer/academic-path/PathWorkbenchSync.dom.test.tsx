import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Message } from '@arco-design/web-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PathWorkbench from '@renderer/pages/academic-path/components/PathWorkbench';
import type { CourseStatus, ProgramPlan, StudentProgress } from '@renderer/pages/academic-path/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/pages/academic-path/components/FloatingAIAssistant', () => ({ default: () => null }));

const plan: ProgramPlan = {
  id: 'document-1',
  name: 'Curriculum',
  major: 'Computer Science',
  grade: '2026',
  version: '1.0',
  totalCredits: 6,
  courses: [
    {
      id: 'course-1',
      name: 'Calculus',
      credits: 3,
      category: 'required',
      categoryLabel: 'Required',
      semester: 1,
      prerequisites: [],
    },
    {
      id: 'course-2',
      name: 'Advanced Calculus',
      credits: 3,
      category: 'required',
      categoryLabel: 'Required',
      semester: 2,
      prerequisites: [],
    },
  ],
  recommendedSequences: [{ from: 'course-1', to: 'course-2', page: 3 }],
  createdAt: '2026-09-23T00:00:00.000Z',
  isCurrent: true,
};

function Harness({ onSync }: { onSync: () => Promise<boolean> }) {
  const [progress, setProgress] = useState<StudentProgress>({
    planId: plan.id,
    courseStatuses: { 'course-1': 'not_taken' },
  });
  const onCourseStatusChange = (courseId: string, status: CourseStatus) => {
    setProgress((previous) => ({
      ...previous,
      courseStatuses: { ...previous.courseStatuses, [courseId]: status },
    }));
  };
  return (
    <PathWorkbench
      plan={plan}
      progress={progress}
      onCourseStatusChange={onCourseStatusChange}
      onSync={onSync}
      onViewHistory={vi.fn()}
      onReupload={vi.fn()}
      onBack={vi.fn()}
      onCourseEdit={vi.fn()}
    />
  );
}

describe('academic path progress synchronization', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a real error and does not show success when persistence fails', async () => {
    const errorSpy = vi.spyOn(Message, 'error').mockImplementation(() => ({}) as never);
    const onSync = vi.fn().mockResolvedValue(false);
    render(<Harness onSync={onSync} />);

    fireEvent.click(screen.getByText('Calculus'));
    fireEvent.click(screen.getByRole('button', { name: '✓ 已通过' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认并同步学业状态' }));

    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith('mcp.curriculumProgressSaveFailed'));
    expect(screen.queryByText(/AI 已可以使用最新学业状态/)).not.toBeInTheDocument();
  });

  it('renders vision-recognized recommended sequences as dashed edges', async () => {
    const { container } = render(<Harness onSync={vi.fn().mockResolvedValue(true)} />);

    await waitFor(() => expect(container.querySelector('path[stroke-dasharray="6 4"]')).not.toBeNull());
  });
});
