/**
 * ORACLE Agent API 服务（ESM + TypeScript 版）
 *
 * 集成：
 *  - dotenv 加载（消除硬编码密钥）
 *  - TypeChain 生成的类型化合约接口（单一 ABI 来源）
 *  - 路由签名（改造 1）：Router 决策后签名上链
 *  - Worker 签名（改造 2）：Worker 执行后签名上链
 *  - 任务 commit-reveal（改造 3）：前端传 commitmentHash
 *  - API 认证（N4）：x-api-key + Rate Limit
 */

import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import { RouterAgent, ruleScore } from './router-agent.js';
import { WorkerAgent, QUALIFICATION_CONFIG } from './worker-agents.js';
import { ReputationAnalyzerAgent, SCORING_DIMENSIONS } from './reputation-analyzer.js';
import { makeWorkerSigningProvider } from './worker-signing.js';
import { makeAuditAdapter } from './audit-adapter.js';
import { makeApiAuth, makeRateLimit, sendError } from './security.js';
import type { AppConfig, Intent, Candidate, ExecutionResult, SSEEventData } from './types.js';
import { toQualification } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const app = express();
app.use(cors());
app.use(express.json());

// ===== 配置（全部从 env）=====
function required(name: string, fallback?: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

const CONFIG: AppConfig = {
  PORT: Number(process.env.API_PORT || 3001),
  SILICONFLOW_API_KEY: required('SILICONFLOW_API_KEY'),
  PROVIDER_URL: required('PROVIDER_URL', 'http://localhost:8545'),
  CHAIN_ID: Number(required('EIP712_CHAIN_ID', '31337')),
  CONTRACT_ADDRESSES: {
    AgentDID: required('AGENT_DID_ADDRESS'),
    AuditLog: required('AUDIT_LOG_ADDRESS'),
    Reputation: required('REPUTATION_ADDRESS'),
    AuditLogOptimized: process.env.AUDIT_LOG_OPTIMIZED_ADDRESS || undefined,
  },
  // 审计写入模式：full（原版，默认）| optimized（M5 编码，省 ~79% gas）
  AUDIT_MODE: (process.env.AUDIT_MODE === 'optimized' ? 'optimized' : 'full') as 'full' | 'optimized',
  ROUTER_SIGNER_PK: required('ROUTER_SIGNER_KEY', process.env.ROUTER_SIGNER_PRIVATE_KEY),
  REPUTATION_SIGNER_PK: required('REPUTATION_SIGNER_PRIVATE_KEY'),
  // P2：worker 不再由单一密钥代签；模式 demo（助记词派生）| relay（转发预签名）
  WORKER_SIGNING_MODE: (process.env.WORKER_SIGNING_MODE === 'relay' ? 'relay' : 'demo') as
    | 'demo'
    | 'relay',
  WORKER_DEMO_MNEMONIC:
    process.env.WORKER_DEMO_MNEMONIC || 'test test test test test test test test test test test junk',
  EIP712_DOMAIN_NAME: process.env.EIP712_DOMAIN_NAME || 'ORACLE Agent Bus',
  EIP712_DOMAIN_VERSION: process.env.EIP712_DOMAIN_VERSION || '1',
  ACCESS_KEYS: (process.env.API_ACCESS_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 60),
};

// SSE 任务超时（ms）
const SSE_TASK_TIMEOUT_MS = Number(process.env.SSE_TASK_TIMEOUT_MS || 120000);

// ===== 签名者 & 合约实例 =====
const sharedProvider = new ethers.JsonRpcProvider(CONFIG.PROVIDER_URL);
const routerSigner = new ethers.Wallet(CONFIG.ROUTER_SIGNER_PK, sharedProvider);
const routerWalletAddress = routerSigner.address;
// 审计合约发交易用 NonceManager 包装：每次 dispatch 连发 2 笔 tx（logSchedule + updateExecution），
// 并发/快速连续请求时裸 Wallet 会复用相同 nonce 导致 "Nonce too low" 全部失败。
// NonceManager 在本地维护递增 nonce，串行化 tx 提交。EIP-712 签名仍用裸 routerSigner（不涉 nonce）。
const routerTxSigner = new ethers.NonceManager(routerSigner);

// P2（修复 C1）：worker 不再由单一密钥代签。后端是无特权中继——按选中 agent 的地址
// 取「该 agent 自己的」签名器；demo 模式由助记词确定性派生，链上 pubKey 与之绑定，
// 后端无法用一把钥伪造任意 agent 的结果。
const workerSigning = makeWorkerSigningProvider(CONFIG.WORKER_SIGNING_MODE, {
  mnemonic: CONFIG.WORKER_DEMO_MNEMONIC,
});

// 审计合约（适配器层，按 AUDIT_MODE 选 full / optimized）
// full：原版 AuditLog（13 字段 SSTORE，可回读，~407k gas）
// optimized：AuditLogOptimized M5 编码（event-only，零锚点，~85k gas，省 ~79%）
const auditAdapter = makeAuditAdapter(
  CONFIG.AUDIT_MODE,
  {
    AuditLog: CONFIG.CONTRACT_ADDRESSES.AuditLog,
    AuditLogOptimized: CONFIG.CONTRACT_ADDRESSES.AuditLogOptimized,
  },
  routerTxSigner,
);
// EIP-712 verifyingContract 必须指向「实际写入的合约」，否则链上重建摘要与签名不匹配。
const auditVerifyingContract =
  CONFIG.AUDIT_MODE === 'optimized' && CONFIG.CONTRACT_ADDRESSES.AuditLogOptimized
    ? CONFIG.CONTRACT_ADDRESSES.AuditLogOptimized
    : CONFIG.CONTRACT_ADDRESSES.AuditLog;

// EIP-712 domain（P1-C2：必须与目标合约 domainSeparator() 完全一致）
// 合约固定 name="ORACLE AuditLog" / version="1"，并含 verifyingContract，
// 防止签名跨链（chainId）、跨合约（verifyingContract）重放。
const EIP712_DOMAIN = {
  name: 'ORACLE AuditLog',
  version: '1',
  chainId: CONFIG.CHAIN_ID,
  verifyingContract: auditVerifyingContract,
};

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

// ===== P6：鉴权 + 限流（从 security.ts） =====
const revokedKeys = (process.env.API_REVOKED_KEYS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const isDev = process.env.NODE_ENV === 'development';

const apiAuth = makeApiAuth({
  accessKeys: CONFIG.ACCESS_KEYS,
  revokedKeys,
  isDev,
});

const rateLimitMiddleware = makeRateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
  max: CONFIG.RATE_LIMIT_MAX,
  maxTrackedKeys: 10000,
});

