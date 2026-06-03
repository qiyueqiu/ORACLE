/**
 * ASB Agent API 服务（M1 改造版）
 *
 * 集成：
 *  - dotenv 加载（消除硬编码密钥）
 *  - shared/abis.js 单一 ABI 来源
 *  - 路由签名（改造 1）：Router 决策后签名上链
 *  - Worker 签名（改造 2）：Worker 执行后签名上链
 *  - 任务 commit-reveal（改造 3）：前端传 commitmentHash
 *  - API 认证（N4）：x-api-key + Rate Limit
 *  - 路由决策日志统一处理
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { AgentDIDABI, AuditLogABI, ReputationABI } = require('../shared/abis');
const { RouterAgent } = require('./router-agent');
const { WorkerAgent, QUALIFICATION_CONFIG } = require('./worker-agents');
const { ReputationAnalyzerAgent, SCORING_DIMENSIONS } = require('./reputation-analyzer');

const app = express();
app.use(cors());
app.use(express.json());

// ===== 配置（全部从 env）=====
function required(name, fallback) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

const CONFIG = {
  PORT: Number(process.env.API_PORT || 3001),
  SILICONFLOW_API_KEY: required('SILICONFLOW_API_KEY'),
  PROVIDER_URL: required('PROVIDER_URL', 'http://localhost:8545'),
  CHAIN_ID: Number(required('EIP712_CHAIN_ID', '31337')),
  CONTRACT_ADDRESSES: {
    AgentDID: required('AGENT_DID_ADDRESS'),
    AuditLog: required('AUDIT_LOG_ADDRESS'),
    Reputation: required('REPUTATION_ADDRESS'),
  },
  ROUTER_SIGNER_PK: required('ROUTER_SIGNER_PRIVATE_KEY'),
  REPUTATION_SIGNER_PK: required('REPUTATION_SIGNER_PRIVATE_KEY'),
  WORKER_DEMO_PK: required('WORKER_DEMO_PRIVATE_KEY'),
  EIP712_DOMAIN_NAME: process.env.EIP712_DOMAIN_NAME || 'ASB Agent Bus',
  EIP712_DOMAIN_VERSION: process.env.EIP712_DOMAIN_VERSION || '1',
  ACCESS_KEYS: (process.env.API_ACCESS_KEYS || '').split(',').map(s => s.trim()).filter(Boolean),
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 60),
};

// ===== 签名者 & 合约实例 =====
const sharedProvider = new ethers.JsonRpcProvider(CONFIG.PROVIDER_URL);

// 路由器：决策后对 decisionDigest 签名
const routerSigner = new ethers.Wallet(CONFIG.ROUTER_SIGNER_PK, sharedProvider);
const routerWalletAddress = routerSigner.address;

// 信誉分析：评分后调用 rateWeighted / applyPenalty
const reputationSigner = new ethers.Wallet(CONFIG.REPUTATION_SIGNER_PK, sharedProvider);

// Worker 默认签名者（演示用，真实环境由每个 Agent 提供）
const workerDemoSigner = new ethers.Wallet(CONFIG.WORKER_DEMO_PK, sharedProvider);

// 审计合约（直接连 auditSigner）
const auditLogContract = new ethers.Contract(
  CONFIG.CONTRACT_ADDRESSES.AuditLog,
  AuditLogABI,
  routerSigner
);

// EIP-712 domain
const EIP712_DOMAIN = {
  name: CONFIG.EIP712_DOMAIN_NAME,
  version: CONFIG.EIP712_DOMAIN_VERSION,
  chainId: CONFIG.CHAIN_ID,
};

// 决策签名类型
const ROUTER_DECISION_TYPES = {
  Decision: [
    { name: 'taskHash', type: 'bytes32' },
    { name: 'rankedAgents', type: 'bytes32' },
    { name: 'topAgent', type: 'address' },
    { name: 'timestamp', type: 'uint256' },
  ],
};

const WORKER_RESULT_TYPES = {
  Result: [
    { name: 'recordId', type: 'uint256' },
    { name: 'resultDigest', type: 'bytes32' },
    { name: 'timestamp', type: 'uint256' },
  ],
};

// ===== API 认证 + Rate Limit =====
const inMemoryBuckets = new Map(); // ip -> [timestamps]
function apiAuth(req, res, next) {
  if (CONFIG.ACCESS_KEYS.length === 0) {
    // 未配置 API_ACCESS_KEYS：开发模式仅打 warning；生产必须配置
    return next();
  }
  const key = req.header('x-api-key');
  if (!key || !CONFIG.ACCESS_KEYS.includes(key)) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid x-api-key' });
  }
  next();
}

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const cutoff = now - CONFIG.RATE_LIMIT_WINDOW_MS;
  const bucket = (inMemoryBuckets.get(ip) || []).filter(t => t > cutoff);
  if (bucket.length >= CONFIG.RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests, please retry later' });
  }
  bucket.push(now);
  inMemoryBuckets.set(ip, bucket);
  next();
}

// 仅对 mutation API 强制认证 + 限流
app.use(['/api/dispatch', '/api/dispatch/stream', '/api/user-rating'], apiAuth, rateLimit);

// ===== Agents =====
const routerAgent = new RouterAgent(CONFIG.SILICONFLOW_API_KEY, CONFIG.PROVIDER_URL, CONFIG.CONTRACT_ADDRESSES);
const reputationAnalyzer = new ReputationAnalyzerAgent(CONFIG.SILICONFLOW_API_KEY, CONFIG.PROVIDER_URL, CONFIG.CONTRACT_ADDRESSES);
reputationAnalyzer.setSigner(new ethers.Wallet(CONFIG.REPUTATION_SIGNER_PK, sharedProvider));

const dispatchHistory = [];

// ===== Routes =====
app.get('/api/agent-types', (req, res) => {
  const types = Object.entries(QUALIFICATION_CONFIG).map(([key, config]) => ({
    key, name: config.name, icon: config.icon,
  }));
  res.json(types);
});

app.get('/api/scoring-dimensions', (req, res) => {
  res.json(SCORING_DIMENSIONS);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    chainId: CONFIG.CHAIN_ID,
    routerSigner: routerWalletAddress,
    apiAuthRequired: CONFIG.ACCESS_KEYS.length > 0,
  });
});

app.get('/api/dispatch/history', (req, res) => {
  res.json(dispatchHistory.slice(-50));
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

// ===== 主调度（流式） =====
app.post('/api/dispatch/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { task, taskCommitment, taskSalt } = req.body;
  if (!task || !task.trim()) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: '请输入任务描述' })}\n\n`);
    res.end();
    return;
  }

  const taskId = `task-${Date.now()}`;
  const sendEvent = (type, data) => {
    try { res.write(`event: ${type}\n`); res.write(`data: ${JSON.stringify({ ...data, taskId })}\n\n`); } catch {}
  };
  const safeEnd = () => { try { res.end(); } catch {} };

  let selected = null;
  let recordId = null;
  let taskHash = ethers.keccak256(ethers.toUtf8Bytes(task));
  // 改造 3：commitment 优先用前端提供的；否则从 task+timestamp 派生
  let finalCommitment = taskCommitment;
  if (!finalCommitment || finalCommitment === '0x' + '0'.repeat(64)) {
    finalCommitment = taskHash;  // 旧路径兜底
  }

  try {
    sendEvent('start', { message: '开始处理任务...', task, taskHash, taskCommitment: finalCommitment });

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
      detail: `识别到意图: ${intent.intent}, 所需资质: ${intent.requiredQualification}`,
    });

    // Phase 2: 候选 Agent
    sendEvent('phase', { phase: 'getting_candidates', message: '从链上获取候选 Agent...', icon: '🔍' });
    let candidates;
    try { candidates = await routerAgent.getCandidateAgents(intent.requiredQualification); }
    catch { candidates = []; }
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
      ranked.forEach((c) => { c.score = 50 + Math.random() * 30; c.reason = '规则评分'; });
      ranked.sort((a, b) => b.score - a.score);
      decision = 'LLM 不可用，使用规则匹配';
    }
    sendEvent('evaluated', {
      rankings: ranked.map(c => ({ did: c.did, address: c.address, score: c.score, reason: c.reason })),
      detail: decision,
    });

    // Phase 4: 决策 + 路由签名
    const routeResult = await routerAgent.makeDecision(ranked, decision);
    selected = routeResult.agent;
    const timestamp = Math.floor(Date.now() / 1000);
    const rankedAgentsHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]'],
        [ranked.map(c => c.address)]
      )
    );
    // EIP-712 签名决策
    const decisionValue = {
      taskHash: taskHash,
      rankedAgents: rankedAgentsHash,
      topAgent: selected.address,
      timestamp,
    };
    let decisionDigest, decisionSig;
    try {
      decisionDigest = ethers.TypedDataEncoder.hash(EIP712_DOMAIN, ROUTER_DECISION_TYPES, decisionValue);
      decisionSig = await routerSigner.signTypedData(EIP712_DOMAIN, ROUTER_DECISION_TYPES, decisionValue);
    } catch (sigErr) {
      sendEvent('error', { error: `路由签名失败: ${sigErr.message}` });
      safeEnd();
      return;
    }
    sendEvent('selected', {
      selected: {
        did: selected.did, address: selected.address,
        qualification: selected.qualification, score: selected.score, avgRating: selected.avgRating,
      },
      decision,
      routerSigner: routerWalletAddress,
      decisionDigest,
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

    // Phase 6: 链上记录（带签名）
    sendEvent('phase', { phase: 'logging', message: '记录审计日志到区块链...', icon: '⛓️' });
    try {
      // 6.1 写 logScheduleWithDecision
      const tx1 = await auditLogContract.logScheduleWithDecision(
        routerWalletAddress,  // requester = router signer
        selected.address,
        finalCommitment,
        0,  // QUALIFIED
        routerWalletAddress,
        decisionDigest,
        decisionSig
      );
      const r1 = await tx1.wait();
      recordId = Number(r1.logs[0].topics[1]);  // recordId 是 topic1

      // 6.2 写 updateExecutionWithSig（Worker 签名）
      const resultDigest = ethers.keccak256(ethers.toUtf8Bytes(executionResult.result));
      const workerSig = await workerDemoSigner.signTypedData(
        EIP712_DOMAIN, WORKER_RESULT_TYPES,
        { recordId, resultDigest, timestamp }
      );
      const tx2 = await auditLogContract.updateExecutionWithSig(
        recordId, 1, executionResult.result, resultDigest, workerSig
      );
      await tx2.wait();

      sendEvent('logged', { message: '审计日志已记录到区块链（含 Router + Worker 签名）', recordId, txHash: r1.hash });
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
          totalScore: a.totalScore, quality: a.quality, taskCompleted: a.taskCompleted,
          summary: a.summary, dimensions: a.dimensions,
          strengths: a.strengths, weaknesses: a.weaknesses, suggestions: a.suggestions,
        },
        ratingOnChain: reputationAnalysis.ratingResult.success,
        penaltyApplied: reputationAnalysis.penaltyResult?.success || false,
        detail: `信誉评分: ${a.totalScore}/100, 质量: ${a.quality}`,
      });
    } catch (err) {
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
      recordId,
      taskCommitment: finalCommitment,
    });

    dispatchHistory.push({
      taskId, task,
      selectedAgent: selected ? { did: selected.did, address: selected.address, qualification: selected.qualification } : null,
      result: executionResult.result,
      tokens: executionResult.tokens,
      reputationScore: reputationAnalysis?.analysis?.totalScore || null,
      recordId,
      timestamp: Date.now(),
    });
  } catch (error) {
    sendEvent('error', { error: `任务处理出现异常，请稍后重试。详情: ${error.message}` });
  }
  safeEnd();
});

// ===== 阻塞式调度 =====
app.post('/api/dispatch', async (req, res) => {
  const { task, taskCommitment } = req.body;
  if (!task) return res.status(400).json({ error: '任务描述不能为空' });
  const taskId = `task-${Date.now()}`;
  try {
    const routingResult = await routerAgent.route(task);
    const workerAgent = new WorkerAgent(CONFIG.SILICONFLOW_API_KEY, routingResult.agent);
    const executionResult = await workerAgent.execute(task, {
      selectedAgent: routingResult.agent.did,
      reputation: routingResult.agent.avgRating,
    });
    // 阻塞模式也走签名路径
    const taskHash = ethers.keccak256(ethers.toUtf8Bytes(task));
    const commitment = taskCommitment && taskCommitment !== '0x' + '0'.repeat(64)
      ? taskCommitment : taskHash;
    const rankedAgentsHash = ethers.keccak256(ethers.toUtf8Bytes('rank-' + taskId));
    const timestamp = Math.floor(Date.now() / 1000);
    const decisionValue = { taskHash, rankedAgents: rankedAgentsHash, topAgent: routingResult.agent.address, timestamp };
    const decisionDigest = ethers.TypedDataEncoder.hash(EIP712_DOMAIN, ROUTER_DECISION_TYPES, decisionValue);
    const decisionSig = await routerSigner.signTypedData(EIP712_DOMAIN, ROUTER_DECISION_TYPES, decisionValue);
    const tx1 = await auditLogContract.logScheduleWithDecision(
      routerWalletAddress, routingResult.agent.address, commitment, 0,
      routerWalletAddress, decisionDigest, decisionSig
    );
    const r1 = await tx1.wait();
    const recordId = Number(r1.logs[0].topics[1]);
    const resultDigest = ethers.keccak256(ethers.toUtf8Bytes(executionResult.result));
    const workerSig = await workerDemoSigner.signTypedData(
      EIP712_DOMAIN, WORKER_RESULT_TYPES,
      { recordId, resultDigest, timestamp }
    );
    const tx2 = await auditLogContract.updateExecutionWithSig(recordId, 1, executionResult.result, resultDigest, workerSig);
    await tx2.wait();

    res.json({
      success: true, taskId, task,
      selectedAgent: {
        did: routingResult.agent.did, address: routingResult.agent.address,
        qualification: routingResult.agent.qualification, reputation: routingResult.agent.avgRating,
      },
      decisionReason: routingResult.reason,
      result: executionResult.result,
      chainOfThought: executionResult.chainOfThought,
      executionLog: [...(routingResult.executionLog || []), ...executionResult.executionLog],
      tokensUsed: executionResult.tokens,
      recordId,
      taskCommitment: commitment,
      routerSigner: routerWalletAddress,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, taskId });
  }
});

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
  console.log(`🔐 API 认证: ${CONFIG.ACCESS_KEYS.length > 0 ? '已启用' : '未启用（生产必须设置 API_ACCESS_KEYS）'}`);
  console.log(`🛡️  Rate Limit: ${CONFIG.RATE_LIMIT_MAX} req / ${CONFIG.RATE_LIMIT_WINDOW_MS}ms`);
  console.log(`🔑 Router Signer: ${routerWalletAddress}`);
});

module.exports = app;
