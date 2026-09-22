import React, { useEffect, useState } from 'react';
import type { ProgramPlan, StudentProgress } from '../types';

const PROFILE_KEY = 'academic-path:my-info';

function loadProfile(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}

interface Props {
  plan: ProgramPlan | null;
  progress: StudentProgress;
}

const MyInfo: React.FC<Props> = ({ plan, progress }) => {
  const [form, setForm] = useState(() => {
    const saved = loadProfile();
    return {
      name: saved.name ?? '',
      studentId: saved.studentId ?? '',
      grade: saved.grade ?? plan?.grade ?? '',
      major: saved.major ?? plan?.major ?? '',
      class: saved.class ?? '',
      ranking: saved.ranking ?? '',
      cet4: saved.cet4 ?? '',
      cet6: saved.cet6 ?? '',
      volunteerHours: saved.volunteerHours ?? '',
      awards: saved.awards ?? '',
      research: saved.research ?? '',
      target: saved.target ?? '',
    };
  });

  const handleChange = (key: string, value: string) => {
    setForm((prev) => {
      const updated = { ...prev, [key]: value };
      try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(updated));
      } catch {
        /* ignore */
      }
      return updated;
    });
  };

  const statuses = progress.courseStatuses;
  let passed = 0,
    failed = 0,
    notTaken = 0,
    earnedCredits = 0;
  let totalGpaPoints = 0,
    totalGpaCredits = 0;
  let requiredGpaPoints = 0,
    requiredGpaCredits = 0;

  if (plan) {
    plan.courses.forEach((c) => {
      const s = statuses[c.id] ?? 'not_taken';
      if (s === 'passed') {
        passed++;
        earnedCredits += c.credits;
      } else if (s === 'failed') failed++;
      else notTaken++;
      if (s === 'passed' && typeof c.gpa === 'number') {
        totalGpaPoints += c.credits * c.gpa;
        totalGpaCredits += c.credits;
        const isRequired =
          c.category === 'required' || c.category === 'core' || c.category === 'general' || c.category === 'practice';
        if (isRequired) {
          requiredGpaPoints += c.credits * c.gpa;
          requiredGpaCredits += c.credits;
        }
      }
    });
  }

  const totalGpa = totalGpaCredits > 0 ? totalGpaPoints / totalGpaCredits : 0;
  const requiredGpa = requiredGpaCredits > 0 ? requiredGpaPoints / requiredGpaCredits : 0;

  return (
    <div className='ap-profile-container'>
      <div className='ap-profile-head'>
        <h1 className='ap-profile-title'>我的信息</h1>
        <p className='ap-profile-sub'>长期个人资料 · 学业进度从当前培养方案自动同步 · AI 规划将基于这些数据为你分析</p>
      </div>

      {/* 学业进度 */}
      <section className='ap-profile-card'>
        <h2 className='ap-profile-card-title'>学业进度</h2>
        <div className='ap-profile-stats-grid'>
          <div className='ap-profile-stat'>
            <div className='ap-profile-stat-value'>{passed}</div>
            <div className='ap-profile-stat-label'>已通过课程</div>
          </div>
          <div className='ap-profile-stat'>
            <div className='ap-profile-stat-value'>{failed}</div>
            <div className='ap-profile-stat-label'>未通过课程</div>
          </div>
          <div className='ap-profile-stat'>
            <div className='ap-profile-stat-value'>{notTaken}</div>
            <div className='ap-profile-stat-label'>未修读课程</div>
          </div>
          <div className='ap-profile-stat'>
            <div className='ap-profile-stat-value'>
              {earnedCredits}
              <span className='ap-profile-stat-total'> / {plan?.totalCredits ?? 0}</span>
            </div>
            <div className='ap-profile-stat-label'>已获学分</div>
          </div>
          <div className='ap-profile-stat'>
            <div className='ap-profile-stat-value'>{totalGpa.toFixed(2)}</div>
            <div className='ap-profile-stat-label'>总绩点</div>
          </div>
          <div className='ap-profile-stat'>
            <div className='ap-profile-stat-value'>{requiredGpa.toFixed(2)}</div>
            <div className='ap-profile-stat-label'>必修绩点</div>
          </div>
        </div>
      </section>

      {/* 基础信息 */}
      <section className='ap-profile-card'>
        <h2 className='ap-profile-card-title'>基础信息</h2>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>姓名</span>
          <input
            className='ap-profile-field-input'
            value={form.name}
            placeholder='请输入姓名'
            onChange={(e) => handleChange('name', e.target.value)}
          />
        </div>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>学号</span>
          <input
            className='ap-profile-field-input'
            value={form.studentId}
            placeholder='请输入学号'
            onChange={(e) => handleChange('studentId', e.target.value)}
          />
        </div>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>年级</span>
          <input
            className='ap-profile-field-input'
            value={form.grade}
            placeholder='2024级'
            onChange={(e) => handleChange('grade', e.target.value)}
          />
        </div>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>专业</span>
          <input
            className='ap-profile-field-input'
            value={form.major}
            placeholder='软件工程'
            onChange={(e) => handleChange('major', e.target.value)}
          />
        </div>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>班级</span>
          <input
            className='ap-profile-field-input'
            value={form.class}
            placeholder='请输入班级'
            onChange={(e) => handleChange('class', e.target.value)}
          />
        </div>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>专业排名</span>
          <input
            className='ap-profile-field-input'
            value={form.ranking}
            placeholder='如：8/120'
            onChange={(e) => handleChange('ranking', e.target.value)}
          />
        </div>
      </section>

      {/* 英语成绩 */}
      <section className='ap-profile-card'>
        <h2 className='ap-profile-card-title'>英语成绩</h2>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>CET-4</span>
          <input
            className='ap-profile-field-input'
            type='number'
            value={form.cet4}
            placeholder='如：425'
            onChange={(e) => handleChange('cet4', e.target.value)}
          />
        </div>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>CET-6</span>
          <input
            className='ap-profile-field-input'
            type='number'
            value={form.cet6}
            placeholder='如：520'
            onChange={(e) => handleChange('cet6', e.target.value)}
          />
        </div>
      </section>

      {/* 综合表现 */}
      <section className='ap-profile-card'>
        <h2 className='ap-profile-card-title'>综合表现</h2>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>志愿服务时长</span>
          <input
            className='ap-profile-field-input'
            type='number'
            value={form.volunteerHours}
            placeholder='如：32'
            onChange={(e) => handleChange('volunteerHours', e.target.value)}
          />
        </div>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>获奖经历</span>
          <input
            className='ap-profile-field-input'
            value={form.awards}
            placeholder='如：校优秀学生干部'
            onChange={(e) => handleChange('awards', e.target.value)}
          />
        </div>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>科研经历</span>
          <input
            className='ap-profile-field-input'
            value={form.research}
            placeholder='如：参与校级科研项目'
            onChange={(e) => handleChange('research', e.target.value)}
          />
        </div>
      </section>

      {/* 未来规划 */}
      <section className='ap-profile-card'>
        <h2 className='ap-profile-card-title'>未来规划</h2>
        <div className='ap-profile-field'>
          <span className='ap-profile-field-label'>发展方向</span>
          <input
            className='ap-profile-field-input'
            value={form.target}
            placeholder='如：保研/考研/就业'
            onChange={(e) => handleChange('target', e.target.value)}
          />
        </div>
      </section>

      <div style={{ padding: '8px 0 24px' }}>
        <button type='button' className='ap-btn ap-btn--primary'>
          保存信息
        </button>
      </div>
    </div>
  );
};

export default MyInfo;
