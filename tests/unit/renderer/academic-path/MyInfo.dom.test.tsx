import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import MyInfo from '@renderer/pages/academic-path/components/MyInfo';
import type { ProgramPlan, StudentProgress } from '@renderer/pages/academic-path/types';

const plan: ProgramPlan = {
  id: 'curriculum-test',
  name: 'Test curriculum',
  major: 'Software Engineering',
  grade: '2026',
  version: '1.0',
  totalCredits: 100,
  courses: [
    {
      id: 'course-1',
      name: 'Algorithms',
      credits: 4,
      category: 'required',
      categoryLabel: 'Required',
      semester: 1,
      prerequisites: [],
      gpa: 3.5,
    },
  ],
  createdAt: '2026-09-23T00:00:00.000Z',
  isCurrent: true,
};

const progress: StudentProgress = {
  planId: plan.id,
  courseStatuses: { 'course-1': 'passed' },
};

describe('MyInfo', () => {
  beforeEach(() => localStorage.clear());

  it('derives academic progress from the active curriculum', () => {
    render(<MyInfo plan={plan} progress={progress} />);

    expect(screen.getByText('4', { selector: '.ap-profile-stat-value' })).toBeInTheDocument();
    expect(screen.getAllByText('3.50')).toHaveLength(2);
  });

  it('persists edited profile fields locally', () => {
    render(<MyInfo plan={plan} progress={progress} />);

    fireEvent.change(screen.getByPlaceholderText('请输入姓名'), { target: { value: '测试用户' } });

    expect(JSON.parse(localStorage.getItem('academic-path:my-info') ?? '{}')).toMatchObject({
      name: '测试用户',
    });
  });
});
