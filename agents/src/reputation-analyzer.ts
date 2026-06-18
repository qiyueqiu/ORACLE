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
 */

import { ethers } from 'ethers';
import { SiliconFlowClient } from './siliconflow-client.js';
import {
  AgentDID__factory,
  AuditLog__factory,
  Reputation__factory,
} from '../../typechain-types/index.js';
import type { AgentDID, AuditLog, Reputation } from '../../typechain-types/index.js';
import type { ExecutionLogEntry } from './types.js';

interface ContractAddresses {
  AgentDID: string;
  AuditLog: string;
  Reputation: string;
}

export interface ScoringDimension {
  key: string;
  name: string;
  maxScore: number;
  desc: string;
}

export const SCORING_DIMENSIONS: ScoringDimension[] = [
  { key: 'accuracy', name: '准确性', maxScore: 30, desc: '结果是否正确回答了任务的核心问题' },
  { key: 'completeness', name: '完整性', maxScore: 25, desc: '是否覆盖了任务的所有方面和要求' },
  { key: 'professionalism', name: '专业性', maxScore: 20, desc: '是否体现了专业知识和分析深度' },
  { key: 'practicality', name: '实用性', maxScore: 15, desc: '结果是否具有实际可操作性' },
  { key: 'clarity', name: '规范性', maxScore: 10, desc: '格式是否清晰、逻辑是否连贯' },
];

interface DimensionScore {
  score: number;
  reason: string;
}

export interface AnalysisResult {
  dimensions: Record<string, DimensionScore>;
  totalScore: number;
  quality: string;
  taskCompleted: boolean;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  shouldPenalty: boolean;
  penaltyReason: string;
}

export interface TaskResult {
  task: string;
  selectedAgent: { did: string; address: string; qualification: string };
  executionResult: string;
  chainOfThought?: string;
  executionLog?: ExecutionLogEntry[];
}

interface ChainCallResult {
  success: boolean;
  score?: number;
  txHash?: string;
  error?: string;
}

export class ReputationAnalyzerAgent {
  private llm: SiliconFlowClient;
  private provider: ethers.JsonRpcProvider;
  private contracts: { agentDID: AgentDID; auditLog: AuditLog; reputation: Reputation };
  private signer: ethers.NonceManager | null;
  private analysisHistory: ExecutionLogEntry[];

  constructor(
    apiKey: string,
    providerUrl: string,
    contractAddresses: ContractAddresses,
    siliconflowClient?: SiliconFlowClient,
  ) {
    this.llm = siliconflowClient || new SiliconFlowClient(apiKey);
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.contracts = {
      agentDID: AgentDID__factory.connect(contractAddresses.AgentDID, this.provider),
      auditLog: AuditLog__factory.connect(contractAddresses.AuditLog, this.provider),
      reputation: Reputation__factory.connect(contractAddresses.Reputation, this.provider),
    };
    // 签名者由调用方注入（避免此处硬编码私钥）
    this.signer = null;
    this.analysisHistory = [];
  }

  setSigner(wallet: ethers.Wallet): void {
    this.signer = new ethers.NonceManager(wallet);
  }

