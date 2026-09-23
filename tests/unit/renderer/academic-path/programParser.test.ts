import { describe, expect, it } from 'vitest';
import { mergeProgramGraphWithPreview } from '@renderer/pages/academic-path/programParser';
import type { ProgramPlan } from '@renderer/pages/academic-path/types';

function createPlan(overrides: Partial<ProgramPlan>): ProgramPlan {
  return {
    id: 'document-1',
    name: 'Curriculum',
    major: 'Computer Science',
    grade: '2026',
    version: '1.0',
    totalCredits: 6,
    courses: [],
    createdAt: '2026-09-23T00:00:00.000Z',
    isCurrent: false,
    ...overrides,
  };
}

describe('academic path graph merging', () => {
  it('keeps vision guidance when graph course IDs differ but names match', () => {
    const preview = createPlan({
      courses: [
        {
          id: 'preview-math',
          name: '高等数学',
          credits: 4,
          category: 'required',
          categoryLabel: '必修课',
          semester: 1,
          prerequisites: [],
        },
        {
          id: 'preview-data',
          name: '数据结构',
          credits: 3,
          category: 'core',
          categoryLabel: '专业核心课',
          semester: 2,
          prerequisites: [],
        },
      ],
      recommendedSequences: [{ from: 'preview-math', to: 'preview-data', page: 8 }],
    });
    const graph = createPlan({
      courses: preview.courses.map((course, index) => ({ ...course, id: `CS00${index + 1}` })),
      catalogVerified: true,
    });

    expect(mergeProgramGraphWithPreview(preview, graph).recommendedSequences).toEqual([
      { from: 'CS001', to: 'CS002', page: 8 },
    ]);
  });

  it('drops guidance whose endpoint cannot be matched safely', () => {
    const preview = createPlan({
      courses: [],
      recommendedSequences: [{ from: 'missing-course', to: 'also-missing', page: 8 }],
    });

    expect(mergeProgramGraphWithPreview(preview, createPlan({})).recommendedSequences).toEqual([]);
  });
});
