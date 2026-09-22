import React, { useEffect, useState } from 'react';
import '../contract-scan.css';

interface ScanningViewProps {
  onCancel: () => void;
}

type StepStatus = 'pending' | 'running' | 'completed';

const ScanningView: React.FC<ScanningViewProps> = ({ onCancel }) => {
  const [step1, setStep1] = useState<StepStatus>('running');
  const [step2, setStep2] = useState<StepStatus>('pending');
  const [step3, setStep3] = useState<StepStatus>('pending');

  useEffect(() => {
    const t1 = setTimeout(() => {
      setStep1('completed');
      setStep2('running');
    }, 2000);

    const t2 = setTimeout(() => {
      setStep2('completed');
      setStep3('running');
    }, 6000);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  const steps = [
    { key: 'rule', label: '法规规则核查', status: step1 },
    { key: 'ai', label: 'AI 智能分析', status: step2 },
    { key: 'report', label: '整理风险报告', status: step3 },
  ];

  return (
    <div className={'csScanning'}>
      <div className={'csScanningInner'}>
        <h2 className={'csScanningTitle'}>合同扫描中</h2>
        <p className={'csScanningSubtitle'}>正在分析这份合同的关键条款</p>

        <div className={'csSteps'}>
          {steps.map((step) => (
            <div key={step.key} className={`csStep csStep_${step.status}`}>
              <span className={'csStepIcon'}>
                {step.status === 'completed' ? '✓' : step.status === 'running' ? '◉' : '○'}
              </span>
              <span className={'csStepLabel'}>{step.label}</span>
            </div>
          ))}
        </div>

        <button type='button' className={'csCancelBtn'} onClick={onCancel}>
          取消扫描
        </button>
      </div>
    </div>
  );
};

export default ScanningView;
