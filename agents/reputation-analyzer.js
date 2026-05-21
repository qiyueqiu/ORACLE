/**
 * Reputation Analyzer Agent
 * 百分制信誉评分系统 (0-100)
 *
 * 评分规则：
 *  - 准确性 (0-30): 结果是否正确回答了任务
 *  - 完整性 (0-25): 是否覆盖了任务的所有方面
 *  - 专业性 (0-20): 是否体现了专业知识和深度
 *  - 实用性 (0-15): 结果是否可以直接使用
 *  - 规范性 (0-10): 格式是否清晰、逻辑是否连贯
 *
 * 总分 = 准确性 + 完整性 + 专业性 + 实用性 + 规范性 (满分 100)
 *
 * 惩罚机制:
 *  - 总分 < 40: 链上惩罚 +10
 *  - 总分 < 20: 链上惩罚 +30
 */

const { ethers } = require('ethers');
const { SiliconFlowClient } = require('./siliconflow-client');

const SIGNER_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

const SCORING_DIMENSIONS = [
  { key: 'accuracy', name: '准确性', maxScore: 30, desc: '结果是否正确回答了任务的核心问题' },
  { key: 'completeness', name: '完整性', maxScore: 25, desc: '是否覆盖了任务的所有方面和要求' },
  { key: 'professionalism', name: '专业性', maxScore: 20, desc: '是否体现了专业知识和分析深度' },
  { key: 'practicality', name: '实用性', maxScore: 15, desc: '结果是否具有实际可操作性' },
  { key: 'clarity', name: '规范性', maxScore: 10, desc: '格式是否清晰、逻辑是否连贯' },
];

class ReputationAnalyzerAgent {
  constructor(apiKey, providerUrl, contractAddresses) {
    this.llm = new SiliconFlowClient(apiKey);
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.contracts = {
      agentDID: new ethers.Contract(
        contractAddresses.AgentDID,
        [
          'function agents(address) view returns (address owner, string did, bytes32 commitment, string qualificationType, bool isActive, uint256 registeredAt)',
          'function agentList(uint256) view returns (address)',
          'function agentCount() view returns (uint256)',
        ],
        this.provider
      ),
      auditLog: new ethers.Contract(
        contractAddresses.AuditLog,
        [
          'function getRecord(uint256) view returns (uint256 id, uint256 timestamp, address requester, address targetAgent, string taskDescription, uint8 decisionReason, uint8 executionStatus, string executionResult, uint256 reputationRating, bytes32 transactionHash)',
          'function getRecordsByAgent(address) view returns (uint256[])',
          'function getAllRecords() view returns (uint256[])',
          'function recordCount() view returns (uint256)',
        ],
        this.provider
      ),
      reputation: new ethers.Contract(
        contractAddresses.Reputation,
        [
          'function getReputation(address) view returns (uint256 totalScore, uint256 ratingCount, uint256 averageRating, uint256 lastUpdated)',
          'function addRating(address, uint256) external returns (uint256)',
          'function applyPenalty(address, uint256, string) external',
          'function getAverageRating(address) view returns (uint256)',
          'function isReliable(address) view returns (bool)',
        ],
        this.provider
      ),
    };
    this.signer = new ethers.NonceManager(new ethers.Wallet(SIGNER_PRIVATE_KEY, this.provider));
    this.analysisHistory = [];
  }

