import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Home } from '@icon-park/react';
import type { ProgramPlan } from '../types';

interface Props {
  plan: ProgramPlan;
  onConfirm: (plan: ProgramPlan) => void;
  onBack: () => void;
  /** 解析警告（MCP失败降级时会包含"当前为演示数据"提示） */
  warnings?: string[];
  /** 数据来源 */
  source?: 'mock' | 'mcp';
}

const ConfirmPlan: React.FC<Props> = ({ plan, onConfirm, onBack, warnings, source }) => {
  const navigate = useNavigate();
  const requiredCount = plan.courses.filter((c) => c.category === 'required' || c.category === 'core').length;
  const electiveCount = plan.courses.filter((c) => c.category === 'elective').length;
  const relationCount = plan.courses.reduce((sum, c) => sum + c.prerequisites.length, 0);

  const stats = [
    { label: '课程总数', value: plan.courses.length },
    { label: '必修/核心课', value: requiredCount },
    { label: '选修课', value: electiveCount },
    { label: '总学分', value: plan.totalCredits },
    { label: '先修关系', value: relationCount },
  ];

  // 展示几条重要先修关系示例
  const sampleRelations = plan.courses
    .filter((c) => c.prerequisites.length > 0)
    .slice(0, 4)
    .map((c) => ({
      course: c,
      prereq: plan.courses.find((p) => p.id === c.prerequisites[0]),
    }))
    .filter((r) => r.prereq);

  return (
    <div className="ap-confirm">
      <header className="ap-confirm__header">
        <button type="button" className="ap-back" onClick={onBack}>← 返回</button>
        <div>
          <h1 className="ap-confirm__title">确认培养方案</h1>
          <p className="ap-confirm__subtitle">请确认 AI 解析的培养方案信息是否正确</p>
        </div>
        <button type="button" className="ap-btn ap-btn--ghost ap-home-btn" style={{ marginLeft: "auto" }} onClick={() => navigate('/')} title="返回首页"><Home size={15} theme='outline' fill='currentColor' /></button>
      </header>

      <div className="ap-confirm__body">
        {/* 数据来源 / 警告提示 */}
        {warnings && warnings.length > 0 && (
          <div className={`ap-confirm__notice ${source === 'mock' ? 'ap-confirm__notice--mock' : 'ap-confirm__notice--warn'}`}>
            <div className="ap-confirm__notice-icon">{source === 'mock' ? '⚠' : 'ℹ'}</div>
            <div className="ap-confirm__notice-content">
              {warnings.map((w, i) => (
                <div key={i} className="ap-confirm__notice-text">{w}</div>
              ))}
            </div>
          </div>
        )}

        {/* 基本信息 */}
        <div className="ap-confirm__section">
          <h2 className="ap-confirm__section-title">培养方案信息</h2>
          <div className="ap-confirm__info-grid">
            <div className="ap-confirm__info-item">
              <span className="ap-confirm__info-label">专业</span>
              <span className="ap-confirm__info-value">{plan.major}</span>
            </div>
            <div className="ap-confirm__info-item">
              <span className="ap-confirm__info-label">年级</span>
              <span className="ap-confirm__info-value">{plan.grade}</span>
            </div>
            <div className="ap-confirm__info-item">
              <span className="ap-confirm__info-label">版本</span>
              <span className="ap-confirm__info-value">{plan.version}</span>
            </div>
            <div className="ap-confirm__info-item">
              <span className="ap-confirm__info-label">方案名称</span>
              <span className="ap-confirm__info-value">{plan.name}</span>
            </div>
          </div>
        </div>

        {/* 统计 */}
        <div className="ap-confirm__section">
          <h2 className="ap-confirm__section-title">解析统计</h2>
          <div className="ap-confirm__stats">
            {stats.map((s) => (
              <div key={s.label} className="ap-confirm__stat">
                <div className="ap-confirm__stat-value">{s.value}</div>
                <div className="ap-confirm__stat-label">{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 先修关系示例 */}
        <div className="ap-confirm__section">
          <h2 className="ap-confirm__section-title">课程先修关系（部分）</h2>
          <div className="ap-confirm__relations">
            {sampleRelations.map(({ course, prereq }) => (
              <div key={course.id} className="ap-confirm__relation">
                <div className="ap-confirm__relation-node">{prereq!.name}</div>
                <div className="ap-confirm__relation-arrow">↓</div>
                <div className="ap-confirm__relation-node">{course.name}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="ap-confirm__footer">
        <button type="button" className="ap-btn ap-btn--ghost" onClick={onBack}>返回修改</button>
        <button type="button" className="ap-btn ap-btn--primary ap-btn--large" onClick={() => onConfirm(plan)}>
          确认并生成学业路径
        </button>
      </div>
    </div>
  );
};

export default ConfirmPlan;