app.use(
  ['/api/dispatch', '/api/dispatch/stream', '/api/user-rating'],
  apiAuth as (req: Request, res: Response, next: NextFunction) => void,
  rateLimitMiddleware as (req: Request, res: Response, next: NextFunction) => void,
);

// ===== Agents =====
const routerAgent = new RouterAgent(
  CONFIG.SILICONFLOW_API_KEY,
  CONFIG.PROVIDER_URL,
  CONFIG.CONTRACT_ADDRESSES,
  undefined,
  process.env.SCORING_MODEL || undefined, // 未设则用 DEFAULT_SCORING_MODEL(14B)
);
const reputationAnalyzer = new ReputationAnalyzerAgent(
  CONFIG.SILICONFLOW_API_KEY,
  CONFIG.PROVIDER_URL,
  CONFIG.CONTRACT_ADDRESSES,
);
reputationAnalyzer.setSigner(new ethers.Wallet(CONFIG.REPUTATION_SIGNER_PK, sharedProvider));

interface DispatchHistoryEntry {
  taskId: string;
  task: string;
  selectedAgent: { did: string; address: string; qualification: string } | null;
  result: string;
  tokens: number;
  reputationScore: number | null;
  recordId: number | null;
  timestamp: number;
}
const dispatchHistory: DispatchHistoryEntry[] = [];

