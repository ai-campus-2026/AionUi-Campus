import React, { useState } from 'react';
import { Button, Grid, Typography, Card } from '@arco-design/web-react';
import { useNavigate } from 'react-router-dom';
import { Right } from '@icon-park/react';
import styles from './HomePage.module.css';

const HomePage: React.FC = () => {
  const navigate = useNavigate();

  const handleAcademicPathClick = () => {
    navigate('/academic-path');
  };

  const handleRuleAnalysisClick = () => {
    navigate('/rule-analysis');
  };

  const handlePolicyComparisonClick = () => {
    navigate('/policy-comparison');
  };

  return (
    <div className={styles.homePage}>
      {/* Header Section */}
      <div className={styles.header}>
        <Typography.Title heading={2} style={{ marginBottom: 0 }}>
          校园规则解码器
        </Typography.Title>
        <Typography.Text type='secondary' style={{ fontSize: 16 }}>
          您的AI学术政策助手
        </Typography.Text>
      </div>

      {/* Main Content - Three Large Modules */}
      <div className={styles.modulesContainer}>
        <Grid.Row gutter={[24, 24]}>
          {/* Academic Path Module */}
          <Grid.Col xs={24} sm={24} md={8}>
            <Card className={styles.moduleCard} hoverable onClick={handleAcademicPathClick}>
              <div className={styles.moduleContent}>
                <div className={styles.moduleIcon}>🎓</div>
                <Typography.Title heading={4} style={{ marginTop: 16, marginBottom: 8 }}>
                  学业路径
                </Typography.Title>
                <Typography.Text type='secondary' style={{ fontSize: 14 }}>
                  基于大学政策和要求，为您提供个性化的学业规划指导。
                </Typography.Text>
                <Button type='text' size='small' style={{ marginTop: 16 }}>
                  探索路径 <Right theme='outline' size='12' />
                </Button>
              </div>
            </Card>
          </Grid.Col>

          {/* Rule Analysis Module */}
          <Grid.Col xs={24} sm={24} md={8}>
            <Card className={styles.moduleCard} hoverable onClick={handleRuleAnalysisClick}>
              <div className={styles.moduleContent}>
                <div className={styles.moduleIcon}>🔍</div>
                <Typography.Title heading={4} style={{ marginTop: 16, marginBottom: 8 }}>
                  规则分析
                </Typography.Title>
                <Typography.Text type='secondary' style={{ fontSize: 14 }}>
                  使用AI驱动的洞察和解释来分析大学规章制度和政策。
                </Typography.Text>
                <Button type='text' size='small' style={{ marginTop: 16 }}>
                  分析规则 <Right theme='outline' size='12' />
                </Button>
              </div>
            </Card>
          </Grid.Col>

          {/* Policy Comparison Module */}
          <Grid.Col xs={24} sm={24} md={8}>
            <Card className={styles.moduleCard} hoverable onClick={handlePolicyComparisonClick}>
              <div className={styles.moduleContent}>
                <div className={styles.moduleIcon}>📊</div>
                <Typography.Title heading={4} style={{ marginTop: 16, marginBottom: 8 }}>
                  政策对比
                </Typography.Title>
                <Typography.Text type='secondary' style={{ fontSize: 14 }}>
                  并排比较不同大学政策，了解差异及其影响。
                </Typography.Text>
                <Button type='text' size='small' style={{ marginTop: 16 }}>
                  对比政策 <Right theme='outline' size='12' />
                </Button>
              </div>
            </Card>
          </Grid.Col>
        </Grid.Row>
      </div>

      {/* Chat Box at Bottom */}
      <div className={styles.chatContainer}>
        <div className={styles.chatHeader}>
          <Typography.Text style={{ fontWeight: 600 }}>AI助手</Typography.Text>
        </div>
        <div className={styles.chatInput}>
          <input type='text' placeholder='请输入您的问题...' className={styles.chatInputField} />
          <Button type='primary' size='small' className={styles.chatSendButton}>
            发送
          </Button>
        </div>
      </div>
    </div>
  );
};

export default HomePage;
