import React, { useEffect, useRef, useState } from 'react';
import type { MatchSummary } from '../model';

/** 平滑数字动画（count-up） */
const CountUp: React.FC<{ value: number; duration?: number; className?: string }> = ({ value, duration = 520, className }) => {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const cur = Math.round(from + (value - from) * eased);
      fromRef.current = cur;
      setDisplay(cur);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return <span className={className}>{display}</span>;
};

/** 顶部汇总条：✓ 满足 / ! 待确认 / × 未满足 */
const SummaryBar: React.FC<{ summary: MatchSummary }> = ({ summary }) => (
  <div className='ra-summary'>
    <div className='ra-summary__cell'>
      <div className='ra-summary__num ra-summary__num--met'>
        <CountUp value={summary.met} />
        <span className='ra-summary__unit'>项满足</span>
      </div>
      <div className='ra-summary__label'>✓ 已满足</div>
    </div>
    <div className='ra-summary__cell'>
      <div className='ra-summary__num ra-summary__num--missing'>
        <CountUp value={summary.missing} />
        <span className='ra-summary__unit'>项待确认</span>
      </div>
      <div className='ra-summary__label'>! 缺少信息</div>
    </div>
    <div className='ra-summary__cell'>
      <div className='ra-summary__num ra-summary__num--notmet'>
        <CountUp value={summary.notMet} />
        <span className='ra-summary__unit'>项未满足</span>
      </div>
      <div className='ra-summary__label'>× 暂不符合</div>
    </div>
  </div>
);

export default SummaryBar;