// ===== Routes =====
app.get('/api/agent-types', (_req: Request, res: Response) => {
  const types = Object.entries(QUALIFICATION_CONFIG).map(([key, config]) => ({
    key,
    name: config.name,
    icon: config.icon,
  }));
  res.json(types);
});

app.get('/api/scoring-dimensions', (_req: Request, res: Response) => {
  res.json(SCORING_DIMENSIONS);
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    chainId: CONFIG.CHAIN_ID,
    routerSigner: routerWalletAddress,
    apiAuthRequired: CONFIG.ACCESS_KEYS.length > 0,
    auditMode: auditAdapter.mode,
    auditReadback: auditAdapter.supportsOnChainReadback,
  });
});

app.get('/api/dispatch/history', (_req: Request, res: Response) => {
  res.json(dispatchHistory.slice(-50));
});

app.get('/api/reputation/summary', async (_req: Request, res: Response) => {
  try {
    const summaries = await reputationAnalyzer.getAgentPerformanceSummary();
    const history = reputationAnalyzer.getAnalysisHistory();
    res.json({ agents: summaries, analysisHistory: history.slice(-20), totalAnalysis: history.length });
  } catch (error) {
    sendError(res, 500, 'REPUTATION_SUMMARY_FAILED', error);
  }
});

app.post('/api/user-rating', async (req: Request, res: Response) => {
  const { agentAddress, score, comment } = req.body;
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
    sendError(res, 500, 'USER_RATING_FAILED', error);
  }
});

