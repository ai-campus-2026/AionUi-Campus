/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// 规则分析「提问入口」自由对话：ENTRY_TASK_ID 会话复用真实 AI 管线；
// 回复结束后从对话数据库加载 MCP 政策解读工具结果并自动切换到解读视图。
// 覆盖：消息 upsert 建会话、目标问题留在入口会话、空输入、AI 失败可见提示、
// onDone → loadLatestRuleResult → 解读视图切换。

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampusRuleToolResult } from '@/renderer/components/campus-rule/types';

const ensureConversationMock = vi.fn();
const sendToConversationMock = vi.fn();
const subscribeStreamMock = vi.fn();
const getConvIdMock = vi.fn();
const loadLatestRuleResultMock = vi.fn();
const taskIdOfConvMock = vi.fn();

vi.mock('@/renderer/pages/rule-analysis/modelClient', () => ({
  ensureConversation: (...args: unknown[]) => ensureConversationMock(...args),
  sendToConversation: (...args: unknown[]) => sendToConversationMock(...args),
  subscribeStream: (...args: unknown[]) => subscribeStreamMock(...args),
  getConvId: (...args: unknown[]) => getConvIdMock(...args),
  loadLatestRuleResult: (...args: unknown[]) => loadLatestRuleResultMock(...args),
  taskIdOfConv: (...args: unknown[]) => taskIdOfConvMock(...args),
}));

import { ENTRY_TASK_ID, useWorkbench } from '@/renderer/pages/rule-analysis/store';
import type { AiStreamHandlers } from '@/renderer/pages/rule-analysis/modelClient';

/** 等待 sendEntryMessage 内部的异步 promise 链（ensureConversation → sendToConversation → then）完成 */
async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const sampleResult: CampusRuleToolResult = {
  type: 'policy_retrieval',
  toolName: 'query_policy',
  status: 'success',
  summary: '国家奖学金面向全日制本科生，成绩与综测均需前列。',
  conclusion: '你可以申请国家奖学金。',
};

