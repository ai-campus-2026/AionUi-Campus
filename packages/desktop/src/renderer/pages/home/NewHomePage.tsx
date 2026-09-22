import React, { useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tooltip } from '@arco-design/web-react';
import { Help, Send, DegreeHat, RuleTwo, Contrast, FileText } from '@icon-park/react';
import GuidModelSelector from '@renderer/pages/guid/components/GuidModelSelector';
import { useHomeChatSend } from './hooks/useHomeChatSend';
import styles from './NewHomePage.module.css';

/* ============ 磁吸气泡可调参数 ============ */
const MAGNETIC_RADIUS = 220; // 触发半径 px（建议 180–260）
const MAGNETIC_STRENGTH = 0.55; // 磁吸强度 0–1
const FLOAT_AMPLITUDE = 20; // 漂浮幅度 px
const FLOAT_PERIOD_MIN = 3500; // 漂浮周期下限 ms
const FLOAT_PERIOD_MAX = 6500; // 漂浮周期上限 ms
const LERP_FACTOR = 0.16; // 每帧插值系数（0.15–0.2）

interface ModuleDef {
  name: string;
  desc: string;
  icon: typeof DegreeHat;
  route: string;
  phase: number;
  accent: string;
  ox: number;
  oy: number;
  size: number;
  speed: number;
  dim: number;
}

const MODULES: ModuleDef[] = [
  {
    name: '学业路径',
    desc: '规划你的课程与学业路径',
    icon: DegreeHat,
    route: '/academic-path',
    phase: 0,
    accent: '#8BA67C',
    ox: -260,
    oy: -120,
    size: 185,
    speed: 1.0,
    dim: 1.0,
  },
  {
    name: '政策对比',
    desc: '快速看懂新旧政策变化',
    icon: Contrast,
    route: '/policy-comparison',
    phase: Math.PI / 2,
    accent: '#B79D71',
    ox: 255,
    oy: -160,
    size: 175,
    speed: 1.25,
    dim: 0.92,
  },
  {
    name: '合同扫描',
    desc: '识别合同风险与注意条款',
    icon: FileText,
    route: '/contract-scan',
    phase: Math.PI,
    accent: '#7A9CC4',
    ox: 270,
    oy: 90,
    size: 180,
    speed: 0.85,
    dim: 0.96,
  },
  {
    name: '规则分析',
    desc: '理解校园规则，判断资格',
    icon: RuleTwo,
    route: '/rule-analysis',
    phase: (3 * Math.PI) / 2,
    accent: '#73AEA9',
    ox: -230,
    oy: 130,
    size: 190,
    speed: 1.15,
    dim: 1.0,
  },
];

const RECOMMENDATIONS = [
  '转专业需要满足什么条件？',
  '奖学金评定规则是什么？',
  '我能申请助学金吗？',
  '帮我比较两个专业培养方案',
];

