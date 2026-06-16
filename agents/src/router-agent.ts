/**
 * Router Agent - LLM 驱动的任务路由器
 * 负责意图解析、候选 Agent 评估、决策
 */

import { ethers } from 'ethers';
import { SiliconFlowClient } from './siliconflow-client.js';
import { AgentDID__factory, Reputation__factory } from '../../typechain-types/index.js';
import type { AgentDID, Reputation } from '../../typechain-types/index.js';
import type { Intent, Candidate, EvalResult, RouteResult, ExecutionLogEntry } from './types.js';
import { toQualification } from './types.js';

interface ContractAddresses {
  AgentDID: string;
  AuditLog: string;
  Reputation: string;
}

interface IntentRanking {
  index: number;
  score: number;
  reason: string;
}

/**
 * 确定性规则评分（论文公式 (3)）：score = 0.6·q + 0.4·rNorm
 *   q ∈ {60, 40}（资质匹配 60，否则 40），rNorm = avgRating · 0.4（百分制 0-100 → 0-40）
 * 满分 100。纯函数、无随机性——LLM 不可用时的确定性兜底，保证审计可复现（P1-C4）。
 */
export function ruleScore(candidate: Candidate, requiredQualification: string): number {
  const q = candidate.qualification === requiredQualification ? 60 : 40;
  const rNorm = candidate.avgRating * 0.4;
  return 0.6 * q + 0.4 * rNorm;
}

/** 把任意 LLM 返回的分数收敛到 [0, 100] 区间，防止越界分污染排序（P1-C4） */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, score));
}

