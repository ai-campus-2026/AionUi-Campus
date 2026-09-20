/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 渲染层内部的轻量事件总线，用于「DashScope API Key 弹窗」的跨页面联动。
 *
 * CampusApiKeyDialog 全局挂载在应用根部；设置页（工具）里的提示条点击「填写 API Key」
 * 时通过 window CustomEvent 请求打开弹窗，弹窗保存成功后再发「已保存」事件让提示条
 * 立即刷新。避免为此引入全局状态库或把弹窗塞进设置页组件树。
 */

const OPEN_EVENT = 'campus:open-api-key-dialog';
const SAVED_EVENT = 'campus:api-key-dialog-saved';

/** 请求全局挂载的 CampusApiKeyDialog 打开（设置页提示条调用）。 */
export function requestCampusApiKeyDialog(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/** 订阅打开请求，返回退订函数。 */
export function onCampusApiKeyDialogOpenRequest(listener: () => void): () => void {
  const handler = () => listener();
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}

/** 通知 API Key 已保存成功（CampusApiKeyDialog 调用）。 */
export function notifyCampusApiKeyDialogSaved(): void {
  window.dispatchEvent(new CustomEvent(SAVED_EVENT));
}

/** 订阅保存成功通知，返回退订函数。 */
export function onCampusApiKeyDialogSaved(listener: () => void): () => void {
  const handler = () => listener();
  window.addEventListener(SAVED_EVENT, handler);
  return () => window.removeEventListener(SAVED_EVENT, handler);
}