  async analyzeExecutionTrace(taskResult) {
    const { task, selectedAgent, executionResult, chainOfThought } = taskResult;

    const dimensionsStr = SCORING_DIMENSIONS.map(d =>
      `- ${d.name} (${d.key}): 0-${d.maxScore}分 — ${d.desc}`
    ).join('\n');

    const analysisPrompt = `你是一个严格的任务执行质量评审专家。请按以下五个维度逐一评分。

## 评分维度（总分 100）
${dimensionsStr}

## 任务
${task}

## 执行 Agent
- DID: ${selectedAgent.did}
- 类型: ${selectedAgent.qualification}

## 执行结果
${executionResult}

## Agent 思考过程
${chainOfThought || '无'}

请严格评审并返回JSON：
{
  "dimensions": {
    "accuracy": { "score": 0, "reason": "评分理由" },
    "completeness": { "score": 0, "reason": "评分理由" },
    "professionalism": { "score": 0, "reason": "评分理由" },
    "practicality": { "score": 0, "reason": "评分理由" },
    "clarity": { "score": 0, "reason": "评分理由" }
  },
  "totalScore": 0,
  "quality": "excellent/good/acceptable/poor/failing",
  "taskCompleted": true/false,
  "summary": "一句话总结评价",
  "strengths": ["优点1", "优点2"],
  "weaknesses": ["不足1"],
  "suggestions": ["改进建议1"],
  "shouldPenalty": false,
  "penaltyReason": ""
}`;

    const startTime = Date.now();

    try {
      const result = await this.llm.chatWithJson(
        'Qwen/Qwen2.5-7B-Instruct',
        [{ role: 'user', content: analysisPrompt }],
        {
          dimensions: {
            accuracy: { score: 0, reason: '' },
            completeness: { score: 0, reason: '' },
            professionalism: { score: 0, reason: '' },
            practicality: { score: 0, reason: '' },
            clarity: { score: 0, reason: '' },
          },
          totalScore: 0,
          quality: 'acceptable',
          taskCompleted: false,
          summary: '',
          strengths: [],
          weaknesses: [],
          suggestions: [],
          shouldPenalty: false,
          penaltyReason: '',
        }
      );

      const analysis = result.data;

      if (analysis.dimensions) {
        let computedTotal = 0;
        for (const dim of SCORING_DIMENSIONS) {
          const d = analysis.dimensions[dim.key];
          if (d) {
            d.score = Math.min(dim.maxScore, Math.max(0, Number(d.score) || 0));
            computedTotal += d.score;
          }
        }
        analysis.totalScore = computedTotal;
      }
      analysis.totalScore = Math.min(100, Math.max(0, Number(analysis.totalScore) || 0));

      if (!analysis.quality) {
        const s = analysis.totalScore;
        analysis.quality = s >= 80 ? 'excellent' : s >= 60 ? 'good' : s >= 40 ? 'acceptable' : s >= 20 ? 'poor' : 'failing';
      }

      this.analysisHistory.push({
        stepId: `analysis-${Date.now()}`,
        stepType: 'analysis',
        agent: 'ReputationAnalyzer',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        phase: 'execution_analysis',
        input: `分析任务: ${task}`,
        output: JSON.stringify(analysis, null, 2),
        tokens: result.usage.total_tokens,
        timestamp: Math.floor(startTime / 1000),
        duration: Date.now() - startTime,
      });

      return analysis;
    } catch (error) {
      const hasContent = executionResult && executionResult.length > 50;
      const fallbackScore = hasContent ? 60 : 25;
      const fallbackDimensions = {};
      for (const dim of SCORING_DIMENSIONS) {
        const base = hasContent ? dim.maxScore * 0.6 : dim.maxScore * 0.25;
        fallbackDimensions[dim.key] = {
          score: Math.round(base),
          reason: hasContent ? 'LLM 分析失败，基于结果长度估算' : '执行结果为空或过短',
        };
      }

      return {
        dimensions: fallbackDimensions,
        totalScore: fallbackScore,
        quality: hasContent ? 'acceptable' : 'failing',
        taskCompleted: hasContent,
        summary: hasContent ? '自动评估：返回了有效内容' : '自动评估：执行结果无效',
        strengths: hasContent ? ['返回了内容'] : [],
        weaknesses: hasContent ? ['无法深度分析'] : ['执行结果为空'],
        suggestions: hasContent ? [] : ['检查 Agent 配置'],
        shouldPenalty: !hasContent,
        penaltyReason: hasContent ? '' : '执行结果无效',
      };
    }
  }

  async submitUserRating(agentAddress, userScore, comment) {
    try {
      const clampedScore = Math.min(100, Math.max(0, userScore));
      const reputationWithSigner = this.contracts.reputation.connect(this.signer);
      const tx = await reputationWithSigner.addRating(agentAddress, clampedScore);
      await tx.wait();

      this.analysisHistory.push({
        stepId: `user-rating-${Date.now()}`,
        stepType: 'user_rating',
        agent: 'User',
        phase: 'user_feedback',
        input: `用户评分: ${clampedScore}/100, 评论: ${comment || '无'}`,
        output: `链上评分成功`,
        tokens: 0,
        timestamp: Math.floor(Date.now() / 1000),
        duration: 0,
      });

      return { success: true, score: clampedScore };
    } catch (error) {
      console.error('用户评分提交失败:', error.message);
      return { success: false, error: error.message };
    }
  }

