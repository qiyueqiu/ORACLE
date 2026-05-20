/**
 * ASB Agent API 服务
 * 连接 LLM Router/Worker Agent 和前端
 */

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { RouterAgent } = require('./router-agent');
const { WorkerAgent } = require('./worker-agent');

const app = express();
app.use(cors());
app.use(express.json());

// 配置
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

// 初始化 Router Agent
const routerAgent = new RouterAgent(
  CONFIG.SILICONFLOW_API_KEY,
  CONFIG.PROVIDER_URL,
  CONFIG.CONTRACT_ADDRESSES
);

// 存储正在执行的任务
const activeTasks = new Map();

/**
 * POST /api/dispatch - 路由任务并执行
 */
app.post('/api/dispatch', async (req, res) => {
  const { task } = req.body;

  if (!task) {
    return res.status(400).json({ error: '任务描述不能为空' });
  }

  const taskId = `task-${Date.now()}`;
  console.log(`[${taskId}] 收到任务: ${task}`);

  try {
    // 步骤 1: Router 路由决策
    console.log(`[${taskId}] 开始路由决策...`);
    const routingResult = await routerAgent.route(task);

    console.log(`[${taskId}] 路由完成，选中: ${routingResult.agent.did}`);

    // 步骤 2: Worker 执行任务
    console.log(`[${taskId}] 开始执行任务...`);
    const workerAgent = new WorkerAgent(
      CONFIG.SILICONFLOW_API_KEY,
      routingResult.agent
    );

    const executionResult = await workerAgent.execute(task, {
      selectedAgent: routingResult.agent.did,
      reputation: routingResult.agent.avgRating,
    });

    // 步骤 3: 记录到审计日志（区块链）
    await logToAuditLog(task, routingResult, executionResult);

    // 合并执行日志
    const fullExecutionLog = [
      ...routingResult.executionLog,
      ...executionResult.executionLog,
    ];

    res.json({
      success: true,
      taskId,
      task,
      selectedAgent: {
        did: routingResult.agent.did,
        address: routingResult.agent.address,
        qualification: routingResult.agent.qualification,
        reputation: routingResult.agent.avgRating,
      },
      decisionReason: routingResult.reason,
      result: executionResult.result,
      chainOfThought: executionResult.chainOfThought,
      executionLog: fullExecutionLog,
      tokensUsed: executionResult.tokens,
    });

    console.log(`[${taskId}] 任务完成`);
  } catch (error) {
    console.error(`[${taskId}] 错误:`, error.message);
    res.status(500).json({
      error: error.message,
      taskId,
    });
  }
});

/**
 * POST /api/dispatch/stream - 流式执行（实时推送进度）
 */
app.post('/api/dispatch/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { task } = req.body;
  const taskId = `task-${Date.now()}`;

  const sendEvent = (type, data) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify({ ...data, taskId })}\n\n`);
  };

  try {
    sendEvent('start', { message: '开始处理任务...', task });

    // 1. 意图解析
    sendEvent('phase', { phase: 'intent_parsing', message: '正在解析任务意图...' });
    const intent = await routerAgent.parseIntent(task);
    sendEvent('intent_parsed', { intent });

    // 2. 获取候选
    sendEvent('phase', { phase: 'getting_candidates', message: '获取候选 Agent...' });
    const candidates = await routerAgent.getCandidateAgents(intent.requiredQualification);
    sendEvent('candidates', { candidates: candidates.map(c => ({
      did: c.did,
      qualification: c.qualification,
      avgRating: c.avgRating,
      ratingCount: c.ratingCount,
    })) });

    // 3. 评估候选
    sendEvent('phase', { phase: 'evaluating', message: 'LLM 正在评估候选 Agent...' });
    const { candidates: ranked, decision } = await routerAgent.evaluateCandidates(
      candidates,
      intent,
      intent.requiredQualification
    );
    sendEvent('evaluated', { rankings: ranked.map(c => ({ did: c.did, score: c.score })) });

    // 4. 决策
    const { agent: selected } = await routerAgent.makeDecision(ranked, decision);
    sendEvent('selected', {
      selected: {
        did: selected.did,
        qualification: selected.qualification,
        score: selected.score
      },
      decision
    });

    // 5. 执行
    sendEvent('phase', { phase: 'executing', message: 'Worker Agent 正在执行任务...' });
    const workerAgent = new WorkerAgent(CONFIG.SILICONFLOW_API_KEY, selected);

    // 模拟流式思考过程
    sendEvent('thinking', { message: '正在思考...' });
    const executionResult = await workerAgent.execute(task, {
      selectedAgent: selected.did,
      reputation: selected.avgRating,
    });

    sendEvent('chain_of_thought', { chainOfThought: executionResult.chainOfThought });
    sendEvent('complete', {
      result: executionResult.result,
      tokensUsed: executionResult.tokens,
    });

    // 记录到链上
    await logToAuditLog(task, { agent: selected, reason: decision }, executionResult);

  } catch (error) {
    sendEvent('error', { error: error.message });
  }

  res.end();
});

/**
 * 辅助函数：记录到审计日志合约
 */
async function logToAuditLog(task, routingResult, executionResult) {
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.PROVIDER_URL);
    const signer = await provider.getSigner();

    const auditLog = new ethers.Contract(
      CONFIG.CONTRACT_ADDRESSES.AuditLog,
      [
        'function logSchedule(address requester, address targetAgent, string calldata taskDescription, uint8 decisionReason) external returns (uint256)',
        'function updateExecution(uint256 recordId, uint8 status, string calldata result) external',
        'function recordCount() external view returns (uint256)',
      ],
      signer
    );

    const countBefore = await auditLog.recordCount();

    const tx = await auditLog.logSchedule(
      await signer.getAddress(),
      routingResult.agent.address,
      task,
      0
    );
    await tx.wait();

    const recordId = Number(countBefore) + 1;

    const resultText = `${routingResult.reason}\n\n执行结果:\n${executionResult.result}`;
    await auditLog.updateExecution(recordId, 1, resultText);

    console.log(`审计日志已记录，recordId: ${recordId}`);
  } catch (error) {
    console.error('记录审计日志失败:', error.message);
  }
}

/**
 * GET /api/health - 健康检查
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// 启动服务
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 ASB Agent API 服务运行在 http://localhost:${CONFIG.PORT}`);
  console.log(`📡 API 端点:`);
  console.log(`   POST /api/dispatch - 路由并执行任务`);
  console.log(`   POST /api/dispatch/stream - 流式执行`);
  console.log(`   GET  /api/health - 健康检查`);
});

module.exports = app;