describe('rule-analysis entry chat (sendEntryMessage)', () => {
  beforeEach(() => {
    localStorage.clear();
    ensureConversationMock.mockReset();
    sendToConversationMock.mockReset();
    subscribeStreamMock.mockReset();
    getConvIdMock.mockReset();
    loadLatestRuleResultMock.mockReset();
    taskIdOfConvMock.mockReset();
    ensureConversationMock.mockResolvedValue({ id: 'conv-entry-1' });
    sendToConversationMock.mockResolvedValue({ ok: true });
    subscribeStreamMock.mockReturnValue(() => {});
    getConvIdMock.mockReturnValue(undefined);
    loadLatestRuleResultMock.mockResolvedValue(null);
    taskIdOfConvMock.mockReturnValue(undefined);
  });

  it('自由提问写入入口会话并走真实 AI 管线', async () => {
    const { result } = renderHook(() => useWorkbench());

    act(() => {
      result.current.sendEntryMessage('你好，能帮我解释一下综测加分规则吗');
    });
    await flushAsync();

    expect(ensureConversationMock).toHaveBeenCalledWith(ENTRY_TASK_ID, '政策解读助手', {
      assistantId: null,
      model: undefined,
    });
    expect(sendToConversationMock).toHaveBeenCalledWith('conv-entry-1', '你好，能帮我解释一下综测加分规则吗');
    const msgs = result.current.entryConversation?.messages ?? [];
    expect(msgs.some((m) => m.kind === 'user' && m.text === '你好，能帮我解释一下综测加分规则吗')).toBe(true);
  });

  it('入口会话不存在时首条消息自动创建（upsert），且不切换视图', async () => {
    const { result } = renderHook(() => useWorkbench());
    expect(result.current.entryConversation).toBeUndefined();

    act(() => {
      result.current.sendEntryMessage('随便问点别的');
    });
    await flushAsync();

    expect(result.current.entryConversation?.taskId).toBe(ENTRY_TASK_ID);
    expect(result.current.entryConversation?.messages).toHaveLength(1);
    // 发送本身不切换视图；等待 AI 回复结束后按工具结果决定
    expect(result.current.ui.view).toBe('entry');
  });

  it('命中政策目标的问题同样留在入口会话（不再创建 mock 分析任务）', async () => {
    const { result } = renderHook(() => useWorkbench());

    act(() => {
      result.current.sendEntryMessage('我想看看国家奖学金');
    });
    await flushAsync();

    // 目标问题走真实 AI 管线，停留在入口会话
    expect(result.current.ui.view).toBe('entry');
    expect(ensureConversationMock).toHaveBeenCalledWith(ENTRY_TASK_ID, '政策解读助手', {
      assistantId: null,
      model: undefined,
    });
    const msgs = result.current.entryConversation?.messages ?? [];
    expect(msgs.some((m) => m.kind === 'user' && m.text === '我想看看国家奖学金')).toBe(true);
  });

  it('AI 回复结束后加载到 MCP 解读结果时自动切换到解读视图', async () => {
    taskIdOfConvMock.mockImplementation((convId: string) => (convId === 'conv-entry-1' ? ENTRY_TASK_ID : undefined));
    loadLatestRuleResultMock.mockResolvedValue({
      result: sampleResult,
      question: '我能申请国家奖学金吗',
      messageId: 'msg-tool-1',
    });
    const { result } = renderHook(() => useWorkbench());

    act(() => {
      result.current.sendEntryMessage('我能申请国家奖学金吗');
    });
    await flushAsync();
    expect(result.current.ui.view).toBe('entry');

    // 模拟流式回复结束
    const handlers = subscribeStreamMock.mock.calls[0][0] as AiStreamHandlers;
    await act(async () => {
      handlers.onDone('conv-entry-1');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(loadLatestRuleResultMock).toHaveBeenCalledWith('conv-entry-1');
    expect(result.current.ui.view).toBe('analysis');
    expect(result.current.ui.interpretTaskId).toBe(ENTRY_TASK_ID);
    const data = result.current.ruleResults[ENTRY_TASK_ID];
    expect(data?.result.summary).toBe(sampleResult.summary);
    expect(data?.question).toBe('我能申请国家奖学金吗');
    expect(result.current.aiBusy[ENTRY_TASK_ID]).toBe(false);
  });

  it('AI 回复结束但没有可解析的工具结果时停留在入口视图', async () => {
    taskIdOfConvMock.mockImplementation((convId: string) => (convId === 'conv-entry-1' ? ENTRY_TASK_ID : undefined));
    loadLatestRuleResultMock.mockResolvedValue(null);
    const { result } = renderHook(() => useWorkbench());

    act(() => {
      result.current.sendEntryMessage('你好');
    });
    await flushAsync();

    const handlers = subscribeStreamMock.mock.calls[0][0] as AiStreamHandlers;
    await act(async () => {
      handlers.onDone('conv-entry-1');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.ui.view).toBe('entry');
    expect(result.current.ruleResults[ENTRY_TASK_ID]).toBeUndefined();
    expect(result.current.aiBusy[ENTRY_TASK_ID]).toBe(false);
  });

  it('空白输入被忽略，不触发任何 AI 调用', async () => {
    const { result } = renderHook(() => useWorkbench());

    act(() => {
      result.current.sendEntryMessage('   ');
    });
    await flushAsync();

    expect(ensureConversationMock).not.toHaveBeenCalled();
    expect(result.current.entryConversation).toBeUndefined();
  });

  it('AI 发送失败时在入口会话给出可见的系统提示', async () => {
    sendToConversationMock.mockResolvedValue({ ok: false, error: '网络异常' });
    const { result } = renderHook(() => useWorkbench());

    act(() => {
      result.current.sendEntryMessage('你好');
    });
    await flushAsync();

    const msgs = result.current.entryConversation?.messages ?? [];
    const last = msgs[msgs.length - 1];
    expect(last?.kind).toBe('system_info');
    expect(last?.text).toContain('AI 暂时无法回复');
    expect(result.current.aiBusy[ENTRY_TASK_ID]).toBe(false);
  });

  it('创建对话失败时同样给出可见提示，且不遗留 busy 状态', async () => {
    ensureConversationMock.mockResolvedValue({ error: '创建对话失败（后端未返回会话）' });
    const { result } = renderHook(() => useWorkbench());

    act(() => {
      result.current.sendEntryMessage('你好');
    });
    await flushAsync();

    const msgs = result.current.entryConversation?.messages ?? [];
    expect(msgs.some((m) => m.kind === 'system_info' && m.text.includes('AI 暂时无法回复'))).toBe(true);
    expect(sendToConversationMock).not.toHaveBeenCalled();
    expect(result.current.aiBusy[ENTRY_TASK_ID]).toBe(false);
  });
});
