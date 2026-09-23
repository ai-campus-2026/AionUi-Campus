import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Typography, Grid, Input, Tooltip, Badge, Popover } from '@arco-design/web-react';
import { Search, History, Help, MenuFold, Right, Send, Close } from '@icon-park/react';
import styles from './NewHomePage.module.css';

const NewHomePage: React.FC = () => {
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isMouseActive, setIsMouseActive] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  // Mock recent conversations for demo
  const recentConversations = [
    { id: '1', title: '转专业政策解读', time: '2分钟前' },
    { id: '2', title: '奖学金评定规则', time: '15分钟前' },
    { id: '3', title: '助学金申请条件', time: '1小时前' },
    { id: '4', title: '比较计算机与人工智能专业', time: '3小时前' },
  ];

  const handleHistoryToggle = () => {
    setIsHistoryOpen(!isHistoryOpen);
  };

  const handleHistoryClick = (id: string) => {
    console.log('Navigate to conversation:', id);
    setIsHistoryOpen(false);
  };

  // Close history when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(event.target as Node)) {
        setIsHistoryOpen(false);
      }
    };

    if (isHistoryOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isHistoryOpen]);

  const handleSend = () => {
    if (inputValue.trim()) {
      console.log('Sending:', inputValue);
      setInputValue('');
    }
  };

  const handleRecommendationClick = (question: string) => {
    setInputValue(question);
  };

  const recommendations = [
    '转专业需要满足什么条件？',
    '奖学金评定规则是什么？',
    '我能申请助学金吗？',
    '帮我比较两个专业培养方案',
    '毕业要求有哪些？',
    '实习学分如何认定？',
  ];

  const handleAcademicPathClick = () => {
    window.location.href = '/academic-path';
  };

  const handleRuleAnalysisClick = () => {
    window.location.href = '/rule-analysis';
  };

  const handlePolicyComparisonClick = () => {
    window.location.href = '/policy-comparison';
  };

  // Magnetic bubble configuration
  const MAGNETIC_RADIUS = 220; // pixels
  const MAGNETIC_STRENGTH = 0.8; // 0-1
  const FLOATING_AMPLITUDE = 8; // pixels
  const FLOATING_PERIOD = 8000; // milliseconds

  // Bubble positions and states
  const [bubblePositions, setBubblePositions] = useState([
    { x: 0, y: 0, originalX: 0, originalY: 0, phase: 0 },
    { x: 0, y: 0, originalX: 0, originalY: 0, phase: (2 * Math.PI) / 3 },
    { x: 0, y: 0, originalX: 0, originalY: 0, phase: (4 * Math.PI) / 3 },
  ]);

  // Initialize bubble positions on mount
  useEffect(() => {
    // Set initial positions based on grid layout
    const updatePositions = () => {
      const container = document.querySelector(`.${styles.modulesSection}`);
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Position bubbles in a triangle pattern around center
      setBubblePositions((prev) => [
        { ...prev[0], originalX: centerX - 120, originalY: centerY - 60, x: centerX - 120, y: centerY - 60 },
        { ...prev[1], originalX: centerX, originalY: centerY + 80, x: centerX, y: centerY + 80 },
        { ...prev[2], originalX: centerX + 120, originalY: centerY - 60, x: centerX + 120, y: centerY - 60 },
      ]);
    };

    updatePositions();

    // Handle window resize
    const handleResize = () => {
      updatePositions();
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Mouse/touch event handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
      setIsMouseActive(true);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        setMousePosition({ x: e.touches[0].clientX, y: e.touches[0].clientY });
        setIsMouseActive(true);
      }
    };

    const handleMouseLeave = () => {
      setIsMouseActive(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchmove', handleTouchMove);
    window.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  // Animation loop for magnetic bubbles
  useEffect(() => {
    let animationFrameId: number;

    const animate = () => {
      if (!isMouseActive) {
        // Apply floating animation when idle
        setBubblePositions((prev) =>
          prev.map((bubble, index) => {
            const time = Date.now() / 1000;
            const floatX = Math.sin(time * 0.5 + bubble.phase) * FLOATING_AMPLITUDE;
            const floatY = Math.cos(time * 0.3 + bubble.phase * 0.7) * FLOATING_AMPLITUDE;

            // Smoothly interpolate back to original position
            const newX = bubble.x + (bubble.originalX - bubble.x) * 0.05;
            const newY = bubble.y + (bubble.originalY - bubble.y) * 0.05;

            return {
              ...bubble,
              x: newX + floatX,
              y: newY + floatY,
            };
          })
        );
      } else {
        // Apply magnetic attraction
        setBubblePositions((prev) =>
          prev.map((bubble) => {
            const dx = mousePosition.x - bubble.originalX;
            const dy = mousePosition.y - bubble.originalY;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < MAGNETIC_RADIUS) {
              // Calculate attraction force
              const force = MAGNETIC_STRENGTH * (1 - distance / MAGNETIC_RADIUS);
              const targetX = bubble.originalX + dx * force;
              const targetY = bubble.originalY + dy * force;

              // Smooth interpolation toward target
              const newX = bubble.x + (targetX - bubble.x) * 0.15;
              const newY = bubble.y + (targetY - bubble.y) * 0.15;

              return { ...bubble, x: newX, y: newY };
            }

            // Smoothly interpolate back to original position
            const newX = bubble.x + (bubble.originalX - bubble.x) * 0.05;
            const newY = bubble.y + (bubble.originalY - bubble.y) * 0.05;

            return { ...bubble, x: newX, y: newY };
          })
        );
      }

      animationFrameId = requestAnimationFrame(animate);
    };

    animationFrameId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isMouseActive, mousePosition]);

  return (
    <div className={styles.newHomePage}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.brand}>
          <Typography.Text bold style={{ fontSize: 20 }}>
            AionUI
          </Typography.Text>
        </div>
        <div className={styles.headerActions}>
          <Tooltip content='搜索'>
            <Button type='text' size='small' icon={<Search theme='outline' size='16' />} />
          </Tooltip>
          <Tooltip content='对话历史'>
            <Button
              type='text'
              size='small'
              icon={<History theme='outline' size='16' />}
              onClick={handleHistoryToggle}
              className={isHistoryOpen ? styles.activeIcon : ''}
            />
          </Tooltip>
          <Tooltip content='帮助'>
            <Button type='text' size='small' icon={<Help theme='outline' size='16' />} />
          </Tooltip>
        </div>
      </header>

      {/* Main Content */}
      <main className={styles.mainContent}>
        {/* Hero Section */}
        <div className={styles.heroSection}>
          <Typography.Title heading={1} style={{ marginBottom: 8, fontWeight: 600 }}>
            校园规则解码器
          </Typography.Title>
          <Typography.Text type='secondary' style={{ fontSize: 18, marginBottom: 32 }}>
            理解规则，从这里开始。
          </Typography.Text>

          {/* AI Input Box - Liquid Glass Effect */}
          <div className={styles.aiInputContainer}>
            <div
              className={`${styles.aiInputBox} ${isInputFocused ? styles.focused : ''}`}
              style={{
                boxShadow: isInputFocused
                  ? '0 8px 32px rgba(74, 140, 114, 0.15)'
                  : '0 4px 16px rgba(74, 140, 114, 0.1)',
              }}
            >
              <Input.TextArea
                value={inputValue}
                onChange={setInputValue}
                placeholder='请输入您的问题...'
                autoSize={{ minRows: 2, maxRows: 4 }}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => setIsInputFocused(false)}
                onPressEnter={(e) => {
                  if (!e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                className={styles.aiInput}
              />
              <Button
                type='primary'
                size='large'
                icon={<Send theme='outline' size='16' />}
                onClick={handleSend}
                className={styles.sendButton}
              />
            </div>
          </div>
        </div>

        {/* Recommendations */}
        <div className={styles.recommendationsSection}>
          <Typography.Text type='secondary' style={{ fontSize: 14, marginBottom: 16 }}>
            常见问题
          </Typography.Text>
          <div className={styles.recommendationsGrid}>
            {recommendations.map((question, index) => (
              <div
                key={index}
                className={styles.recommendationItem}
                onClick={() => handleRecommendationClick(question)}
              >
                <Typography.Text style={{ fontSize: 14 }}>{question}</Typography.Text>
                <Right theme='outline' size='12' className={styles.recommendationArrow} />
              </div>
            ))}
          </div>
        </div>

        {/* Quick Access Modules - Magnetic Bubbles */}
        <div className={styles.modulesSection}>
          <Typography.Text type='secondary' style={{ fontSize: 14, marginBottom: 24 }}>
            快捷入口
          </Typography.Text>

          {/* Academic Path Module - Magnetic Bubble */}
          <div
            className={styles.magneticBubble}
            style={{
              position: 'absolute',
              left: `${bubblePositions[0].x}px`,
              top: `${bubblePositions[0].y}px`,
              transform: 'translate(-50%, -50%)',
              transition: 'transform 0.1s ease-out',
            }}
            onClick={handleAcademicPathClick}
          >
            <div className={styles.moduleCard}>
              <div className={styles.moduleContent}>
                <div className={styles.moduleIcon}>🎓</div>
                <Typography.Title heading={4} style={{ marginTop: 12, marginBottom: 8, fontWeight: 600 }}>
                  学业路径
                </Typography.Title>
                <Typography.Text type='secondary' style={{ fontSize: 14 }}>
                  规划您的学术旅程
                </Typography.Text>
                <Right theme='outline' size='14' className={styles.moduleArrow} />
              </div>
            </div>
          </div>

          {/* Rule Analysis Module - Magnetic Bubble */}
          <div
            className={styles.magneticBubble}
            style={{
              position: 'absolute',
              left: `${bubblePositions[1].x}px`,
              top: `${bubblePositions[1].y}px`,
              transform: 'translate(-50%, -50%)',
              transition: 'transform 0.1s ease-out',
            }}
            onClick={handleRuleAnalysisClick}
          >
            <div className={styles.moduleCard}>
              <div className={styles.moduleContent}>
                <div className={styles.moduleIcon}>🔍</div>
                <Typography.Title heading={4} style={{ marginTop: 12, marginBottom: 8, fontWeight: 600 }}>
                  规则分析
                </Typography.Title>
                <Typography.Text type='secondary' style={{ fontSize: 14 }}>
                  解读大学规章制度
                </Typography.Text>
                <Right theme='outline' size='14' className={styles.moduleArrow} />
              </div>
            </div>
          </div>

          {/* Policy Comparison Module - Magnetic Bubble */}
          <div
            className={styles.magneticBubble}
            style={{
              position: 'absolute',
              left: `${bubblePositions[2].x}px`,
              top: `${bubblePositions[2].y}px`,
              transform: 'translate(-50%, -50%)',
              transition: 'transform 0.1s ease-out',
            }}
            onClick={handlePolicyComparisonClick}
          >
            <div className={styles.moduleCard}>
              <div className={styles.moduleContent}>
                <div className={styles.moduleIcon}>📊</div>
                <Typography.Title heading={4} style={{ marginTop: 12, marginBottom: 8, fontWeight: 600 }}>
                  政策对比
                </Typography.Title>
                <Typography.Text type='secondary' style={{ fontSize: 14 }}>
                  比较不同政策差异
                </Typography.Text>
                <Right theme='outline' size='14' className={styles.moduleArrow} />
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* History Popover */}
      {isHistoryOpen && (
        <div
          ref={historyRef}
          className={styles.historyPopover}
          style={{
            top: '64px',
            right: '24px',
            transform: 'translateY(8px)',
            animation: 'fadeInUp 0.3s ease-out',
          }}
        >
          <div className={styles.historyHeader}>
            <Typography.Text bold>最近对话</Typography.Text>
            <Button
              type='text'
              size='small'
              icon={<Close theme='outline' size='14' />}
              onClick={() => setIsHistoryOpen(false)}
            />
          </div>
          <div className={styles.historyList}>
            {recentConversations.map((conv) => (
              <div key={conv.id} className={styles.historyItem} onClick={() => handleHistoryClick(conv.id)}>
                <Typography.Text style={{ fontSize: 14 }}>{conv.title}</Typography.Text>
                <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                  {conv.time}
                </Typography.Text>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className={styles.footer}>
        <Typography.Text type='secondary' style={{ fontSize: 12 }}>
          © 2026 AionUI · 校园规则解码器
        </Typography.Text>
      </footer>
    </div>
  );
};

export default NewHomePage;