  async analyzeExecutionTrace(taskResult: TaskResult): Promise<AnalysisResult> {
    const { task, selectedAgent, executionResult, chainOfThought } = taskResult;

    const dimensionsStr = SCORING_DIMENSIONS.map(
      (d) => `- ${d.name} (${d.key}): 0-${d.maxScore}分 — ${d.desc}`,
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
  "taskCompleted": true,
  "summary": "一句话总结评价",
  "strengths": ["优点1"],
  "weaknesses": ["不足1"],
  "suggestions": ["改进建议1"],
  "shouldPenalty": false,
  "penaltyReason": ""
}`;

    const startTime = Date.now();

    try {
      const result = await this.llm.chatWithJson<AnalysisResult>(
        'Qwen/Qwen2.5-7B-Instruct',
        [{ role: 'user', content: analysisPrompt }],
        {},
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
        analysis.quality =
          s >= 80 ? 'excellent' : s >= 60 ? 'good' : s >= 40 ? 'acceptable' : s >= 20 ? 'poor' : 'failing';
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
    } catch {
      const hasContent = Boolean(executionResult && executionResult.length > 50);
      const fallbackScore = hasContent ? 60 : 25;
      const fallbackDimensions: Record<string, DimensionScore> = {};
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

  private requireSigner(): ethers.NonceManager {
    if (!this.signer) throw new Error('Reputation signer 未注入，无法发起链上交易');
    return this.signer;
  }

  async submitUserRating(
    agentAddress: string,
    userScore: number,
    comment: string,
  ): Promise<ChainCallResult> {
    try {
      const clampedScore = Math.min(100, Math.max(0, userScore));
      const reputationWithSigner = this.contracts.reputation.connect(this.requireSigner());
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
      const message = error instanceof Error ? error.message : String(error);
      console.error('用户评分提交失败:', message);
      return { success: false, error: message };
    }
  }

  async submitRatingOnChain(agentAddress: string, score: number): Promise<ChainCallResult> {
    try {
      const reputationWithSigner = this.contracts.reputation.connect(this.requireSigner());
      const tx = await reputationWithSigner.addRating(agentAddress, score);
      await tx.wait();
      return { success: true, txHash: tx.hash };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('链上评分失败:', message);
      return { success: false, error: message };
    }
  }

  async applyPenaltyOnChain(
    agentAddress: string,
    penalty: number,
    reason: string,
  ): Promise<ChainCallResult> {
    try {
      const reputationWithSigner = this.contracts.reputation.connect(this.requireSigner());
      const tx = await reputationWithSigner.applyPenalty(agentAddress, penalty, reason);
      await tx.wait();
      return { success: true, txHash: tx.hash };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('链上惩罚失败:', message);
      return { success: false, error: message };
    }
  }

  async getAgentPerformanceSummary(): Promise<Record<string, unknown>[]> {
    const summaries: Record<string, unknown>[] = [];
    const count = await this.contracts.agentDID.agentCount();

    for (let i = 0; i < Number(count); i++) {
      const addr = await this.contracts.agentDID.agentList(i);
      const agent = await this.contracts.agentDID.agents(addr);
      const rep = await this.contracts.reputation.getReputation(addr);

      // 链上回读记录：full 模式有 getRecordsByAgent/getRecord；optimized（event-only）模式
      // 这些 view 不存在，调用会 revert —— 优雅降级为「无链上记录回读」（可发现性靠链下 indexer，
      // 见成本--可验证性帕累托前沿）。此时按任务记录数为 0 统计，successRate/trend 退化但不报错。
      const records: { id: number; timestamp: number; status: number; rating: number }[] = [];
      try {
        const recordIds = await this.contracts.auditLog.getRecordsByAgent(addr);
        for (const id of recordIds) {
          const rec = await this.contracts.auditLog.getRecord(Number(id));
          records.push({
            id: Number(rec.id),
            timestamp: Number(rec.timestamp),
            status: Number(rec.executionStatus),
            rating: Number(rec.reputationRating),
          });
        }
      } catch {
        // optimized 审计模式无链上回读接口；记录统计降级，信誉评分本身仍来自 Reputation 合约
      }

      const successRate =
        records.length > 0 ? records.filter((r) => r.status === 1).length / records.length : 0;

      const avgRating = Number(rep.averageRating);
      const ratingCount = Number(rep.ratingCount);

      let reliabilityLevel: string;
      if (ratingCount >= 3 && avgRating >= 80) reliabilityLevel = 'highly_reliable';
      else if (ratingCount >= 3 && avgRating >= 60) reliabilityLevel = 'reliable';
      else if (ratingCount >= 3 && avgRating < 60) reliabilityLevel = 'unreliable';
      else if (ratingCount > 0) reliabilityLevel = 'evaluating';
      else reliabilityLevel = 'unrated';

      summaries.push({
        address: addr,
        did: agent.did,
        qualification: agent.qualificationType,
        isActive: agent.isActive,
        avgRating,
        ratingCount,
        totalScore: Number(rep.totalScore),
        totalTasks: records.length,
        successRate: Math.round(successRate * 100),
        trend: this.calculateTrend(records),
        reliabilityLevel,
      });
    }

    return summaries;
  }

  private calculateTrend(records: { rating: number }[]): string {
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

  async fullAnalysis(taskResult: TaskResult): Promise<{
    analysis: AnalysisResult;
    ratingResult: ChainCallResult;
    penaltyResult: ChainCallResult | null;
    timestamp: number;
  }> {
    const analysis = await this.analyzeExecutionTrace(taskResult);

    const score = Math.min(100, Math.max(0, analysis.totalScore));
    const ratingResult = await this.submitRatingOnChain(taskResult.selectedAgent.address, score);

    let penaltyResult: ChainCallResult | null = null;
    if (analysis.shouldPenalty && score < 40) {
      const penalty = score < 20 ? 30 : 10;
      penaltyResult = await this.applyPenaltyOnChain(
        taskResult.selectedAgent.address,
        penalty,
        analysis.penaltyReason || '执行质量不达标',
      );
    }

    return { analysis, ratingResult, penaltyResult, timestamp: Date.now() };
  }

  getAnalysisHistory(): ExecutionLogEntry[] {
    return this.analysisHistory;
  }
}
