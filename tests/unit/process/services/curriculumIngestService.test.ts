import { describe, expect, it } from 'vitest';
import {
  summarizeCoursePlan,
  summarizeCourseProgress,
  summarizeCurriculumGraph,
  summarizeCurriculumIngest,
  summarizeCurriculumPlanPreview,
  summarizeCurriculumProbe,
  summarizeExtractionOutcome,
  summarizeProgressClear,
  resolveCurriculumMetadata,
} from '@process/services/CurriculumIngestService';

describe('unverified curriculum preview', () => {
  const preview = {
    success: true,
    major: '计算机科学与技术',
    grade: '2026',
    totalCredits: 158,
    warnings: ['先修关系尚未核实'],
    courses: [
      {
        id: 'CS101',
        name: '程序设计',
        credits: 3,
        category: 'core',
        categoryLabel: '专业核心课',
        suggestedSemester: 1,
        prerequisites: [],
      },
      {
        id: 'CS201',
        name: '数据结构',
        credits: 4,
        category: 'core',
        categoryLabel: '专业核心课',
        suggestedSemester: 3,
        prerequisites: [],
      },
    ],
  };

  it('accepts course nodes without claiming any formal prerequisite', () => {
    const result = summarizeCurriculumPlanPreview(preview);
    expect(result.ok).toBe(true);
    expect(result.plan?.courses).toHaveLength(2);
    expect(result.plan?.warnings).toEqual(['先修关系尚未核实']);
  });

  it('rejects a sequence pointing to an absent course', () => {
    const result = summarizeCurriculumPlanPreview({
      ...preview,
      recommendedSequences: [{ from: 'CS101', to: 'MISSING', page: 5 }],
    });
    expect(result).toEqual({ ok: false, errorCode: 'INVALID_RESPONSE' });
  });

  it('rejects a sequence that reverses the documented semester order', () => {
    const result = summarizeCurriculumPlanPreview({
      ...preview,
      recommendedSequences: [{ from: 'CS201', to: 'CS101', page: 5 }],
    });
    expect(result).toEqual({ ok: false, errorCode: 'INVALID_RESPONSE' });
  });

  it('rejects an unknown prerequisite rather than treating it as a suggestion', () => {
    const courses = [preview.courses[0], { ...preview.courses[1], prerequisites: ['MISSING'] }];
    expect(summarizeCurriculumPlanPreview({ ...preview, courses })).toEqual({
      ok: false,
      errorCode: 'INVALID_RESPONSE',
    });
  });

  it('preserves the tool failure code', () => {
    expect(summarizeCurriculumPlanPreview({ success: false, errorCode: 'PARSE_FAILED' })).toEqual({
      ok: false,
      errorCode: 'PARSE_FAILED',
    });
  });

  it('accepts an explicitly unknown cohort without guessing a year', () => {
    const result = summarizeCurriculumPlanPreview({ ...preview, grade: '未注明' });
    expect(result.ok).toBe(true);
    expect(result.plan?.grade).toBe('未注明');
  });

  it('uses stable storage placeholders when metadata is absent from the source', () => {
    expect(resolveCurriculumMetadata({ ...preview, grade: '未注明' })).toEqual({
      major: '计算机科学与技术',
      cohort: 'unspecified',
      version: 'auto',
    });
  });
});

