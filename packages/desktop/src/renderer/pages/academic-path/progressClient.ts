/** Anonymous per-device profile; no name, student ID or grades are persisted here. */
import { ipcBridge } from '@/common';
import type { CourseStatus } from './types';

const PROFILE_KEY = 'academic-path:anonymous-profile-id';
let ephemeralProfileId: string | null = null;

export function getAnonymousProfileId(): string {
  if (ephemeralProfileId) return ephemeralProfileId;
  try {
    const stored = localStorage.getItem(PROFILE_KEY);
    if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(stored)) {
      ephemeralProfileId = stored;
      return stored;
    }
  } catch {
    // An in-memory profile is still usable for the current session.
  }
  ephemeralProfileId = crypto.randomUUID();
  try {
    localStorage.setItem(PROFILE_KEY, ephemeralProfileId);
  } catch {
    /* in-memory only */
  }
  return ephemeralProfileId;
}

export async function saveCourseStatuses(documentId: string, statuses: Record<string, CourseStatus>): Promise<boolean> {
  const result = await ipcBridge.curriculum.saveProgress.invoke({
    profileId: getAnonymousProfileId(),
    documentId,
    courseStatuses: statuses,
  });
  return result.ok;
}

export async function loadCourseStatuses(documentId: string): Promise<Record<string, CourseStatus> | null> {
  const result = await ipcBridge.curriculum.loadProgress.invoke({
    profileId: getAnonymousProfileId(),
    documentId,
  });
  return result.ok && result.courseStatuses ? result.courseStatuses : null;
}

export async function clearCourseStatuses(documentId: string): Promise<boolean> {
  const result = await ipcBridge.curriculum.clearProgress.invoke({
    profileId: getAnonymousProfileId(),
    documentId,
  });
  return result.ok;
}