export class RouterAgent {
  private llm: SiliconFlowClient;
  private provider: ethers.JsonRpcProvider;
  private contracts: { agentDID: AgentDID; reputation: Reputation };
  executionLog: ExecutionLogEntry[];

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
      reputation: Reputation__factory.connect(contractAddresses.Reputation, this.provider),
    };
    this.executionLog = [];
  }

  /**
   * 步骤 1: 意图解析（论文 parseIntent）
   */
  async parseIntent(taskDescription: string): Promise<Intent> {
    const prompt = `分析任务，返回JSON：{"intent":"意图","requiredQualification":"code_review/data_analysis/translation/research/creative/weather/content/calc","complexity":"simple/medium/complex","priority":"speed/quality/balance"}\n\n可用Agent类型: code_review(代码审查), data_analysis(数据分析), translation(翻译), research(研究), creative(创意写作), weather(天气), content(内容创作), calc(计算)\n\n任务：${taskDescription}`;

    const stepId = this.generateStepId();
    const startTime = Date.now();

    try {
      const result = await this.llm.chatWithJson<Partial<Intent>>(
        'Qwen/Qwen2.5-7B-Instruct',
        [{ role: 'user', content: prompt }],
        { intent: '', requiredQualification: '', complexity: '', priority: '' },
      );

      this.executionLog.push({
        stepId,
        stepType: 'llm_call',
        agent: 'Router',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        phase: 'intent_parsing',
        input: prompt,
        output: JSON.stringify(result.data, null, 2),
        tokens: result.usage.total_tokens,
        timestamp: Math.floor(startTime / 1000),
        duration: Date.now() - startTime,
      });

      const data = result.data;
      return {
        intent: data.intent || taskDescription,
        requiredQualification: toQualification(data.requiredQualification),
        complexity: data.complexity || 'medium',
        priority: data.priority || 'quality',
      };
    } catch (error) {
      // Fallback: 从任务文本推断资质类型
      const QUALIFICATION_KEYWORDS: Record<string, string[]> = {
        code_review: ['代码', '审查', 'review', 'bug', '安全', '漏洞', 'code', '安全漏洞', '代码质量'],
        data_analysis: ['数据', '分析', '统计', 'data', '分析报告', '趋势', '图表'],
        translation: ['翻译', 'translate', '中英', '英中', '多语言'],
        research: ['研究', '调研', '论文', '文献', 'report', '调查'],
        creative: ['创作', '写作', '文案', '故事', '诗歌', 'creative', '小说'],
        weather: ['天气', 'weather', '温度', '晴', '雨', '气候'],
        calc: ['计算', 'calc', '数学', '数字', '运算'],
      };

      let requiredQualification = 'content';
      for (const [qual, keywords] of Object.entries(QUALIFICATION_KEYWORDS)) {
        if (keywords.some((kw) => taskDescription.includes(kw))) {
          requiredQualification = qual;
          break;
        }
      }

      this.executionLog.push({
        stepId,
        stepType: 'llm_call',
        agent: 'Router',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        phase: 'intent_parsing',
        input: prompt,
        output: `Fallback: requiredQualification=${requiredQualification} (${error instanceof Error ? error.message : String(error)})`,
        tokens: 0,
        timestamp: Math.floor(startTime / 1000),
        duration: Date.now() - startTime,
      });

      return {
        intent: taskDescription,
        requiredQualification: toQualification(requiredQualification),
        complexity: 'simple',
        priority: 'quality',
      };
    }
  }

  /**
   * 步骤 2: 获取候选 Agent 列表（论文 fetchCandidates）
   */
  async getCandidateAgents(requiredQualification: string): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    const count = await this.contracts.agentDID.agentCount();

    for (let i = 0; i < Number(count); i++) {
      const addr = await this.contracts.agentDID.agentList(i);
      const agent = await this.contracts.agentDID.agents(addr);

      if (!agent.isActive) continue;

      const rep = await this.contracts.reputation.getReputation(addr);

      candidates.push({
        address: addr,
        did: agent.did,
        qualification: agent.qualificationType,
        avgRating: Number(rep.averageRating) || 0,
        ratingCount: Number(rep.ratingCount) || 0,
        isActive: agent.isActive,
        score: 0,
      });
    }

    // 优先返回匹配资质的 Agent；如果没有匹配的，返回全部
    const matched = candidates.filter((c) => c.qualification === requiredQualification);
    return matched.length > 0 ? matched : candidates;
  }

  /**
   * 步骤 3: LLM 评估候选 Agent（论文 evaluateCandidates，含 Fallback）
   */
  async evaluateCandidates(
    candidates: Candidate[],
    intent: Intent,
    requiredQualification: string,
  ): Promise<EvalResult> {
    // 精简候选信息
    const candidatesSummary = candidates
      .map(
        (c, i) =>
          `#${i + 1} ${c.did} | 资质:${c.qualification} | 信誉:${c.avgRating}/5 (${c.ratingCount}评)`,
      )
      .join('\n');

    const prompt = `任务: ${intent.intent}\n资质要求: ${requiredQualification}\n\nAgent列表:\n${candidatesSummary}\n\n评分规则（与论文公式 (3) 一致）: score = 0.6*q + 0.4*rNorm，q∈{60,40}（资质匹配 60，否则 40），rNorm = avgRating*0.4（百分制 0-100 → 0-40），满分 100。\n返回JSON: {"rankings":[{"index":0,"score":85,"reason":"..."}],"decision":"选择理由"}`;

    const stepId = this.generateStepId();
    const startTime = Date.now();

    try {
      const result = await this.llm.chatWithJson<{ rankings?: IntentRanking[]; decision?: string }>(
        'Qwen/Qwen2.5-7B-Instruct',
        [{ role: 'user', content: prompt }],
        { rankings: [], decision: '' },
      );

      this.executionLog.push({
        stepId,
        stepType: 'llm_call',
        agent: 'Router',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        phase: 'candidate_evaluation',
        input: prompt.substring(0, 300) + '...',
        output: JSON.stringify(result.data, null, 2),
        tokens: result.usage.total_tokens,
        timestamp: Math.floor(startTime / 1000),
        duration: Date.now() - startTime,
      });

      // 更新候选分数（LLM 返回分 clamp 到 [0,100]，防越界污染排序）
      if (result.data.rankings) {
        result.data.rankings.forEach((r) => {
          if (candidates[r.index]) {
            candidates[r.index].score = clampScore(r.score);
            candidates[r.index].reason = r.reason;
          }
        });
      }

      return { candidates, decision: result.data.decision || '' };
    } catch (error) {
      // Fallback: 规则匹配
      this.executionLog.push({
        stepId,
        stepType: 'llm_call',
        agent: 'Router',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        phase: 'candidate_evaluation',
        input: prompt.substring(0, 300) + '...',
        output: `Fallback to rule-based: ${error instanceof Error ? error.message : String(error)}`,
        tokens: 0,
        timestamp: Math.floor(startTime / 1000),
        duration: Date.now() - startTime,
      });

      // 规则评分（改造 A3 / P1-C4）：复用确定性纯函数 ruleScore，与论文公式 (3) 严格一致
      candidates.forEach((c) => {
        c.score = ruleScore(c, requiredQualification);
        c.reason = c.qualification === requiredQualification ? '资质完全匹配' : '资质部分匹配';
      });
      candidates.sort((a, b) => b.score - a.score);

      return {
        candidates,
        decision: `Fallback: 规则评分最高 ${candidates[0].did} (score=${candidates[0].score})`,
      };
    }
  }

  /**
   * 步骤 4: 做出最终决策（论文 selectBest）
   */
  async makeDecision(candidates: Candidate[], decision: string): Promise<RouteResult> {
    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates[0];

    this.executionLog.push({
      stepId: this.generateStepId(),
      stepType: 'decision',
      agent: 'Router',
      phase: 'final_decision',
      input: JSON.stringify({ candidateCount: candidates.length }),
      output: JSON.stringify(
        { selected: selected.did, address: selected.address, score: selected.score, reason: decision },
        null,
        2,
      ),
      timestamp: Math.floor(Date.now() / 1000),
    });

    return { agent: selected, reason: decision, executionLog: this.executionLog };
  }

  /**
   * 完整路由流程
   */
  async route(taskDescription: string): Promise<RouteResult> {
    this.executionLog = [];

    const intent = await this.parseIntent(taskDescription);
    const candidates = await this.getCandidateAgents(intent.requiredQualification);

    if (candidates.length === 0) {
      throw new Error('没有可用的候选 Agent');
    }

    const { candidates: ranked, decision } = await this.evaluateCandidates(
      candidates,
      intent,
      intent.requiredQualification,
    );

    return this.makeDecision(ranked, decision);
  }

  private generateStepId(): string {
    return `0x${Buffer.from(`${Date.now()}-${Math.random()}`).toString('hex').slice(0, 64)}`;
  }

  // ===== 改造 B4：论文 4 步管线别名 =====
  async fetchCandidates(requiredQualification: string): Promise<Candidate[]> {
    return this.getCandidateAgents(requiredQualification);
  }

  async selectBest(candidates: Candidate[], decision: string): Promise<RouteResult> {
    return this.makeDecision(candidates, decision);
  }
}
