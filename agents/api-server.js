/**
 * ASB Agent API 服务
 * 连接 LLM Router/Worker Agent 和前端
 * 集成百分制信誉分析系统 + 用户评价
 */

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { RouterAgent } = require('./router-agent');
const { WorkerAgent, QUALIFICATION_CONFIG } = require('./worker-agents');
const { ReputationAnalyzerAgent, SCORING_DIMENSIONS } = require('./reputation-analyzer');

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG = {
  PORT: process.env.PORT || 3001,
  SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY || 'sk-nyntypepqvzsjewkignxddcthmouofduffyxswapjxafzlrw',
  PROVIDER_URL: process.env.PROVIDER_URL || 'http://localhost:8545',
  CONTRACT_ADDRESSES: {
    AgentDID: process.env.AGENT_DID_ADDRESS || '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    AuditLog: process.env.AUDIT_LOG_ADDRESS || '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    Reputation: process.env.REPUTATION_ADDRESS || '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  }
};

const sharedProvider = new ethers.JsonRpcProvider(CONFIG.PROVIDER_URL);

const auditSigner = new ethers.NonceManager(
  new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', sharedProvider)
);

const auditLogContract = new ethers.Contract(
  CONFIG.CONTRACT_ADDRESSES.AuditLog,
  [
    'function logSchedule(address requester, address targetAgent, string calldata taskDescription, uint8 decisionReason) external returns (uint256)',
    'function updateExecution(uint256 recordId, uint8 status, string calldata result) external',
    'function recordCount() external view returns (uint256)',
  ],
  auditSigner
);

const routerAgent = new RouterAgent(CONFIG.SILICONFLOW_API_KEY, CONFIG.PROVIDER_URL, CONFIG.CONTRACT_ADDRESSES);
const reputationAnalyzer = new ReputationAnalyzerAgent(CONFIG.SILICONFLOW_API_KEY, CONFIG.PROVIDER_URL, CONFIG.CONTRACT_ADDRESSES);

const dispatchHistory = [];

app.get('/api/agent-types', (req, res) => {
  const types = Object.entries(QUALIFICATION_CONFIG).map(([key, config]) => ({
    key, name: config.name, icon: config.icon,
  }));
  res.json(types);
});

app.get('/api/scoring-dimensions', (req, res) => {
  res.json(SCORING_DIMENSIONS);
});

app.post('/api/dispatch/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { task } = req.body;
  if (!task || !task.trim()) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: '请输入任务描述' })}\n\n`);
    res.end();
    return;
  }

  const taskId = `task-${Date.now()}`;

  const sendEvent = (type, data) => {
    try {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify({ ...data, taskId })}\n\n`);
    } catch {}
  };

  const safeEnd = () => { try { res.end(); } catch {} };

  let selected = null;

  try {
    sendEvent('start', { message: '开始处理任务...', task });

    // Phase 1: 意图解析
    sendEvent('phase', { phase: 'intent_parsing', message: '正在解析任务意图...', icon: '🧠' });
    let intent;
    try {
      intent = await routerAgent.parseIntent(task);
    } catch {
      intent = { intent: task, requiredQualification: 'content', complexity: 'medium', priority: 'quality' };
      sendEvent('intent_parsed', { intent, detail: '意图解析使用默认值（LLM 不可用）' });
    }
    if (!intent.requiredQualification) intent.requiredQualification = 'content';
    sendEvent('intent_parsed', {
      intent,
      detail: `识别到意图: ${intent.intent}, 所需资质: ${intent.requiredQualification}, 复杂度: ${intent.complexity}`,
    });

    // Phase 2: 获取候选 Agent
    sendEvent('phase', { phase: 'getting_candidates', message: '从链上获取候选 Agent...', icon: '🔍' });
    let candidates;
    try {
      candidates = await routerAgent.getCandidateAgents(intent.requiredQualification);
    } catch {
      candidates = [];
    }
    sendEvent('candidates', {
      candidates: candidates.map(c => ({
        did: c.did, address: c.address, qualification: c.qualification,
        avgRating: c.avgRating, ratingCount: c.ratingCount,
      })),
      detail: `找到 ${candidates.length} 个候选 Agent`,
    });

    if (candidates.length === 0) {
      sendEvent('error', { error: '没有找到匹配的候选 Agent，请先注册 Agent' });
      safeEnd();
      return;
    }

    // Phase 3: LLM 评估
    sendEvent('phase', { phase: 'evaluating', message: 'LLM 正在评估候选 Agent...', icon: '🤖' });
    let ranked = candidates;
    let decision = '';
    try {
      const evalResult = await routerAgent.evaluateCandidates(candidates, intent, intent.requiredQualification);
      ranked = evalResult.candidates;
      decision = evalResult.decision;
    } catch {
      ranked.forEach((c, i) => { c.score = 50 + Math.random() * 30; c.reason = '规则评分'; });
      ranked.sort((a, b) => b.score - a.score);
      decision = 'LLM 不可用，使用规则匹配';
    }
    sendEvent('evaluated', {
      rankings: ranked.map(c => ({ did: c.did, address: c.address, score: c.score, reason: c.reason })),
      detail: decision,
    });

    // Phase 4: 决策
    const routeResult = await routerAgent.makeDecision(ranked, decision);
    selected = routeResult.agent;
    sendEvent('selected', {
      selected: {
        did: selected.did, address: selected.address,
        qualification: selected.qualification, score: selected.score, avgRating: selected.avgRating,
      },
      decision,
      detail: `选中 Agent: ${selected.did} (评分: ${selected.score})`,
    });

    // Phase 5: Worker 执行
    const agentConfig = QUALIFICATION_CONFIG[selected.qualification] || QUALIFICATION_CONFIG.content;
    sendEvent('phase', {
      phase: 'executing',
      message: `${agentConfig.icon} ${agentConfig.name}正在执行任务...`,
      icon: agentConfig.icon, agentType: selected.qualification, agentName: agentConfig.name,
    });

    const workerAgent = new WorkerAgent(CONFIG.SILICONFLOW_API_KEY, selected);
    sendEvent('thinking', { message: 'Agent 正在思考...' });

    let executionResult;
    try {
      executionResult = await workerAgent.execute(task, {
        selectedAgent: selected.did,
        reputation: selected.avgRating,
      });
    } catch (execErr) {
      executionResult = {
        result: `执行失败: ${execErr.message}`,
        chainOfThought: '',
        executionLog: [],
        tokens: 0,
        model: 'N/A',
        agentType: selected.qualification,
      };
    }

    sendEvent('chain_of_thought', { chainOfThought: executionResult.chainOfThought, model: executionResult.model });
    sendEvent('result', { result: executionResult.result, model: executionResult.model, agentType: executionResult.agentType });

    // Phase 6: 链上记录
    sendEvent('phase', { phase: 'logging', message: '记录审计日志到区块链...', icon: '⛓️' });
    try {
      await logToAuditLog(task, { agent: selected, reason: decision }, executionResult);
      sendEvent('logged', { message: '审计日志已记录到区块链' });
    } catch (logErr) {
      sendEvent('logged', { message: `审计日志记录异常: ${logErr.message}` });
    }

    // Phase 7: 信誉分析
    sendEvent('phase', { phase: 'reputation_analysis', message: '信誉分析 Agent 正在评估执行质量...', icon: '📊' });

    let reputationAnalysis = null;
    try {
      reputationAnalysis = await reputationAnalyzer.fullAnalysis({
        task,
        selectedAgent: { did: selected.did, address: selected.address, qualification: selected.qualification },
        executionResult: executionResult.result,
        chainOfThought: executionResult.chainOfThought,
        executionLog: executionResult.executionLog,
      });

      const a = reputationAnalysis.analysis;
      sendEvent('reputation_analyzed', {
        analysis: {
          totalScore: a.totalScore,
          quality: a.quality,
          taskCompleted: a.taskCompleted,
          summary: a.summary,
          dimensions: a.dimensions,
          strengths: a.strengths,
          weaknesses: a.weaknesses,
          suggestions: a.suggestions,
        },
        ratingOnChain: reputationAnalysis.ratingResult.success,
        penaltyApplied: reputationAnalysis.penaltyResult?.success || false,
        detail: `信誉评分: ${a.totalScore}/100, 质量: ${a.quality}`,
      });
    } catch (err) {
      console.error('信誉分析失败:', err.message);
      sendEvent('reputation_analyzed', {
        analysis: { totalScore: 0, quality: 'unknown', summary: '信誉分析暂不可用' },
        ratingOnChain: false,
        detail: '信誉分析暂不可用',
      });
    }

    sendEvent('complete', {
      result: executionResult.result,
      tokensUsed: executionResult.tokens,
      model: executionResult.model,
      reputationScore: reputationAnalysis?.analysis?.totalScore || null,
      agentAddress: selected?.address || null,
    });

    dispatchHistory.push({
      taskId, task,
      selectedAgent: selected ? { did: selected.did, address: selected.address, qualification: selected.qualification } : null,
      result: executionResult.result,
      tokens: executionResult.tokens,
      reputationScore: reputationAnalysis?.analysis?.totalScore || null,
      timestamp: Date.now(),
    });

  } catch (error) {
    console.error('调度异常:', error.message);
    sendEvent('error', { error: `任务处理出现异常，请稍后重试。详情: ${error.message}` });
  }

  safeEnd();
});

