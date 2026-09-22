import type { PolicyDiffResult } from './types';

/**
 * 示例数据：用于 MCP 未接入时的演示
 * 结构与真实 MCP 返回保持一致
 */
export const mockDiffResult: PolicyDiffResult = {
  document: {
    name: '学生奖学金管理办法',
    oldVersion: '2025版',
    newVersion: '2026版',
  },
  summary: {
    total: 7,
    modified: 3,
    added: 2,
    removed: 2,
  },
  changes: [
    {
      changeId: 'change-001',
      type: 'modified',
      old: { section: '第五条', content: '综合成绩达到80分以上，且无不及格科目。' },
      new: { section: '第五条', content: '综合成绩达到85分以上，且无不及格科目。' },
      context: {
        before: ['第四条 奖学金分为一等奖、二等奖、三等奖三个等级。'],
        after: ['第六条 各等级奖学金比例由学校统一规定。'],
      },
      aiExplanation: '申请成绩门槛由80分提高至85分，竞争更加激烈。',
    },
    {
      changeId: 'change-002',
      type: 'modified',
      old: { section: '第七条', content: '英语四级成绩达到425分以上。' },
      new: { section: '第七条', content: '英语四级成绩达到425分以上，或英语六级成绩达到425分以上。' },
      context: { before: ['第六条 各等级奖学金比例由学校统一规定。'] },
      aiExplanation: '新增六级成绩作为替代条件，给学生更多选择。',
    },
    {
      changeId: 'change-003',
      type: 'added',
      old: null,
      new: { section: '第八条', content: '上一学年无纪律处分记录，且未受到学校通报批评。' },
      context: { before: ['第七条 英语成绩要求。'], after: ['第九条 获奖学生需参加学校组织的公益活动。'] },
      aiExplanation: '新版政策新增了纪律要求，有处分记录的学生将无法申请。',
    },
    {
      changeId: 'change-004',
      type: 'modified',
      old: { section: '第十条', content: '获奖学金学生可同时申请国家助学金。' },
      new: { section: '第十条', content: '获奖学金学生不可同时申请国家助学金，但可申请国家助学贷款。' },
      aiExplanation: '取消了奖学金与助学金的叠加资格，改为可申请助学贷款。',
    },
    {
      changeId: 'change-005',
      type: 'removed',
      old: { section: '第十二条', content: '体育成绩达到75分以上可获得额外加分。' },
      new: null,
      context: { before: ['第十一条 奖学金评审每年九月进行。'], after: ['第十三条 评审结果公示期为五个工作日。'] },
      aiExplanation: '删除了体育加分条款，体育成绩不再作为奖学金评审的加分项。',
    },
    {
      changeId: 'change-006',
      type: 'added',
      old: null,
      new: { section: '第十四条', content: '在科研创新方面表现突出者（如发表论文、获得专利），可破格申请。' },
      context: { before: ['第十三条 评审结果公示期为五个工作日。'] },
      aiExplanation: '新增科研创新破格申请通道，鼓励学术研究。',
    },
    {
      changeId: 'change-007',
      type: 'removed',
      old: { section: '第十六条', content: '奖学金发放方式为一次性发放至学生银行卡。' },
      new: null,
      aiExplanation: '删除了发放方式条款，具体发放方式由财务处另行规定。',
    },
  ],
};

/** 生成带完整快照的 mock 历史记录 */
function makeMockHistory(
  id: string,
  docName: string,
  oldVersion: string,
  newVersion: string,
  hoursAgo: number,
  summary: { total: number; modified: number; added: number; removed: number },
  changeOffset: number
) {
  // 循环取用 mockDiffResult.changes，让每条记录的变化内容不同
  const all = mockDiffResult.changes;
  const changes = Array.from({ length: summary.total }, (_, i) => {
    const src = all[(changeOffset + i) % all.length];
    return { ...src, changeId: `${id}-change-${i + 1}` };
  });
  return {
    id,
    docName,
    oldVersion,
    newVersion,
    oldFile: `${docName}_${oldVersion.replace('版', '')}.pdf`,
    newFile: `${docName}_${newVersion.replace('版', '')}.pdf`,
    createdAt: new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString(),
    summary,
    diffSnapshot: {
      document: { name: docName, oldVersion, newVersion },
      summary,
      changes,
    },
  };
}

/** 示例历史对照记录（首次进入时展示，带完整 Diff 快照） */
export const mockHistory = [
  makeMockHistory(
    'mock-history-1',
    '推免工作管理办法',
    '2025版',
    '2026版',
    2,
    { total: 7, modified: 3, added: 2, removed: 2 },
    0
  ),
  makeMockHistory(
    'mock-history-2',
    '毕业生就业管理办法',
    '2024版',
    '2025版',
    26,
    { total: 5, modified: 2, added: 2, removed: 1 },
    3
  ),
  makeMockHistory(
    'mock-history-3',
    '学生违纪处分条例',
    '2023版',
    '2025版',
    72,
    { total: 7, modified: 4, added: 2, removed: 1 },
    5
  ),
];
