import React, { useEffect, useMemo, useState } from 'react';
import { ENTRY_TASK_ID } from '../store';
import { getConvId } from '../modelClient';
import type { WorkbenchApi } from '../store';
import type { CampusRuleToolResult } from '@renderer/components/campus-rule/types';
import RuleAnalysisChat from '../components/RuleAnalysisChat';
import McpAnalysisView from '../components/McpAnalysisView';

const SAMPLE_MCP_JSON = JSON.stringify(
  {
    type: 'campus_rule_analysis',
    toolName: 'campus_rule_search',
    status: 'success',
    summary: '根据当前个人信息与《国家奖学金评定办法》2026版进行匹配分析。',
    conclusion: '当前满足14项条件，2项待确认，1项未满足。建议补充CET-6成绩和科研成果后重新分析。',
    conditionGroups: [
      {
        id: 'basic',
        label: '基础资格',
        rows: [
          {
            id: 'b1',
            item: '学籍状态',
            match: 'met',
            userValue: '在籍本科生',
            requirement: '具有中华人民共和国国籍且纳入全国普通高校招生计划的在籍本科生',
            sourceQuote: '第二条 申请国家奖学金的学生为高校在校生中二年级以上（含二年级）的学生。',
          },
          {
            id: 'b2',
            item: '年级要求',
            match: 'met',
            userValue: '大三',
            requirement: '二年级以上（含二年级）',
            sourceQuote: '第二条',
          },
          {
            id: 'b3',
            item: '思想品德',
            match: 'met',
            userValue: '无处分记录',
            requirement: '热爱社会主义祖国，拥护中国共产党的领导；遵守宪法和法律，遵守学校规章制度',
            sourceQuote: '第三条',
          },
        ],
      },
      {
        id: 'academic',
        label: '学业成绩',
        rows: [
          {
            id: 'a1',
            item: 'GPA成绩',
            match: 'met',
            userValue: '3.72 / 4.0',
            requirement: '学习成绩优异，GPA ≥ 3.5',
            sourceQuote: '第五条 学习成绩排名在评选范围内位于前10%。',
          },
          {
            id: 'a2',
            item: '专业排名',
            match: 'met',
            userValue: '5 / 120',
            requirement: '专业排名前10%',
            sourceQuote: '第五条',
          },
          {
            id: 'a3',
            item: '挂科情况',
            match: 'met',
            userValue: '无挂科',
            requirement: '无不及格科目',
            sourceQuote: '第六条',
          },
        ],
      },
      {
        id: 'english',
        label: '英语成绩',
        rows: [
          {
            id: 'e1',
            item: 'CET-4成绩',
            match: 'met',
            userValue: '512',
            requirement: 'CET-4 ≥ 425',
            sourceQuote: '第七条 外语水平要求。',
          },
          {
            id: 'e2',
            item: 'CET-6成绩',
            match: 'missing_info',
            userValue: '未提供',
            requirement: 'CET-6 ≥ 425（部分学院要求）',
            sourceQuote: '第七条',
          },
        ],
      },
      {
        id: 'comprehensive',
        label: '综合表现',
        rows: [
          {
            id: 'c1',
            item: '综合测评',
            match: 'met',
            userValue: '89 / 100',
            requirement: '综合测评 ≥ 85',
            sourceQuote: '第八条 综合素质测评成绩。',
          },
          {
            id: 'c2',
            item: '社会实践',
            match: 'missing_info',
            userValue: '未提供',
            requirement: '积极参加社会实践和志愿服务',
            sourceQuote: '第八条',
          },
        ],
      },
      {
        id: 'awards',
        label: '奖励荣誉',
        rows: [
          {
            id: 'aw1',
            item: '获奖经历',
            match: 'met',
            userValue: '校级一等奖学金',
            requirement: '在社会实践、创新能力、综合素质等方面表现突出',
            sourceQuote: '第四条',
          },
        ],
      },
      {
        id: 'research',
        label: '科研成果',
        rows: [
          {
            id: 'r1',
            item: '科研成果',
            match: 'not_met',
            userValue: '暂无相关成果',
            requirement: '至少1项相关科研成果（论文/专利/项目）',
            sourceQuote: '第九条 科研创新能力要求。',
          },
        ],
      },
    ],
    evidences: [
      {
        title: '《国家奖学金评定办法》2026版',
        snippet: '第二条 申请国家奖学金的学生为高校在校生中二年级以上（含二年级）的学生。',
      },
    ],
    suggestions: ['建议补充CET-6成绩，当前为待确认状态。', '建议补充科研成果，目前未满足该条件。'],
  },
  null,
  2
);

// 字段 key → 中文标签（轻量映射，与 engine.fieldLabel 保持一致）
function fieldLabelOf(key: string): string {
  const map: Record<string, string> = {
    gpa: 'GPA',
    grade: 'GPA',
    cgpa: 'GPA',
    rank: '专业排名',
    major_rank: '专业排名',
    cet4: 'CET-4',
    cet_4: 'CET-4',
    cet6: 'CET-6',
    cet_6: 'CET-6',
    comprehensive: '综合测评',
    comprehensive_score: '综合测评',
    awards: '获奖经历',
    honors: '获奖经历',
    research: '科研经历',
    research_exp: '科研经历',
    competition: '竞赛经历',
    discipline: '处分记录',
  };
  return map[key] ?? key;
}

