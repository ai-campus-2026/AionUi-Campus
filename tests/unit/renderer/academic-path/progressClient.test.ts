import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import { loadCourseStatuses, saveCourseStatuses } from '@renderer/pages/academic-path/progressClient';

vi.mock('@/common', () => ({
  ipcBridge: {
    curriculum: {
      saveProgress: { invoke: vi.fn() },
      loadProgress: { invoke: vi.fn() },
    },
  },
}));

describe('academic path progress client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists course statuses through the curriculum IPC bridge', async () => {
    vi.mocked(ipcBridge.curriculum.saveProgress.invoke).mockResolvedValue({ ok: true });

    await expect(saveCourseStatuses('document-1', { calculus: 'passed' })).resolves.toBe(true);
    expect(ipcBridge.curriculum.saveProgress.invoke).toHaveBeenCalledWith({
      profileId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      documentId: 'document-1',
      courseStatuses: { calculus: 'passed' },
    });
  });

  it('returns null instead of mock data when no saved progress exists', async () => {
    vi.mocked(ipcBridge.curriculum.loadProgress.invoke).mockResolvedValue({ ok: true });

    await expect(loadCourseStatuses('document-2')).resolves.toBeNull();
  });

  it('returns a backend failure without manufacturing saved progress', async () => {
    vi.mocked(ipcBridge.curriculum.saveProgress.invoke).mockResolvedValue({ ok: false, errorCode: 'SAVE_FAILED' });

    await expect(saveCourseStatuses('document-3', {})).resolves.toBe(false);
  });
});
