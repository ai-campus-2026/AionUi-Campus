import React, { useEffect, useState } from 'react';
import { Right } from '@icon-park/react';
import { ipcBridge } from '@/common';
import type { WorkbenchApi } from '../store';
import { ENTRY_TASK_ID } from '../store';
import { getConvId } from '../modelClient';
import RuleAnalysisChat from './RuleAnalysisChat';

const QUICK: { label: string; goalKey: string; prompt: string }[] = [
  { label: '国家奖学金', goalKey: 'national_scholarship', prompt: '我能申请国家奖学金吗？' },
  { label: '研究生推免', goalKey: 'tuimian', prompt: '我符合研究生推免资格吗？' },
  { label: '学业奖学金', goalKey: 'study_scholarship', prompt: '学业奖学金的评定条件是什么？' },
  { label: '三好学生', goalKey: 'sanhao', prompt: '三好学生的评选标准有哪些？' },
];

/** 政策解读首页：AI 提问入口（无分析状态），右侧使用项目原生聊天组件 */
const PolicyEntryView: React.FC<{
  api: WorkbenchApi;
  notify: (msg: string) => void;
}> = ({ api, notify }) => {
  const { tasks, reports } = api.state;
  const { selectedAssistantId, currentModel, refreshRuleResult } = api;
  const [entryConvId, setEntryConvId] = useState<string | null>(null);

  // 定时轮询：AI 回复产生 MCP 工具结果后自动切换到解读视图
  useEffect(() => {
    const interval = setInterval(() => {
      const convId = getConvId(ENTRY_TASK_ID);
      if (convId) void refreshRuleResult(ENTRY_TASK_ID, convId);
    }, 5000);
    return () => clearInterval(interval);
  }, [refreshRuleResult]);

  const sendQuickPrompt = async (prompt: string) => {
    const convId = entryConvId ?? getConvId(ENTRY_TASK_ID);
    if (!convId) {
      notify('对话尚未就绪，请稍候');
      return;
    }
    try {
      await ipcBridge.conversation.sendMessage.invoke({ conversation_id: convId, input: prompt });
      notify('已发送');
    } catch (e) {
      notify(`发送失败：${String(e)}`);
    }
  };

  return (
    <div className='ra-workbench'>
      <div className='ra-workbench__main'>
        <div className='ra-entry'>
          <div className='ra-entry__inner'>
            <div className='ra-entry__title'>你想了解哪项校园政策？</div>
            <div className='ra-entry__sub'>
              告诉我你的目标，AI 会基于你的长期个人信息持续分析；
              每次重新分析只生成一份新的报告快照，历史结果永远保留。
            </div>
            <div className='ra-entry__hint'>
              提示：指明具体政策名称（如「国家奖学金评定办法」「保研政策」）可获得更准确的分析结果
            </div>

            <div className='ra-entry__quick'>
              <span className='ra-entry__quick-label'>试试</span>
              {QUICK.map((q) => (
                <button key={q.goalKey} type='button' className='ra-chip' onClick={() => void sendQuickPrompt(q.prompt)}>
                  {q.label}
                </button>
              ))}
            </div>

            {tasks.length > 0 && (
              <div className='ra-entry__recent'>
                <div className='ra-entry__recent-title'>最近分析</div>
                <div className='ra-entry__recent-list'>
                  {tasks
                    .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
                    .slice(0, 4)
                    .map((t) => {
                    const latest = reports
                      .filter((r) => r.analysisTaskId === t.id)
                      .toSorted((a, b) => b.version - a.version)[0];
                    return (
                      <button
                        key={t.id}
                        type='button'
                        className='ra-entry__recent-item'
                        onClick={() => api.openInterpret(t.id)}
                      >
                        <span className='ra-entry__recent-name'>{t.title}</span>
                        {latest ? (
                          <span className='ra-entry__recent-meta'>
                            V{latest.version} · {latest.createdAt} · ✓ {latest.summary.met} / !{' '}
                            {latest.summary.missing} / × {latest.summary.notMet}
                          </span>
                        ) : (
                          <span className='ra-entry__recent-meta'>尚未生成快照</span>
                        )}
                        <span className='ra-entry__recent-go'>
                          <Right size={13} theme='outline' fill='currentColor' />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 右侧聊天列：使用项目原生 AionrsChat 组件 */}
      <aside className='ra-chat ra-chat--native' aria-label='AI 对话'>
        <RuleAnalysisChat
          taskId={ENTRY_TASK_ID}
          taskName='政策解读助手'
          assistantId={selectedAssistantId}
          initialModel={currentModel}
          onReady={(id) => setEntryConvId(id)}
        />
      </aside>
    </div>
  );
};

export default PolicyEntryView;
