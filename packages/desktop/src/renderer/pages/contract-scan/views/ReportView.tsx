import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../contract-scan.css';
import type { ContractReport } from '../types';

interface ReportViewProps {
  report: ContractReport;
  onRescan: () => void;
  onShowHistory: () => void;
}

const ReportView: React.FC<ReportViewProps> = ({ report, onRescan, onShowHistory }) => {
  const navigate = useNavigate();
  const [selectedRiskIndex, setSelectedRiskIndex] = useState(0);
  const [expandedStatuteId, setExpandedStatuteId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const selectedRisk = report.redFlags[selectedRiskIndex];

  const statuteOk = report.statuteChecks.filter((s) => s.status === 'ok').length;
  const statuteViolation = report.statuteChecks.filter((s) => s.status === 'violation').length;
  const statuteUnknown = report.statuteChecks.filter((s) => s.status === 'unknown').length;

  const handleCopyRedline = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getSeverityColor = (severity: string) => {
    if (severity === 'high') return '#c06c5a';
    if (severity === 'medium') return '#c4a968';
    return '#999';
  };

  const getSeverityLabel = (severity: string) => {
    if (severity === 'high') return '高风险';
    if (severity === 'medium') return '中风险';
    return '低风险';
  };

  const getStatuteStatusIcon = (status: string) => {
    if (status === 'ok') return '✓';
    if (status === 'violation') return '✕';
    return '?';
  };

  const getStatuteStatusClass = (status: string) => {
    if (status === 'ok') return 'cs-statute-item--ok';
    if (status === 'violation') return 'cs-statute-item--violation';
    return 'cs-statute-item--unknown';
  };

  return (
    <div className={'cs-report'}>
      <div className={'cs-entry__bg-glow cs-entry__bg-glow--1'} />
      <div className={'cs-entry__bg-glow cs-entry__bg-glow--2'} />

      {/* 顶部导航 */}
      <header className={'cs-report__header'}>
        <div className={'cs-report__header-left'}>
          <button className={'cs-entry__back-btn'} onClick={onRescan}>
            ← 返回
          </button>
          <div className={'cs-report__header-titles'}>
            <h1 className={'cs-report__doc-title'}>《{report.meta.title}》</h1>
            <p className={'cs-report__doc-subtitle'}>
              {String(report.meta.contractType)} · 刚刚完成分析
            </p>
          </div>
        </div>
        <div className={'cs-report__header-actions'}>
          <button 
            onClick={onShowHistory}
            style={{
              color: '#fff',
              background: 'linear-gradient(135deg, #7f9d78, #648b80)',
              border: 'none',
              borderRadius: '9px',
              padding: '6px 14px',
              fontSize: '12.5px',
              fontWeight: 500,
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(70, 100, 84, 0.2)',
            }}
          >
            历史扫描
          </button>
          <button className={'cs-report__rescan-btn'} onClick={onRescan}>
            重新扫描
          </button>
          <button className={'cs-report__more-btn'}>
            ···
          </button>
        </div>
      </header>

      <main className={'cs-report__main'}>
        {/* ===== 综合分析 Hero ===== */}
        <section className={'cs-report__hero'}>
          <div className={'cs-report__hero-left'}>
            <div className={'cs-score-circle'}>
              <span className={'cs-score-number'}>{report.score}</span>
              <span className={'cs-score-grade'}>{report.grade}</span>
            </div>
            <p className={'cs-score-label'}>综合风险参考</p>
          </div>
          <div className={'cs-report__hero-right'}>
            <h2 className={'cs-report__summary-title'}>AI 总结</h2>
            <p className={'cs-report__summary-text'}>{report.summary}</p>
          </div>
        </section>

        {/* ===== 风险概览统计 ===== */}
        <div className={'cs-report__stats'}>
          <div className={'cs-stat cs-stat--high'}>
            <span className={'cs-stat-number'}>{report.redFlags.length}</span>
            <span className={'cs-stat-label'}>重点风险</span>
          </div>
          <div className={'cs-stat cs-stat--medium'}>
            <span className={'cs-stat-number'}>{report.warnings.length}</span>
            <span className={'cs-stat-label'}>一般隐患</span>
          </div>
          <div className={'cs-stat cs-stat--good'}>
            <span className={'cs-stat-number'}>{report.goodClauses.length}</span>
            <span className={'cs-stat-label'}>保护条款</span>
          </div>
        </div>

        {/* ===== 重点风险：导航 + 详情 ===== */}
        {report.redFlags.length > 0 && (
          <section className={'cs-report__section'}>
            <h3 className={'cs-report__section-title'}>需要重点关注</h3>
            <div className={'cs-risk-layout'}>
              {/* 左侧风险导航 */}
              <div className={'cs-risk-nav'}>
                {report.redFlags.map((flag, index) => (
                  <div
                    key={flag.id}
                    className={`cs-risk-nav-item ${selectedRiskIndex === index ? 'cs-risk-nav-item--active' : ''}`}
                    onClick={() => setSelectedRiskIndex(index)}
                  >
                    <span
                      className={'cs-risk-nav-dot'}
                      style={{ background: getSeverityColor(flag.severity) }}
                    />
                    <div className={'cs-risk-nav-content'}>
                      <span className={'cs-risk-nav-title'}>{flag.title}</span>
                      {flag.clause && (
                        <span className={'cs-risk-nav-clause'}>{flag.clause}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* 右侧风险详情 */}
              {selectedRisk && (
                <div className={'cs-risk-detail-panel'}>
                  <div className={'cs-risk-detail-header'}>
                    <span
                      className={'cs-risk-severity-badge'}
                      style={{ color: getSeverityColor(selectedRisk.severity) }}
                    >
                      {getSeverityLabel(selectedRisk.severity)}
                    </span>
                    <h4 className={'cs-risk-detail-title'}>{selectedRisk.title}</h4>
                  </div>

                  {/* 合同原文 */}
                  {selectedRisk.clauseQuote && (
                    <div className={'cs-risk-detail-block'}>
                      <span className={'cs-risk-block-label'}>合同原文</span>
                      <div className={'cs-quote-inline'}>
                        <p>{selectedRisk.clauseQuote}</p>
                      </div>
                    </div>
                  )}

                  {/* 为什么需要关注 */}
                  <div className={'cs-risk-detail-block'}>
                    <span className={'cs-risk-block-label'}>为什么需要关注</span>
                    <p className={'cs-risk-explanation'}>{selectedRisk.explanation}</p>
                  </div>

                  {/* 建议怎么处理 */}
                  <div className={'cs-risk-detail-block'}>
                    <span className={'cs-risk-block-label'}>建议怎么处理</span>
                    <p className={'cs-risk-suggestion'}>{selectedRisk.suggestion}</p>
                  </div>

                  {/* 建议修改措辞 */}
                  {selectedRisk.redline && (
                    <div className={'cs-risk-detail-block cs-redline-block'}>
                      <span className={'cs-risk-block-label'}>建议修改措辞</span>
                      <div className={'cs-redline-content'}>
                        <p>{selectedRisk.redline}</p>
                        <button
                          className={'cs-copy-btn'}
                          onClick={() => handleCopyRedline(selectedRisk.redline!)}
                        >
                          
                          {copied ? '已复制' : '复制改写措辞'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ===== 一般隐患 ===== */}
        {report.warnings.length > 0 && (
          <section className={'cs-report__section'}>
            <h3 className={'cs-report__section-title'}>一般隐患</h3>
            <div className={'cs-warning-list'}>
              {report.warnings.map((warning) => (
                <div key={warning.id} className={'cs-warning-item'}>
                  <span className={'cs-warning-dot'} />
                  <div className={'cs-warning-content'}>
                    <span className={'cs-warning-title'}>{warning.title}</span>
                    <p className={'cs-warning-explanation'}>{warning.explanation}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ===== 做得不错 ===== */}
        {report.goodClauses.length > 0 && (
          <section className={'cs-report__section'}>
            <h3 className={'cs-report__section-title'}>这份合同做得不错</h3>
            <div className={'cs-good-list'}>
              {report.goodClauses.map((good) => (
                <div key={good.id} className={'cs-good-item'}>
                  <span className={'cs-good-check'}>✓</span>
                  <div>
                    <span className={'cs-good-title'}>{good.title}</span>
                    {good.explanation && (
                      <p className={'cs-good-explanation'}>{good.explanation}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ===== 还有这些需要确认 ===== */}
        {report.missingProtections.length > 0 && (
          <section className={'cs-report__section'}>
            <h3 className={'cs-report__section-title'}>还有这些需要确认</h3>
            <div className={'cs-missing-list'}>
              {report.missingProtections.map((missing) => (
                <span key={missing.id} className={'cs-missing-chip'}>
                  {missing.title}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* ===== 法规核查 ===== */}
        {report.statuteChecks.length > 0 && (
          <section className={'cs-report__section'}>
            <div className={'cs-report__section-header'}>
              <h3 className={'cs-report__section-title'}>法规核查</h3>
              <span className={'cs-statute-count'}>
                {report.statuteChecks.length} 项检查
              </span>
            </div>

            {/* 统计 */}
            <div className={'cs-statute-stats-bar'}>
              <span className={'cs-statute-stat cs-statute-stat--ok'}>✓ {statuteOk} 符合</span>
              <span className={'cs-statute-stat cs-statute-stat--violation'}>✕ {statuteViolation} 存在问题</span>
              <span className={'cs-statute-stat cs-statute-stat--unknown'}>? {statuteUnknown} 无法确认</span>
            </div>

            {/* 检查列表 */}
            <div className={'cs-statute-list'}>
              {report.statuteChecks.map((check) => (
                <div
                  key={check.id}
                  className={`cs-statute-row ${getStatuteStatusClass(check.status)} ${expandedStatuteId === check.id ? 'cs-statute-row--expanded' : ''}`}
                >
                  <div
                    className={'cs-statute-row-header'}
                    onClick={() => setExpandedStatuteId(expandedStatuteId === check.id ? null : check.id)}
                  >
                    <span className={'cs-statute-row-icon'}>
                      {getStatuteStatusIcon(check.status)}
                    </span>
                    <span className={'cs-statute-row-title'}>{check.title}</span>
                    <span className={'cs-statute-row-expand'}>
                      {expandedStatuteId === check.id ? '收起' : '展开'}
                    </span>
                  </div>

                  {expandedStatuteId === check.id && (
                    <div className={'cs-statute-row-detail'}>
                      <p className={'cs-statute-detail-text'}>{check.explanation}</p>
                      {check.regulationRef && (
                        <div className={'cs-statute-basis'}>
                          <span className={'cs-statute-basis-label'}>依据</span>
                          <span>{check.regulationRef}</span>
                        </div>
                      )}
                      <div className={'cs-statute-source'}>
                        证据来源：{check.source === 'both' ? '正则 + AI 双重确认' : '规则检查'}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 底部信息 */}
        <footer className={'cs-report__footer'}>
          <span>分析耗时：{report.analysisDuration || 34.2}s</span>
          <span>合同类型：{String(report.meta.contractType)}</span>
          {report.analysisId && <span>编号：{report.analysisId}</span>}
        </footer>
      </main>
    </div>
  );
};

export default ReportView;
