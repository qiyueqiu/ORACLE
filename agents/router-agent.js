/**
 * Router Agent - LLM 驱动的任务路由器
 * 负责意图解析、候选 Agent 评估、决策
 */

const { ethers } = require('ethers');
const { SiliconFlowClient } = require('./siliconflow-client');
const { AgentDIDABI, ReputationABI } = require('../shared/abis');

class RouterAgent {
  constructor(apiKey, providerUrl, contractAddresses, siliconflowClient) {
    this.llm = siliconflowClient || new SiliconFlowClient(apiKey);
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.contracts = {
      agentDID: new ethers.Contract(contractAddresses.AgentDID, AgentDIDABI, this.provider),
      reputation: new ethers.Contract(contractAddresses.Reputation, ReputationABI, this.provider),
    };
    this.executionLog = [];
  }

  /**
   * 步骤 1: 意图解析（论文 parseIntent）
   */
  async parseIntent(taskDescription) {
    const prompt = `分析任务，返回JSON：{"intent":"意图","requiredQualification":"code_review/data_analysis/translation/research/creative/weather/content/calc","complexity":"simple/medium/complex","priority":"speed/quality/balance"}\n\n可用Agent类型: code_review(代码审查), data_analysis(数据分析), translation(翻译), research(研究), creative(创意写作), weather(天气), content(内容创作), calc(计算)\n\n任务：${taskDescription}`;

    const stepId = this.generateStepId();
    const startTime = Date.now();

    try {
      const result = await this.llm.chatWithJson(
        'Qwen/Qwen2.5-7B-Instruct',
        [{ role: 'user', content: prompt }],
        { intent: '', requiredQualification: '', complexity: '', priority: '' }
      );

      const logEntry = {
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
      };

      this.executionLog.push(logEntry);
      return result.data;
    } catch (error) {
      // Fallback: 从任务文本推断资质类型
      const QUALIFICATION_KEYWORDS = {
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
        if (keywords.some(kw => taskDescription.includes(kw))) {
          requiredQualification = qual;
          break;
        }
      }

      const logEntry = {
        stepId,
        stepType: 'llm_call',
        agent: 'Router',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        phase: 'intent_parsing',
        input: prompt,
        output: `Fallback: requiredQualification=${requiredQualification}`,
        tokens: 0,
        timestamp: Math.floor(startTime / 1000),
        duration: Date.now() - startTime,
      };
      this.executionLog.push(logEntry);

      return {
        intent: taskDescription,
        requiredQualification,
        complexity: 'simple',
        priority: 'quality'
      };
    }
  }

  /**
   * 步骤 2: 获取候选 Agent 列表（论文 fetchCandidates）
   */
  async getCandidateAgents(requiredQualification) {
    const candidates = [];
    const count = await this.contracts.agentDID.agentCount();

    for (let i = 0; i < Number(count); i++) {
      const addr = await this.contracts.agentDID.agentList(i);
      const agent = await this.contracts.agentDID.agents(addr);

      if (!agent[4]) continue;

      const rep = await this.contracts.reputation.getReputation(addr);
      const avgRating = Number(rep[2]) || 0;
      const ratingCount = Number(rep[1]) || 0;

      candidates.push({
        address: addr,
        did: agent[1],
        qualification: agent[3],
        avgRating,
        ratingCount,
        isActive: agent[4],
        score: 0,
      });
    }

    // 优先返回匹配资质的 Agent；如果没有匹配的，返回全部
    const matched = candidates.filter(c => c.qualification === requiredQualification);
    return matched.length > 0 ? matched : candidates;
  }

