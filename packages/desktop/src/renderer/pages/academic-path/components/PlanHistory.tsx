import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Home } from '@icon-park/react';
import type { ProgramPlan } from '../types';

interface Props {
  history: ProgramPlan[];
  currentPlanId?: string;
  onBack: () => void;
  onSwitch: (plan: ProgramPlan) => void;
  onReupload: () => void;
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PlanHistory: React.FC<Props> = ({ history, currentPlanId, onBack, onSwitch, onReupload }) => {
  const navigate = useNavigate();
  return (
    <div className='ap-history'>
      <header className='ap-history__header'>
        <div className='ap-history__header-left'>
          <button type='button' className='ap-back' onClick={onBack}>
            ← 返回
          </button>
          <div>
            <h1 className='ap-history__title'>培养方案历史</h1>
            <p className='ap-history__subtitle'>查看过去确认过的培养方案版本</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type='button'
            className='ap-btn ap-btn--ghost ap-home-btn'
            onClick={() => navigate('/')}
            title='返回首页'
          >
            <Home size={15} theme='outline' fill='currentColor' />
          </button>
          <button type='button' className='ap-btn ap-btn--primary' onClick={onReupload}>
            ＋ 重新上传
          </button>
        </div>
      </header>

      <div className='ap-history__scroll'>
        <div className='ap-history__body'>
          {history.length === 0 ? (
            <div className='ap-history__empty'>
              <div className='ap-history__empty-icon'>📋</div>
              <div className='ap-history__empty-title'>还没有培养方案记录</div>
              <div className='ap-history__empty-desc'>上传并确认培养方案后，记录会出现在这里。</div>
            </div>
          ) : (
            <div className='ap-history__list'>
              {history.map((p) => (
                <div
                  key={p.id}
                  className={`ap-history__item ${p.id === currentPlanId ? 'ap-history__item--current' : ''}`}
                >
                  <div className='ap-history__item-main'>
                    <div className='ap-history__item-name'>{p.name}</div>
                    <div className='ap-history__item-meta'>
                      <span>
                        {p.major} · {p.grade}
                      </span>
                      <span>{p.version}</span>
                      <span>
                        {p.courses.length}门课程 · {p.totalCredits ?? '—'}学分
                      </span>
                      <span>确认于 {formatDate(p.confirmedAt)}</span>
                    </div>
                  </div>
                  <div className='ap-history__item-right'>
                    {p.id === currentPlanId && <span className='ap-history__item-badge'>● 当前使用</span>}
                    {p.id !== currentPlanId && (
                      <button type='button' className='ap-btn ap-btn--outline' onClick={() => onSwitch(p)}>
                        切换为此方案
                      </button>
                    )}
                    <button type='button' className='ap-btn ap-btn--ghost' onClick={() => onSwitch(p)}>
                      查看
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PlanHistory;