type Props = {
  api: WorkbenchApi;
};

/**
 * 政策解读视图：
 * - 左侧：MCP 数据驱动的解读结果（汇总 + 横向链路 + 条件卡片 + 依据 + 建议），
 *   前端只做字段渲染，不做中文语义判断；
 *   若无真实 MCP 结果但任务有 current（种子/mock 数据），回退展示 current。
 * - 右侧：项目原生 AionrsChat 组件（完整流式处理、MCP 工具调用、权限确认）。
 */
export function InterpretView({ api }: Props) {
  const {
    ui,
    ruleResults,
    switchView,
    selectedAssistantId,
    currentModel,
    refreshRuleResult,
    updateProfileField,
    sendInterpretMessage,
  } = api;
  const taskId = ui.interpretTaskId ?? ENTRY_TASK_ID;
  const data = ruleResults[taskId];
  const task = api.state.tasks.find((t) => t.id === taskId);
  const taskName = task?.title ?? '政策解读助手';

  // 最近补充的个人信息（用于显示"已识别新信息"横幅 + 重新分析入口）
  const [suppliedFields, setSuppliedFields] = useState<Array<{ label: string; value: string }>>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 关闭可能打开的浮层
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (reanalyzePollRef.current) clearInterval(reanalyzePollRef.current);
    };
  }, []);

  // 定时轮询：AI 回复产生 MCP 工具结果后自动刷新左侧解读（种子 mock 任务不轮询）
  useEffect(() => {
    const SEED_TASK_IDS = ['task-scholar', 'task-tuimian'];
    if (SEED_TASK_IDS.includes(taskId)) return; // 种子 mock 任务没有真实对话，不轮询
    const interval = setInterval(() => {
      const convId = getConvId(taskId);
      if (convId) void refreshRuleResult(taskId, convId);
    }, 5000);
    return () => clearInterval(interval);
  }, [taskId, refreshRuleResult]);

  const handleSupply = (fieldKey: string, value: string) => {
    updateProfileField(fieldKey, value);
    // 记录补充的字段，显示反馈横幅
    const label = fieldLabelOf(fieldKey);
    setSuppliedFields((prev) => {
      const exists = prev.some((f) => f.label === label);
      if (exists) return prev.map((f) => (f.label === label ? { ...f, value } : f));
      return [...prev, { label, value }];
    });
  };

  // 触发重新分析：把当前「我的信息」全部序列化发给 AI，再请求重新匹配
  const reanalyzePollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const handleReanalyze = () => {
    const fields = api.state.profile.fields;
    const provided = Object.values(fields).filter((f) => f.value && f.value !== '未提供');
    const missing = Object.values(fields).filter((f) => !f.value || f.value === '未提供');
    let profileText = '以下是我的最新个人信息：\n';
    if (provided.length > 0) {
      profileText += provided.map((f) => '· ' + f.label + '：' + f.value).join('\n') + '\n';
    }
    if (missing.length > 0) {
      profileText += '· 以下信息暂未提供：' + missing.map((f) => f.label).join('、') + '\n';
    }
    // 加上任务名称和政策文件，让 AI 明确知道要分析什么、调用哪个政策
    const taskName = task?.title ?? '政策分析';
    // 从多个地方找政策文件名：MCP结果（最准确）→ state.policyVersions → 报告快照（兜底）
    let policyName = '';
    let policyVer = '';
    // 1. 优先从当前 MCP 结果里找（最准确）
    const mcpData = ruleResults[taskId]?.result as any;
    policyName = mcpData?.policyFileName ?? mcpData?.policyName ?? '';
    // 2. 如果 MCP 结果里没有，从 state.policyVersions 里找
    if (!policyName && task?.policyVersionId) {
      const pv = api.state.policyVersions.find((p) => p.id === task.policyVersionId);
      if (pv && pv.title !== '未知政策文件') {
        policyName = pv.title;
        policyVer = pv.version;
      }
    }
    // 3. 最后兜底：从最新报告快照里找
    if (!policyName) {
      const latestReport = api.state.reports
        .filter((r) => r.analysisTaskId === taskId)
        .toSorted((a, b) => b.version - a.version)[0];
      if (latestReport?.policyVersion?.title && latestReport.policyVersion.title !== '未知政策文件') {
        policyName = latestReport.policyVersion.title;
        policyVer = latestReport.policyVersion.version;
      }
    }
    const policyHint = policyName
      ? `基于《${policyName}》${policyVer ? policyVer + '版' : ''}进行匹配`
      : `围绕「${taskName}」这个目标进行匹配`;
    profileText += `\n请根据以上信息，重新进行「${taskName}」的资格分析。${policyHint}，请调用政策查询工具返回结构化的条件匹配结果。`;
    sendInterpretMessage(profileText);
    setSuppliedFields([]);
    // 发送后高频轮询 30 秒，强制刷新左侧 MCP 结果（forceUpdate 绕过 messageId 去重）
    if (reanalyzePollRef.current) clearInterval(reanalyzePollRef.current);
    let ticks = 0;
    reanalyzePollRef.current = setInterval(() => {
      ticks += 1;
      const convId = getConvId(taskId);
      if (convId) void refreshRuleResult(taskId, convId, false, true);
      if (ticks >= 15) {
        if (reanalyzePollRef.current) clearInterval(reanalyzePollRef.current);
        reanalyzePollRef.current = null;
      }
    }, 2000);
  };

  // 回退：没有真实 MCP 结果时，用任务的 current 或最新报告的 matchResults（种子/mock 数据）构造展示
  const displayResult = useMemo<CampusRuleToolResult | null>(() => {
    if (data?.result) return data.result;
    let groups: any[] = task?.current ?? [];
    if (groups.length === 0) {
      const latestReport = api.state.reports
        .filter((r) => r.analysisTaskId === taskId)
        .toSorted((a, b) => b.version - a.version)[0];
      if (latestReport?.matchResults?.length) groups = latestReport.matchResults as any[];
    }
    if (groups.length > 0) {
      const isGrouped = groups[0] && Array.isArray(groups[0].rows);
      const normalizedGroups = isGrouped
        ? groups
        : [
            {
              id: 'all',
              label: '全部条件',
              rows: groups.map((r: any) => ({
                id: r.id ?? r.conditionId,
                item: r.item ?? r.conditionName ?? '未命名条件',
                match: r.match ?? r.state ?? 'missing_info',
                userValue: r.userValue,
                requirement: r.requirement,
                sourceQuote: r.sourceQuote,
                sourceFile: r.sourceFile,
              })),
            },
          ];
      return {
        type: 'campus_rule_analysis',
        toolName: 'seed',
        status: 'success',
        summary: '',
        conditionGroups: normalizedGroups as CampusRuleToolResult['conditionGroups'],
      } as CampusRuleToolResult;
    }
    return null;
  }, [data, task, taskId, api.state.reports]);

  const displayQuestion = data?.question ?? task?.title;
  const isSeedData = !data?.result && !!displayResult;

  return (
    <div className='ra-workbench ra-workbench--hide-toolcards fade-in'>
      <div className='ra-workbench__main'>
        <div className='ra-interpret'>
          <div className='ra-interpret__head'>
            <button type='button' className='ra-interpret__back' onClick={() => switchView('entry')}>
              ← 返回对话
            </button>
            <span className='ra-interpret__title'>政策解读</span>
            <button
              type='button'
              className='ra-interpret__reanalyze'
              onClick={handleReanalyze}
              title='用最新个人信息重新匹配政策条件'
            >
              重新分析
            </button>
            {isSeedData && <span className='ra-interpret__badge'>示例数据</span>}
            {data?.updatedAt && <span className='ra-interpret__time'>更新于 {data.updatedAt}</span>}
          </div>

          {/* 补充信息反馈横幅 */}
          {suppliedFields.length > 0 && (
            <div className='ra-supply-banner'>
              <div className='ra-supply-banner__icon'>✦</div>
              <div className='ra-supply-banner__body'>
                <div className='ra-supply-banner__title'>已识别新的个人信息</div>
                <div className='ra-supply-banner__fields'>
                  {suppliedFields.map((f, i) => (
                    <span key={i} className='ra-supply-banner__field'>
                      {f.label}：{f.value}
                    </span>
                  ))}
                </div>
                <div className='ra-supply-banner__hint'>该信息可能影响当前分析，是否重新匹配？</div>
              </div>
              <div className='ra-supply-banner__actions'>
                <button type='button' className='ra-btn ra-btn--primary' onClick={handleReanalyze}>
                  重新分析
                </button>
                <button type='button' className='ra-btn ra-btn--ghost' onClick={() => setSuppliedFields([])}>
                  稍后
                </button>
              </div>
            </div>
          )}

          {displayResult ? (
            <div className='ra-interpret__body'>
              <McpAnalysisView result={displayResult} question={displayQuestion} onSupply={handleSupply} />
            </div>
          ) : (
            <div className='ra-interpret__empty'>
              <p className='ra-interpret__empty-title'>还没有解读结果</p>
              <p className='ra-interpret__empty-sub'>
                在右侧输入你的问题（如「本科生能申请国家奖学金吗」），AI 将调用政策检索并在这里展示结构化解读。
              </p>
            </div>
          )}
        </div>
      </div>

      <aside className='ra-chat ra-chat--native'>
        <RuleAnalysisChat
          taskId={taskId}
          taskName={taskName}
          assistantId={selectedAssistantId}
          initialModel={currentModel}
        />
      </aside>
    </div>
  );
}

export default InterpretView;