describe('curriculum ingestion response', () => {
  it('reports a stored source without claiming a graph was generated', () => {
    const result = summarizeCurriculumIngest({
      ok: true,
      data: {
        created: true,
        document: {
          document_id: 'curriculum-computer-science-2026-abc',
          storage_status: 'SOURCE_STORED',
          extraction_status: 'EXTRACTION_PENDING',
          rag_status: 'NOT_INDEXED',
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.documentId).toBe('curriculum-computer-science-2026-abc');
    expect(result.extractionStatus).toBe('EXTRACTION_PENDING');
  });

  it('preserves a business error code without inventing a document', () => {
    const result = summarizeCurriculumIngest({
      ok: false,
      data: null,
      error: { code: 'INVALID_ARGUMENT', message: 'Attachment rejected' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENT' });
    expect(result.documentId).toBeUndefined();
  });

  it('rejects an incomplete success envelope', () => {
    expect(summarizeCurriculumIngest({ ok: true, data: { document: {} } })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_RESPONSE',
    });
  });
});

describe('anonymous progress responses', () => {
  it('accepts only passed and failed statuses', () => {
    expect(summarizeCourseProgress({ ok: true, data: { course_statuses: { CS101: 'passed' } } })).toMatchObject({
      ok: true,
      courseStatuses: { CS101: 'passed' },
    });
    expect(summarizeCourseProgress({ ok: true, data: { course_statuses: { CS101: 'unknown' } } })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_RESPONSE',
    });
  });

  it('requires explicit removed flag after a clear', () => {
    expect(summarizeProgressClear({ ok: true, data: { removed: true } })).toEqual({ ok: true, removed: true });
    expect(summarizeProgressClear({ ok: true, data: {} })).toMatchObject({ ok: false, errorCode: 'INVALID_RESPONSE' });
  });
});

describe('document-bound prerequisite response', () => {
  it('reports the missing chain and source page without inventing courses', () => {
    expect(
      summarizeCoursePlan({
        ok: true,
        data: {
          document_id: 'curriculum-cs-2026',
          basic_advice: { status: 'NOT_ELIGIBLE' },
          missing_courses: [{ course_code: 'CS101', course_name: 'Programming' }],
          prerequisite_conflicts: [
            { missing_direct_prerequisites: [{ course_code: 'CS101', course_name: 'Programming' }] },
          ],
        },
        sources: [{ document: 'curriculum.pdf', page: 7, section: 'Plan' }],
        warnings: ['COURSE_CATALOG_AUTO_VERIFIED'],
      })
    ).toMatchObject({
      ok: true,
      status: 'NOT_ELIGIBLE',
      missingCourses: [{ courseCode: 'CS101', courseName: 'Programming' }],
      missingDirectPrerequisites: [{ courseCode: 'CS101', courseName: 'Programming' }],
      source: { document: 'curriculum.pdf', page: 7 },
    });
  });
});

describe('curriculum graph response', () => {
  it('accepts validated graph nodes with explicit prerequisite IDs', () => {
    const result = summarizeCurriculumGraph({
      ok: true,
      data: {
        document_id: 'doc-1',
        catalog_id: 'cs-2026',
        document: 'curriculum.pdf',
        major: 'computer-science',
        cohort: '2026',
        version: '2026.1',
        total_credits: null,
        courses: [
          {
            id: 'CS201',
            name: 'Data Structures',
            credits: 4,
            category_label: '专业核心课',
            suggested_semester: 2,
            prerequisites: ['CS101'],
            page: 7,
            section: '计划',
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.graph?.courses[0].prerequisites).toEqual(['CS101']);
  });

  it('keeps a not-ready status out of the graph', () => {
    const result = summarizeCurriculumGraph({
      ok: false,
      error: { code: 'CATALOG_NOT_READY', details: { processing_status: 'EXTRACTION_FAILED' } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'CATALOG_NOT_READY', processingStatus: 'EXTRACTION_FAILED' });
    expect(result.graph).toBeUndefined();
  });
});

describe('extraction diagnostics', () => {
  it('shows the failed page rather than later circuit-open skips', () => {
    const result = summarizeExtractionOutcome({
      ok: true,
      data: {
        document: { auto_verified: false, processing_status: 'EXTRACTION_FAILED' },
        extraction: {
          summary: {
            pages_failed: [
              { page: 7, code: 'MODEL_REQUEST_FAILED', reason: 'tls_failed', circuit_open: true },
              { page: 6, code: 'MODEL_REQUEST_FAILED', stage: 'model_extract', reason: 'tls_failed' },
            ],
          },
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'CATALOG_NOT_READY',
      failedPage: 6,
      failureStage: 'model_extract',
      failureReason: 'tls_failed',
    });
  });

  it('rejects a probe response with a missing transport mode', () => {
    expect(summarizeCurriculumProbe({ ok: true, data: { document_id: 'doc-1', page: 6, modes: {} } })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_RESPONSE',
    });
  });

  it('summarizes two transport modes without exposing page content', () => {
    const result = summarizeCurriculumProbe({
      ok: true,
      data: {
        document_id: 'doc-1',
        page: 6,
        model: 'qwen3.8-flash',
        input_characters: 8000,
        modes: {
          non_stream: { reachable: true, error_code: null, reason: null, elapsed_ms: 1000 },
          stream: { reachable: false, error_code: 'MODEL_REQUEST_FAILED', reason: 'tls_failed', elapsed_ms: 2000 },
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      page: 6,
      nonStream: { reachable: true },
      stream: { reason: 'tls_failed' },
    });
  });
});