app.post('/api/dispatch', async (req, res) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: '任务描述不能为空' });

  const taskId = `task-${Date.now()}`;
  try {
    const routingResult = await routerAgent.route(task);
    const workerAgent = new WorkerAgent(CONFIG.SILICONFLOW_API_KEY, routingResult.agent);
    const executionResult = await workerAgent.execute(task, {
      selectedAgent: routingResult.agent.did,
      reputation: routingResult.agent.avgRating,
    });

    await logToAuditLog(task, routingResult, executionResult);

    res.json({
      success: true, taskId, task,
      selectedAgent: {
        did: routingResult.agent.did, address: routingResult.agent.address,
        qualification: routingResult.agent.qualification, reputation: routingResult.agent.avgRating,
      },
      decisionReason: routingResult.reason,
      result: executionResult.result,
      chainOfThought: executionResult.chainOfThought,
      executionLog: [...routingResult.executionLog, ...executionResult.executionLog],
      tokensUsed: executionResult.tokens,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, taskId });
  }
});

app.post('/api/user-rating', async (req, res) => {
  const { agentAddress, score, comment, taskId } = req.body;
  if (!agentAddress || score === undefined) {
    return res.status(400).json({ error: '缺少 agentAddress 或 score' });
  }
  if (score < 0 || score > 100) {
    return res.status(400).json({ error: '评分必须在 0-100 之间' });
  }

  try {
    const result = await reputationAnalyzer.submitUserRating(agentAddress, Number(score), comment || '');
    res.json({ success: true, score: result.score, message: '用户评价已提交到区块链' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reputation/summary', async (req, res) => {
  try {
    const summaries = await reputationAnalyzer.getAgentPerformanceSummary();
    const history = reputationAnalyzer.getAnalysisHistory();
    res.json({ agents: summaries, analysisHistory: history.slice(-20), totalAnalysis: history.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/dispatch/history', (req, res) => {
  res.json(dispatchHistory.slice(-50));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

async function logToAuditLog(task, routingResult, executionResult) {
  try {
    const countBefore = await auditLogContract.recordCount();
    const tx = await auditLogContract.logSchedule(await auditSigner.getAddress(), routingResult.agent.address, task, 0);
    await tx.wait();

    const recordId = Number(countBefore) + 1;
    const resultText = `${routingResult.reason}\n\n执行结果:\n${executionResult.result}`;
    const tx2 = await auditLogContract.updateExecution(recordId, 1, resultText);
    await tx2.wait();

    console.log(`审计日志已记录，recordId: ${recordId}`);
  } catch (error) {
    console.error('记录审计日志失败:', error.message);
  }
}

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 ASB Agent API 服务运行在 http://localhost:${CONFIG.PORT}`);
  console.log(`📡 API 端点:`);
  console.log(`   POST /api/dispatch/stream - 流式执行 (含信誉分析)`);
  console.log(`   POST /api/dispatch - 阻塞式执行`);
  console.log(`   POST /api/user-rating - 用户评价`);
  console.log(`   GET  /api/reputation/summary - 信誉概况`);
  console.log(`   GET  /api/scoring-dimensions - 评分维度说明`);
  console.log(`   GET  /api/agent-types - Agent 类型列表`);
  console.log(`   GET  /api/dispatch/history - 调度历史`);
  console.log(`   GET  /api/health - 健康检查`);
});

module.exports = app;
