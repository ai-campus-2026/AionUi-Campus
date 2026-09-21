/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, dialog } from 'electron';
import { ipcBridge } from '@/common';
import {
  clearCourseProgress,
  ingestCurriculumAttachment,
  loadCourseProgress,
  planCurriculumCourse,
  prepareCurriculumGraph,
  previewCurriculumPlan,
  probeCurriculumPage,
  saveCourseProgress,
} from '@process/services/CurriculumIngestService';

export function initDialogBridge(): void {
  ipcBridge.curriculum.ingestAttachment.provider(ingestCurriculumAttachment);
  ipcBridge.curriculum.previewPlan.provider(({ filePath }) => previewCurriculumPlan(filePath));
  ipcBridge.curriculum.prepareGraph.provider(({ documentId }) => prepareCurriculumGraph(documentId));
  ipcBridge.curriculum.probeExtraction.provider(({ documentId, page }) => probeCurriculumPage(documentId, page));
  ipcBridge.curriculum.saveProgress.provider(saveCourseProgress);
  ipcBridge.curriculum.loadProgress.provider(({ profileId, documentId }) => loadCourseProgress(profileId, documentId));
  ipcBridge.curriculum.clearProgress.provider(({ profileId, documentId }) =>
    clearCourseProgress(profileId, documentId)
  );
  ipcBridge.curriculum.planCourse.provider(planCurriculumCourse);
  ipcBridge.dialog.showOpen.provider((options) => {
    // Get the focused window or the first available window as parent
    // This ensures the dialog appears in front on Windows and has proper modal behavior
    const parentWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const dialogOptions = {
      defaultPath: options?.defaultPath,
      properties: options?.properties,
    };

    const showDialogPromise = parentWindow
      ? dialog.showOpenDialog(parentWindow, dialogOptions)
      : dialog.showOpenDialog(dialogOptions);

    return showDialogPromise.then((res) => {
      return res.filePaths;
    });
  });
}