// ===== 主调度（流式） =====
app.post('/api/dispatch/stream', async (req: Request, res: Response) => {
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

  // ── P6 SSE 健壮化 ──
  // 客户端断连检测：必须监听 res 的 close（响应连接关闭），而非 req 的 close。
  // req('close') 在请求体被完全读取后即触发（POST body 读完就关可读端），
  // 不代表客户端断开 —— 监听它会导致每个正常 POST 在第一阶段后被误判为 aborted。
  // res('close') 只在底层连接真正关闭时触发；若此时响应未正常 end，才是客户端中途断开。
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) aborted = true;
  });

  const sendEvent = (type: string, data: SSEEventData): void => {
    // 写前检查可写状态
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify({ ...data, taskId })}\n\n`);
    } catch (writeErr) {
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'api-server',
          event: 'sse_write_error',
          type,
          detail: writeErr instanceof Error ? writeErr.message : String(writeErr),
        }),
      );
    }
  };

  const safeEnd = (): void => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.end();
    } catch {
      /* noop */
    }
  };

  // 心跳：每 15s 发一次，防止代理/浏览器超时断连
  const heartbeatInterval = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeatInterval);
      return;
    }
    sendEvent('heartbeat', {});
  }, 15000);

  // 任务超时
  let taskTimedOut = false;
  const taskTimeoutHandle = setTimeout(() => {
    taskTimedOut = true;
    sendEvent('timeout', { code: 'TASK_TIMEOUT' });
    safeEnd();
  }, SSE_TASK_TIMEOUT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeatInterval);
    clearTimeout(taskTimeoutHandle);
  };

  let selected: Candidate | null = null;
  let recordId: number | null = null;
  const taskHash = ethers.keccak256(ethers.toUtf8Bytes(task));
  // 改造 A4：完整 commit-reveal —— commitment = keccak256(taskDescription || salt)
  let finalSalt: string = taskSalt;
  if (!finalSalt || finalSalt === '0x' + '0'.repeat(64)) {
    finalSalt = ethers.hexlify(ethers.randomBytes(32));
  }
  let finalCommitment: string = taskCommitment;
  if (!finalCommitment || finalCommitment === '0x' + '0'.repeat(64)) {
    finalCommitment = ethers.keccak256(ethers.solidityPacked(['string', 'bytes32'], [task, finalSalt]));
  }

  try {
    sendEvent('start', {
      message: '开始处理任务...',
      task,
      taskHash,
      taskCommitment: finalCommitment,
      taskSalt: finalSalt,
    });

    // Phase 1: 意图解析
    sendEvent('phase', { phase: 'intent_parsing', message: '正在解析任务意图...', icon: '🧠' });
    let intent: Intent;
    try {
      intent = await routerAgent.parseIntent(task);
    } catch {
      intent = {
        intent: task,
        requiredQualification: 'content',
        complexity: 'medium',
        priority: 'quality',
      };
      sendEvent('intent_parsed', { intent, detail: '意图解析使用默认值（LLM 不可用）' });
    }
    if (!intent.requiredQualification) intent.requiredQualification = 'content';
    sendEvent('intent_parsed', {
      intent,
      detail: `识别到意图: ${intent.intent}, 所需资质: ${intent.requiredQualification}`,
    });
    if (aborted || taskTimedOut) { cleanup(); return; }

    // Phase 2: 候选 Agent
    sendEvent('phase', { phase: 'getting_candidates', message: '从链上获取候选 Agent...', icon: '🔍' });
    let candidates: Candidate[];
    try {
      candidates = await routerAgent.getCandidateAgents(intent.requiredQualification);
    } catch (candErr) {
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'api-server',
          event: 'get_candidates_failed',
          detail: candErr instanceof Error ? candErr.message : String(candErr),
        }),
      );
      candidates = [];
    }
    sendEvent('candidates', {
      candidates: candidates.map((c) => ({
        did: c.did,
        address: c.address,
        qualification: c.qualification,
        avgRating: c.avgRating,
        ratingCount: c.ratingCount,
      })),
      detail: `找到 ${candidates.length} 个候选 Agent`,
    });
    if (aborted || taskTimedOut) { cleanup(); return; }

    if (candidates.length === 0) {
      sendEvent('error', { error: '没有找到匹配的候选 Agent，请先注册 Agent' });
      cleanup();
      safeEnd();
      return;
    }

    // Phase 3: LLM 评估
    sendEvent('phase', { phase: 'evaluating', message: 'LLM 正在评估候选 Agent...', icon: '🤖' });
    let ranked = candidates;
    let decision = '';
    try {
      const evalResult = await routerAgent.evaluateCandidates(
        candidates,
        intent,
        intent.requiredQualification,
      );
      ranked = evalResult.candidates;
      decision = evalResult.decision;
    } catch {
      // P1-C4：删除 Math.random 随机兜底，改用确定性 ruleScore（论文公式 3），
      // 保证 LLM 不可用时评分仍可复现，且签名上链的排名是确定的。
      console.warn(
        JSON.stringify({
          level: 'warn',
          component: 'api-server',
          event: 'router_eval_fallback',
          detail: 'LLM 评估失败，降级到确定性规则评分 ruleScore',
        }),
      );
      ranked.forEach((c) => {
        c.score = ruleScore(c, intent.requiredQualification);
        c.reason = c.qualification === intent.requiredQualification ? '资质完全匹配' : '资质部分匹配';
      });
      ranked.sort((a, b) => b.score - a.score);
      decision = 'LLM 不可用，使用确定性规则评分（ruleScore）';
    }
    sendEvent('evaluated', {
      rankings: ranked.map((c) => ({ did: c.did, address: c.address, score: c.score, reason: c.reason })),
      detail: decision,
    });
    if (aborted || taskTimedOut) { cleanup(); return; }

    // Phase 4: 决策 + 路由签名
    const routeResult = await routerAgent.makeDecision(ranked, decision);
    selected = routeResult.agent;
    const timestamp = Math.floor(Date.now() / 1000);
    const rankedAgentsHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [ranked.map((c) => c.address)]),
    );
    const decisionValue = {
      taskHash,
      rankedAgents: rankedAgentsHash,
      topAgent: selected.address,
      timestamp,
    };
    let decisionDigest: string;
    let decisionSig: string;
    try {
      // digest 仅用于 SSE 展示/审计可读性；合约不再接收 digest，而是链上用明文字段重建（P1-C2）
      decisionDigest = ethers.TypedDataEncoder.hash(EIP712_DOMAIN, ROUTER_DECISION_TYPES, decisionValue);
      decisionSig = await routerSigner.signTypedData(EIP712_DOMAIN, ROUTER_DECISION_TYPES, decisionValue);
    } catch (sigErr) {
      sendError(res, 500, 'ROUTER_SIG_FAILED', sigErr);
      cleanup();
      safeEnd();
      return;
    }
    if (aborted || taskTimedOut) { cleanup(); return; }
    sendEvent('selected', {
      selected: {
        did: selected.did,
        address: selected.address,
        qualification: selected.qualification,
        score: selected.score,
        avgRating: selected.avgRating,
      },
      decision,
      routerSigner: routerWalletAddress,
      decisionDigest,
      detail: `选中 Agent: ${selected.did} (评分: ${selected.score})`,
    });

    // Phase 5: Worker 执行
    const agentConfig =
      QUALIFICATION_CONFIG[toQualification(selected.qualification)] || QUALIFICATION_CONFIG.content;
    sendEvent('phase', {
      phase: 'executing',
      message: `${agentConfig.icon} ${agentConfig.name}正在执行任务...`,
      icon: agentConfig.icon,
      agentType: selected.qualification,
      agentName: agentConfig.name,
    });

    const workerAgent = new WorkerAgent(CONFIG.SILICONFLOW_API_KEY, selected);
    sendEvent('thinking', { message: 'Agent 正在思考...' });
    let executionResult: ExecutionResult;
    try {
      executionResult = await workerAgent.execute(task, {
        selectedAgent: selected.did,
        reputation: selected.avgRating,
      });
    } catch (execErr) {
      executionResult = {
        result: `执行失败: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
        chainOfThought: '',
        executionLog: [],
        tokens: 0,
        model: 'N/A',
        agentType: selected.qualification,
      };
    }
    sendEvent('chain_of_thought', {
      chainOfThought: executionResult.chainOfThought,
      model: executionResult.model,
    });
    sendEvent('result', {
      result: executionResult.result,
      model: executionResult.model,
      agentType: executionResult.agentType,
    });
    if (aborted || taskTimedOut) { cleanup(); return; }

    // Phase 6: 链上记录（带签名）
    sendEvent('phase', { phase: 'logging', message: '记录审计日志到区块链...', icon: '⛓️' });
    try {
      // P1-C2：传 Decision 明文字段（taskHash/rankedAgents/timestamp），合约链上重建 EIP-712 摘要
      // 适配器按 AUDIT_MODE 走 full（logScheduleWithDecision）或 optimized（M5 logScheduleEncoded）
      const logRes = await auditAdapter.logSchedule({
        requester: routerWalletAddress,
        targetAgent: selected.address,
        taskCommitment: finalCommitment,
        reason: 0,
        routerSigner: routerWalletAddress,
        taskHash,
        rankedAgents: rankedAgentsHash,
        decisionTimestamp: timestamp,
        decisionSig,
      });
      recordId = logRes.recordId;

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes(executionResult.result));
      const resultDigest = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint256', 'bytes32', 'uint256'],
          [recordId, resultHash, timestamp],
        ),
      );
      // P2：用选中 agent「自己的」签名器签 Result，而非单一后端代签密钥
      const workerSigner = workerSigning.forAgent(selected.address);
      const workerSig = await workerSigner.signTypedData(EIP712_DOMAIN, WORKER_RESULT_TYPES, {
        recordId,
        resultDigest,
        timestamp,
      });
      // P1-C2：传 resultTimestamp，合约链上重建 Result 摘要
      const upd = await auditAdapter.updateExecution({
        recordId,
        status: 1,
        result: executionResult.result,
        resultDigest,
        resultTimestamp: timestamp,
        workerSig,
      });

      sendEvent('logged', {
        message: `审计日志已记录到区块链（${auditAdapter.mode} 模式，含 Router + Worker 签名）`,
        recordId,
        txHash: logRes.txHash,
        auditMode: auditAdapter.mode,
        executionTxHash: upd.txHash,
      });
    } catch (logErr) {
      sendEvent('logged', {
        message: '审计日志记录异常，任务结果仍有效',
      });
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'api-server',
          event: 'audit_log_failed',
          detail: logErr instanceof Error ? logErr.message : String(logErr),
        }),
      );
    }
    if (aborted || taskTimedOut) { cleanup(); return; }

    // Phase 7: 信誉分析
    sendEvent('phase', {
      phase: 'reputation_analysis',
      message: '信誉分析 Agent 正在评估执行质量...',
      icon: '📊',
    });
    let reputationAnalysis = null;
    try {
      reputationAnalysis = await reputationAnalyzer.fullAnalysis({
        task,
        selectedAgent: {
          did: selected.did,
          address: selected.address,
          qualification: selected.qualification,
        },
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
    } catch {
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
      taskId,
      task,
      selectedAgent: selected
        ? { did: selected.did, address: selected.address, qualification: selected.qualification }
        : null,
      result: executionResult.result,
      tokens: executionResult.tokens,
      reputationScore: reputationAnalysis?.analysis?.totalScore || null,
      recordId,
      timestamp: Date.now(),
    });
  } catch (error) {
    sendError(res, 500, 'DISPATCH_STREAM_FAILED', error);
  } finally {
    cleanup();
    safeEnd();
  }
});