const NewHomePage: React.FC = () => {
  const navigate = useNavigate();
  const [inputValue, setInputValue] = useState('');
  const [messages, setMessages] = useState<
    Array<{ id: string; text: string; role: 'user' | 'assistant'; timestamp: Date }>
  >([]);
  const homeChat = useHomeChatSend();
  const isLoading = homeChat.sending;
  const messageContainerRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const mouseRef = useRef({ x: -9999, y: -9999, active: false });
  const baseRef = useRef<{ x: number; y: number }[]>([]);
  const offsetRef = useRef<{ x: number; y: number }[]>([]);
  const periodRef = useRef<number[]>([]);
  const reducedMotionRef = useRef(
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  // Format time as relative (e.g., "2 minutes ago")
  const formatRelativeTime = (date: Date): string => {
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return '刚刚';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}分钟前`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}小时前`;
    if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)}天前`;

    return date.toLocaleDateString();
  };

  const handleSend = async () => {
    const text = inputValue.trim();
    if (!text || isLoading) return;
    // Create a real backend conversation and navigate to it. The hook owns
    // assistant/model resolution, error toasts, and the `/conversation/:id`
    // jump — the home box is just the entry point.
    setInputValue('');
    await homeChat.send(text);
  };

  const handleRecommendationClick = (question: string) => setInputValue(question);

  /* 测量气泡基准中心（视口坐标），窗口缩放时重新测量 */
  useEffect(() => {
    const measure = () => {
      for (let i = 0; i < MODULES.length; i++) {
        const el = bubbleRefs.current[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const offset = offsetRef.current[i] ?? { x: 0, y: 0 };
        baseRef.current[i] = {
          x: rect.left + rect.width / 2 - offset.x,
          y: rect.top + rect.height / 2 - offset.y,
        };
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const messageContainer = messageContainerRef.current;
    if (messageContainer) {
      messageContainer.scrollTop = messageContainer.scrollHeight;
    }
  }, [messages]);

  /* 光标跟踪（鼠标 + 触屏） */
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY, active: true };
    };
    const onTouch = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) mouseRef.current = { x: t.clientX, y: t.clientY, active: true };
    };
    const onLeave = () => {
      mouseRef.current.active = false;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchstart', onTouch, { passive: true });
    window.addEventListener('touchmove', onTouch, { passive: true });
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchstart', onTouch);
      window.removeEventListener('touchmove', onTouch);
      document.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  /* 磁吸 + 漂浮动画：只用 transform 直接写 DOM，不触发 React 重渲染；
     标签页隐藏时暂停计算，避免空转 */
  useEffect(() => {
    if (reducedMotionRef.current) return;
    for (let i = 0; i < MODULES.length; i++) {
      offsetRef.current[i] = { x: 0, y: 0 };
      periodRef.current[i] =
        (FLOAT_PERIOD_MIN + Math.random() * (FLOAT_PERIOD_MAX - FLOAT_PERIOD_MIN)) * MODULES[i].speed;
    }
    let rafId = 0;
    const tick = () => {
      if (!document.hidden) {
        const sec = performance.now() / 1000;
        const m = mouseRef.current;
        for (let i = 0; i < MODULES.length; i++) {
          const el = bubbleRefs.current[i];
          const base = baseRef.current[i];
          const offset = offsetRef.current[i];
          if (!el || !base || !offset) continue;
          const period = periodRef.current[i] / 1000;
          const phase = MODULES[i].phase;
          /* 正弦漂浮，相位错开 */
          const fx = Math.sin((sec * 2 * Math.PI) / period + phase) * FLOAT_AMPLITUDE;
          const fy = Math.cos((sec * 2 * Math.PI) / (period * 0.8) + phase * 0.7) * FLOAT_AMPLITUDE * 0.7;
          /* 磁吸：d < R 时按 (1 − d/R) 比例向光标位移，越近吸力越强 */
          const dx = m.x - (base.x + fx);
          const dy = m.y - (base.y + fy);
          const dist = Math.sqrt(dx * dx + dy * dy);
          let targetX = fx;
          let targetY = fy;
          if (m.active && dist < MAGNETIC_RADIUS) {
            const pull = MAGNETIC_STRENGTH * (1 - dist / MAGNETIC_RADIUS);
            targetX = fx + dx * pull;
            targetY = fy + dy * pull;
          }
          /* lerp 平滑跟随；移出半径后目标回到原位，自然弹性回弹 */
          offset.x += (targetX - offset.x) * LERP_FACTOR;
          offset.y += (targetY - offset.y) * LERP_FACTOR;
          el.style.transform = `translate3d(${offset.x.toFixed(2)}px, ${offset.y.toFixed(2)}px, 0)`;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div className={styles.newHomePage}>
      {/* ===== 顶部导航 ===== */}
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark} />
          <span className={styles.brandText}>校园规则解码器</span>
        </div>
        <div className={styles.headerActions}>
          <Tooltip content='帮助'>
            <button type='button' className={styles.headerBtn} aria-label='帮助'>
              <Help theme='outline' fill='currentColor' />
            </button>
          </Tooltip>
        </div>
      </header>

      {/* ===== 主体：中心 AI 工作台 + 环绕气泡 ===== */}
      <main className={styles.mainContent}>
        <section className={styles.bubbleStage} aria-label='功能模块入口'>
          <div className={styles.aiCore} aria-hidden='true'>
            <div className={styles.aiCoreHalo} />
            <div className={styles.aiCoreRing} />
            <div className={styles.aiCoreInner}>
              <span className={styles.aiCoreSparkle} />
            </div>
            <div className={styles.aiCoreLabel}>
              <span className={styles.aiCoreTitle}>校园工作台</span>
              <span className={styles.aiCoreSub}>你的校园规则与学习助手</span>
            </div>
          </div>

          {MODULES.map((mod, i) => {
            const Icon = mod.icon;
            return (
              <button
                key={mod.name}
                ref={(el) => {
                  bubbleRefs.current[i] = el;
                }}
                type='button'
                className={styles.glassBubble}
                style={
                  {
                    '--acc': mod.accent,
                    left: `calc(50% + ${mod.ox}px - ${mod.size / 2}px)`,
                    top: `calc(50% + ${mod.oy}px - ${mod.size / 2}px)`,
                    width: `${mod.size}px`,
                    height: `${mod.size}px`,
                    opacity: mod.dim,
                  } as React.CSSProperties
                }
                onClick={() => navigate(mod.route)}
                aria-label={`进入${mod.name}`}
              >
                <span className={styles.bubbleIcon}>
                  <Icon theme='outline' fill='currentColor' />
                </span>
                <span className={styles.bubbleName}>{mod.name}</span>
                <span className={styles.bubbleDesc}>{mod.desc}</span>
              </button>
            );
          })}
        </section>
      </main>

      {/* ===== 底部对话框 ===== */}
      <section className={styles.dialogSection}>
        <div
          ref={messageContainerRef}
          className={`${styles.messageContainer} ${messages.length === 0 ? styles.messageContainerEmpty : ''}`}
          role='log'
          aria-live='polite'
          aria-label='对话消息'
        >
          {messages.length > 0 && (
            <div className={styles.messagesList}>
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`${styles.message} ${styles[message.role]}`}
                  role='region'
                  aria-label={`${message.role === 'user' ? '您说' : 'AI助手回复'}：${message.text}`}
                >
                  <div className={styles.messageHeader}>
                    <span className={styles.messageRole}>{message.role === 'user' ? '您' : 'AI助手'}</span>
                    <span className={styles.messageTime}>{formatRelativeTime(message.timestamp)}</span>
                  </div>
                  <div className={styles.messageContent}>{message.text}</div>
                </div>
              ))}
              {isLoading && (
                <div className={`${styles.message} ${styles.assistant}`} role='region' aria-label='AI助手正在思考'>
                  <div className={styles.messageHeader}>
                    <span className={styles.messageRole}>AI助手</span>
                    <span className={styles.messageTime}>
                      {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className={styles.messageContent}>
                    <div className={styles.typingIndicator}>
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className={styles.suggestionRow}>
          {RECOMMENDATIONS.map((q) => (
            <button
              key={q}
              type='button'
              className={styles.suggestionChip}
              onClick={() => handleRecommendationClick(q)}
            >
              {q}
            </button>
          ))}
        </div>

        <div className={styles.aiInputBox}>
          <textarea
            className={styles.aiInput}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder='请输入您的问题，Enter 发送，Shift+Enter 换行'
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <div className={styles.modelSelectorSlot}>
            <GuidModelSelector
              isGeminiMode
              modelList={homeChat.modelList}
              current_model={homeChat.currentModel}
              setCurrentModel={homeChat.setCurrentModel}
              currentAcpCachedModelInfo={null}
              selectedAcpModel={null}
              setSelectedAcpModel={() => {}}
            />
          </div>
          <button
            type='button'
            className={styles.sendButton}
            onClick={handleSend}
            disabled={isLoading || !inputValue.trim()}
            aria-label='发送'
          >
            <Send theme='outline' fill='currentColor' />
          </button>
        </div>
      </section>

      {/* ===== 页脚 ===== */}
      <footer className={styles.footer}>© 2026 AionUI · 校园规则解码器</footer>
    </div>
  );
};

export default NewHomePage;
