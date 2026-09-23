import React, { useEffect, useState } from 'react';
import { parsingSteps } from '../constants';

interface Props {
  onDone: () => void;
  /** 解析失败信息（有值时显示失败界面，不播动画） */
  error?: { code: string; message: string } | null;
  /** 点击"重新上传"时回调 */
  onReupload?: () => void;
}

const ParsingState: React.FC<Props> = ({ onDone, error, onReupload }) => {
  const [step, setStep] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (step >= parsingSteps.length) {
      const t = setTimeout(onDone, 600);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStep((s) => s + 1), 700);
    return () => clearTimeout(t);
  }, [step, onDone]);

  // 等待秒数计时
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // 解析失败界面
  if (error) {
    return (
      <div className='ap-parsing'>
        <div className='ap-parsing__card ap-parsing__card--failed'>
          <div className='ap-parsing__failed-icon'>✕</div>
          <h2 className='ap-parsing__title'>解析失败</h2>
          <p className='ap-parsing__failed-msg'>{error.message}</p>
          {error.code && <p className='ap-parsing__failed-code'>错误代码：{error.code}</p>}
          <div className='ap-parsing__failed-actions'>
            <button type='button' className='ap-btn ap-btn--primary ap-btn--large' onClick={onReupload}>
              重新上传
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className='ap-parsing'>
      <div className='ap-parsing__card'>
        <div className='ap-parsing__spinner' />
        <h2 className='ap-parsing__title'>正在理解你的培养方案……</h2>
        <div className='ap-parsing__steps'>
          {parsingSteps.map((s, i) => (
            <div
              key={s}
              className={`ap-parsing__step ${i < step ? 'ap-parsing__step--done' : i === step ? 'ap-parsing__step--active' : ''}`}
            >
              <span className='ap-parsing__step-icon'>{i < step ? '✓' : i === step ? '●' : '○'}</span>
              <span className='ap-parsing__step-text'>{s}</span>
            </div>
          ))}
        </div>
        <p className='ap-parsing__wait-hint'>
          {elapsed < 15
            ? 'AI 正在分析，请耐心等待…'
            : elapsed < 45
              ? `已等待 ${elapsed} 秒，AI 正在深度分析，预计还需 30-60 秒`
              : `已等待 ${elapsed} 秒，分析时间较长，请耐心等待，不要关闭页面`}
        </p>
      </div>
    </div>
  );
};

export default ParsingState;
