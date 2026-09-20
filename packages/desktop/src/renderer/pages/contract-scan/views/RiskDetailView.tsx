import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import '../contract-scan.css';
import type { RedFlag } from '../types';

interface RiskDetailViewProps {
  risk: RedFlag;
  totalRisks: number;
  currentIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}

const RiskDetailView: React.FC<RiskDetailViewProps> = ({
  risk,
  totalRisks,
  currentIndex,
  onPrev,
  onNext,
  onBack,
}) => {
  const navigate = useNavigate();

  return (
    <div className={'cs-risk-detail'}>
      <div className={'cs-entry__bg-glow cs-entry__bg-glow--1'} />
      <div className={'cs-entry__bg-glow cs-entry__bg-glow--2'} />

      {/* 顶部导航 */}
      <header className={'cs-risk-detail__header'}>
        <button className={'cs-entry__back-btn'} onClick={onBack}>
          ← 返回报告
        </button>
        <div className={'cs-risk-detail__nav'}>
          <button
            className={'cs-risk-detail__nav-btn'}
            onClick={onPrev}
            disabled={currentIndex === 0}
          >
            ‹ 上一个
          </button>
          <span className={'cs-risk-detail__counter'}>
            {currentIndex + 1} / {totalRisks}
          </span>
          <button
            className={'cs-risk-detail__nav-btn'}
            onClick={onNext}
            disabled={currentIndex === totalRisks - 1}
          >
            下一个 ›
          </button>
        </div>
      </header>

      {/* 主体内容 */}
      <main className={'cs-risk-detail__main'}>
        {/* 风险标题 */}
        <section className={'cs-risk-detail__title-section'}>
          <span className={'cs-risk-detail__label'}>重点风险</span>
          <h1 className={'cs-risk-detail__title'}>{risk.title}</h1>
          <div className={'cs-risk-detail__level'}>
            <span className={`cs-risk-detail__level-dot cs-risk-detail__level-dot--${risk.severity}`} />
            <span>{risk.severity === 'high' ? '高风险' : '中风险'}</span>
          </div>
          <p className={'cs-risk-detail__intro'}>
            AI 检测到该条款可能存在需要关注的内容，建议在签署前进一步确认。
          </p>
        </section>

        {/* 合同原文 */}
        <section className={'cs-risk-detail__section'}>
          <h3 className={'cs-risk-detail__section-title'}>合同原文</h3>
          <div className={'cs-quote-card'}>
            <div className={'cs-quote-content'}>
              <p>{risk.clauseQuote}</p>
            </div>
          </div>
        </section>

        {/* 为什么需要关注 */}
        <section className={'cs-risk-detail__section'}>
          <h3 className={'cs-risk-detail__section-title'}>为什么需要关注</h3>
          <div className={'cs-explanation-card'}>
            <p>{risk.explanation}</p>
          </div>
        </section>

        {/* AI 建议 */}
        <section className={'cs-risk-detail__section'}>
          <h3 className={'cs-risk-detail__section-title'}>建议怎么处理</h3>
          <div className={'cs-suggestion-card'}>
            <p>{risk.suggestion}</p>
            <button className={'cs-suggestion-copy'}>复制建议</button>
          </div>
        </section>

        {/* 底部操作 */}
        <footer className={'cs-risk-detail__footer'}>
          <button className={'cs-risk-detail__footer-btn'} onClick={onBack}>
            ← 返回报告
          </button>
          <button
            className={'cs-risk-detail__footer-btn cs-risk-detail__footer-btn--primary'}
            onClick={onNext}
            disabled={currentIndex === totalRisks - 1}
          >
            下一个风险 →
          </button>
        </footer>
      </main>
    </div>
  );
};

export default RiskDetailView;