  /**
   * 步骤 3: LLM 评估候选 Agent（论文 evaluateCandidates，含 Fallback）
   */
  async evaluateCandidates(candidates, intent, requiredQualification) {
    // 精简候选信息
    const candidatesSummary = candidates.map((c, i) =>
      `#${i + 1} ${c.did} | 资质:${c.qualification} | 信誉:${c.avgRating}/5 (${c.ratingCount}评)`
    ).join('\n');

    const prompt = `任务: ${intent.intent}\n资质要求: ${requiredQualification}\n\nAgent列表:\n${candidatesSummary}\n\n评分规则（与论文公式 (3) 一致）: score = 0.6*q + 0.4*r_norm，q∈{60,40}（资质匹配 60，否则 40），r_norm = avgRating*8（0-5 → 0-40），满分 100。\n返回JSON: {"rankings":[{"index":0,"score":85,"reason":"..."}],"decision":"选择理由"}`;

    const stepId = this.generateStepId();
    const startTime = Date.now();

    try {
      const result = await this.llm.chatWithJson(
        'Qwen/Qwen2.5-7B-Instruct',
        [{ role: 'user', content: prompt }],
        { rankings: [], decision: '' }
      );

      const logEntry = {
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
      };

      this.executionLog.push(logEntry);

      // 更新候选分数
      if (result.data.rankings) {
        result.data.rankings.forEach(r => {
          if (candidates[r.index]) {
            candidates[r.index].score = r.score;
            candidates[r.index].reason = r.reason;
          }
        });
      }

      return { candidates, decision: result.data.decision || '' };
    } catch (error) {
      // Fallback: 规则匹配
      const logEntry = {
        stepId,
        stepType: 'llm_call',
        agent: 'Router',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        phase: 'candidate_evaluation',
        input: prompt.substring(0, 300) + '...',
        output: `Fallback to rule-based: ${error.message}`,
        tokens: 0,
        timestamp: Math.floor(startTime / 1000),
        duration: Date.now() - startTime,
      };
      this.executionLog.push(logEntry);

      // 规则评分（改造 A3）：与论文公式 (3) 严格一致
      // score = 0.6 * q + 0.4 * r_norm，其中 q ∈ {60, 40}，r_norm = avgRating * 8（0-5 星 → 0-40）
      // 满分 100。LLM 路径与 Fallback 路径共享同一线性权重函数。
      candidates.forEach((c, i) => {
        const q = c.qualification === requiredQualification ? 60 : 40;
        const rNorm = c.avgRating * 8;
        c.score = 0.6 * q + 0.4 * rNorm;
        c.reason = c.qualification === requiredQualification ? '资质完全匹配' : '资质部分匹配';
      });
      candidates.sort((a, b) => b.score - a.score);

      return { candidates, decision: `Fallback: 规则评分最高 ${candidates[0].did} (score=${candidates[0].score})` };
    }
  }

  /**
   * 步骤 4: 做出最终决策（论文 selectBest）
   */
  async makeDecision(candidates, decision) {
    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates[0];

    const logEntry = {
      stepId: this.generateStepId(),
      stepType: 'decision',
      agent: 'Router',
      phase: 'final_decision',
      input: JSON.stringify({ candidateCount: candidates.length }),
      output: JSON.stringify({
        selected: selected.did,
        address: selected.address,
        score: selected.score,
        reason: decision,
      }, null, 2),
      timestamp: Math.floor(Date.now() / 1000),
    };

    this.executionLog.push(logEntry);

    return {
      agent: selected,
      reason: decision,
      executionLog: this.executionLog,
    };
  }

  /**
   * 完整路由流程
   */
  async route(taskDescription) {
    this.executionLog = [];

    // 1. 意图解析
    const intent = await this.parseIntent(taskDescription);

    // 2. 获取候选
    const candidates = await this.getCandidateAgents(intent.requiredQualification);

    if (candidates.length === 0) {
      throw new Error('没有可用的候选 Agent');
    }

    // 3. 评估候选
    const { candidates: ranked, decision } = await this.evaluateCandidates(
      candidates,
      intent,
      intent.requiredQualification
    );

    // 4. 最终决策
    const result = await this.makeDecision(ranked, decision);

    return result;
  }

  generateStepId() {
    return `0x${Buffer.from(`${Date.now()}-${Math.random()}`).toString('hex').slice(0, 64)}`;
  }

  // ===== 改造 B4：论文 4 步管线别名 =====
  // 论文（第 3.3 节）使用 parseIntent / fetchCandidates / evaluateCandidates / selectBest
  // 代码历史上使用 parseIntent / getCandidateAgents / evaluateCandidates / makeDecision
  // 为了让代码与论文一一对应，同时不破坏现有测试，下面提供论文同名别名。
  async fetchCandidates(requiredQualification) {
    return this.getCandidateAgents(requiredQualification);
  }

  async selectBest(candidates, decision) {
    return this.makeDecision(candidates, decision);
  }
}

module.exports = { RouterAgent };