  async submitRatingOnChain(agentAddress, score) {
    try {
      const reputationWithSigner = this.contracts.reputation.connect(this.signer);
      const tx = await reputationWithSigner.addRating(agentAddress, score);
      await tx.wait();
      return { success: true, txHash: tx.hash };
    } catch (error) {
      console.error('链上评分失败:', error.message);
      return { success: false, error: error.message };
    }
  }

  async applyPenaltyOnChain(agentAddress, penalty, reason) {
    try {
      const reputationWithSigner = this.contracts.reputation.connect(this.signer);
      const tx = await reputationWithSigner.applyPenalty(agentAddress, penalty, reason);
      await tx.wait();
      return { success: true, txHash: tx.hash };
    } catch (error) {
      console.error('链上惩罚失败:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getAgentPerformanceSummary() {
    const summaries = [];
    const count = await this.contracts.agentDID.agentCount();

    for (let i = 0; i < Number(count); i++) {
      const addr = await this.contracts.agentDID.agentList(i);
      const agent = await this.contracts.agentDID.agents(addr);
      const rep = await this.contracts.reputation.getReputation(addr);

      const recordIds = await this.contracts.auditLog.getRecordsByAgent(addr);
      const records = [];
      for (const id of recordIds) {
        const rec = await this.contracts.auditLog.getRecord(Number(id));
        records.push({
          id: Number(rec[0]),
          timestamp: Number(rec[1]),
          status: Number(rec[6]),
          rating: Number(rec[8]),
        });
      }

      const successRate = records.length > 0
        ? records.filter(r => r.status === 1).length / records.length
        : 0;

      const avgRating = Number(rep[2]);
      const ratingCount = Number(rep[1]);

      let reliabilityLevel;
      if (ratingCount >= 3 && avgRating >= 80) reliabilityLevel = 'highly_reliable';
      else if (ratingCount >= 3 && avgRating >= 60) reliabilityLevel = 'reliable';
      else if (ratingCount >= 3 && avgRating < 60) reliabilityLevel = 'unreliable';
      else if (ratingCount > 0) reliabilityLevel = 'evaluating';
      else reliabilityLevel = 'unrated';

      summaries.push({
        address: addr,
        did: agent[1],
        qualification: agent[3],
        isActive: agent[4],
        avgRating,
        ratingCount,
        totalScore: Number(rep[0]),
        totalTasks: records.length,
        successRate: Math.round(successRate * 100),
        trend: this.calculateTrend(records),
        reliabilityLevel,
      });
    }

    return summaries;
  }

  calculateTrend(records) {
    if (records.length < 2) return 'new';
    const recent = records.slice(-3);
    const older = records.slice(0, -3);
    if (older.length === 0) return 'new';
    const recentAvg = recent.reduce((s, r) => s + r.rating, 0) / recent.length;
    const olderAvg = older.reduce((s, r) => s + r.rating, 0) / older.length;
    if (recentAvg > olderAvg + 10) return 'improving';
    if (recentAvg < olderAvg - 10) return 'declining';
    return 'stable';
  }

  async fullAnalysis(taskResult) {
    const analysis = await this.analyzeExecutionTrace(taskResult);

    const score = Math.min(100, Math.max(0, analysis.totalScore));
    const ratingResult = await this.submitRatingOnChain(taskResult.selectedAgent.address, score);

    let penaltyResult = null;
    if (analysis.shouldPenalty && score < 40) {
      const penalty = score < 20 ? 30 : 10;
      penaltyResult = await this.applyPenaltyOnChain(
        taskResult.selectedAgent.address,
        penalty,
        analysis.penaltyReason || '执行质量不达标'
      );
    }

    return {
      analysis,
      ratingResult,
      penaltyResult,
      timestamp: Date.now(),
    };
  }

  getAnalysisHistory() {
    return this.analysisHistory;
  }
}

module.exports = { ReputationAnalyzerAgent, SCORING_DIMENSIONS };