// ===== 阻塞式调度 =====
app.post('/api/dispatch', async (req: Request, res: Response) => {
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
    const taskHash = ethers.keccak256(ethers.toUtf8Bytes(task));
    const commitment =
      taskCommitment && taskCommitment !== '0x' + '0'.repeat(64) ? taskCommitment : taskHash;
    const rankedAgentsHash = ethers.keccak256(ethers.toUtf8Bytes('rank-' + taskId));
    const timestamp = Math.floor(Date.now() / 1000);
    const decisionValue = {
      taskHash,
      rankedAgents: rankedAgentsHash,
      topAgent: routingResult.agent.address,
      timestamp,
    };
    const decisionSig = await routerSigner.signTypedData(
      EIP712_DOMAIN,
      ROUTER_DECISION_TYPES,
      decisionValue,
    );
    // P1-C2：传 Decision 明文字段，合约链上重建 EIP-712 摘要（适配器按 AUDIT_MODE 选实现）
    const logRes = await auditAdapter.logSchedule({
      requester: routerWalletAddress,
      targetAgent: routingResult.agent.address,
      taskCommitment: commitment,
      reason: 0,
      routerSigner: routerWalletAddress,
      taskHash,
      rankedAgents: rankedAgentsHash,
      decisionTimestamp: timestamp,
      decisionSig,
    });
    const recordId = logRes.recordId;
    const resultHash = ethers.keccak256(ethers.toUtf8Bytes(executionResult.result));
    const resultDigest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'bytes32', 'uint256'],
        [recordId, resultHash, timestamp],
      ),
    );
    // P2：阻塞路径同样用选中 agent 自己的签名器
    const blockingWorkerSigner = workerSigning.forAgent(routingResult.agent.address);
    const workerSig = await blockingWorkerSigner.signTypedData(EIP712_DOMAIN, WORKER_RESULT_TYPES, {
      recordId,
      resultDigest,
      timestamp,
    });
    await auditAdapter.updateExecution({
      recordId,
      status: 1,
      result: executionResult.result,
      resultDigest,
      resultTimestamp: timestamp,
      workerSig,
    });

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
      executionLog: [...(routingResult.executionLog || []), ...executionResult.executionLog],
      tokensUsed: executionResult.tokens,
      recordId,
      taskCommitment: commitment,
      routerSigner: routerWalletAddress,
    });
  } catch (error) {
    sendError(res, 500, 'DISPATCH_FAILED', error);
  }
});

// 仅在直接运行时启动监听（测试通过 supertest 导入 app，不应自动 listen）
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 ORACLE Agent API 服务运行在 http://localhost:${CONFIG.PORT}`);
    console.log(`🔐 API 认证: ${CONFIG.ACCESS_KEYS.length > 0 ? '已启用' : '未启用（生产必须设置 API_ACCESS_KEYS）'}`);
    console.log(`🛡️  Rate Limit: ${CONFIG.RATE_LIMIT_MAX} req / ${CONFIG.RATE_LIMIT_WINDOW_MS}ms`);
    console.log(`🔑 Router Signer: ${routerWalletAddress}`);
  });
}

export default app;
