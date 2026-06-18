/**
 * 审计写入适配器（P-cost：成本--可验证性帕累托前沿接入生产）
 *
 * 把「记录调度决策 + 更新执行结果」两步链上写入抽象成统一接口，让 api-server
 * 在两种审计模式间切换而无需改动调度主流程：
 *
 *   - FullAuditAdapter      → 原版 AuditLog（13 字段全 SSTORE，~407k gas/dispatch）
 *                             链上可回读（getRecord）、支持 dispute/slash、eth_getProof
 *                             无信任存在性证明。
 *   - OptimizedAuditAdapter → AuditLogOptimized 的 M5 编码路径（event-only + recordId
 *                             编码归属，零存储锚点，~85k gas/dispatch，省 ~79%）。
 *                             审计数据走 event（receipts trie 同等防篡改），代价是记录
 *                             可发现性移到链下 indexer。
 *
 * 两种模式的安全属性等价：均链上重建 EIP-712 摘要 + ecrecover 校验 router/worker
 * 签名，worker 必须等于 AgentDID 注册 pubKey。优化的是存储成本，不是放松验签。
 *
 * 安全关键（M5 归属）：optimized 模式下 recordId = (uint160(targetAgent) << 96) | seq，
 * targetAgent 编入高位，执行阶段从 recordId 纯位运算解出，worker 改不了 recordId
 * 即改不了归属——等同 full 模式的存储锚点安全性（对抗审查验证，见 AuditLogOptimized.sol）。
 */

import { ethers } from 'ethers';
import {
  AuditLog__factory,
  AuditLogOptimized__factory,
} from '../../typechain-types/index.js';
import type { AuditLog, AuditLogOptimized } from '../../typechain-types/index.js';

/** 调度决策记录入参（router 已在链下签好 decisionSig） */
export interface LogScheduleParams {
  requester: string;
  targetAgent: string;
  taskCommitment: string;
  /** DecisionReason 枚举值（0 = QUALIFIED） */
  reason: number;
  routerSigner: string;
  taskHash: string;
  rankedAgents: string;
  decisionTimestamp: number;
  decisionSig: string;
}

/** 执行结果更新入参（worker 已在链下签好 workerSig） */
export interface UpdateExecutionParams {
  recordId: number;
  /** ExecutionStatus 枚举值（1 = SUCCESS） */
  status: number;
  /** 结果明文（仅 full 模式上链存储；optimized 模式仅用其摘要） */
  result: string;
  resultDigest: string;
  resultTimestamp: number;
  workerSig: string;
}

export interface LogScheduleResult {
  recordId: number;
  txHash: string;
}

/** 统一审计写入接口 */
export interface AuditAdapter {
  readonly mode: 'full' | 'optimized';
  /** 记录调度决策，返回 recordId（链上 emit 的第一个 indexed topic） */
  logSchedule(p: LogScheduleParams): Promise<LogScheduleResult>;
  /** 更新执行结果（绑定 recordId 的 worker 签名） */
  updateExecution(p: UpdateExecutionParams): Promise<{ txHash: string }>;
  /** 该模式是否支持链上回读记录（getRecord）——optimized 为 false */
  readonly supportsOnChainReadback: boolean;
}

/** 从交易回执解析 recordId：取第一条日志的第 2 个 topic（recordId 为首个 indexed 字段） */
function extractRecordId(receipt: ethers.ContractTransactionReceipt | null): number {
  if (!receipt || receipt.logs.length === 0) {
    throw new Error('交易回执无日志，无法解析 recordId');
  }
  const topic = receipt.logs[0].topics[1];
  if (!topic) throw new Error('首条日志缺少 recordId topic');
  return Number(BigInt(topic));
}

/** 原版 AuditLog：13 字段全 SSTORE，链上可回读、支持 dispute/slash */
export class FullAuditAdapter implements AuditAdapter {
  readonly mode = 'full' as const;
  readonly supportsOnChainReadback = true;
  private readonly contract: AuditLog;

  constructor(address: string, signer: ethers.Signer) {
    this.contract = AuditLog__factory.connect(address, signer);
  }

  async logSchedule(p: LogScheduleParams): Promise<LogScheduleResult> {
    const tx = await this.contract.logScheduleWithDecision(
      p.requester,
      p.targetAgent,
      p.taskCommitment,
      p.reason,
      p.routerSigner,
      p.taskHash,
      p.rankedAgents,
      p.decisionTimestamp,
      p.decisionSig,
    );
    const r = await tx.wait();
    return { recordId: extractRecordId(r), txHash: r!.hash };
  }

  async updateExecution(p: UpdateExecutionParams): Promise<{ txHash: string }> {
    const tx = await this.contract.updateExecutionWithSig(
      p.recordId,
      p.status,
      p.result,
      p.resultDigest,
      p.resultTimestamp,
      p.workerSig,
    );
    const r = await tx.wait();
    return { txHash: r!.hash };
  }
}

/**
 * 成本优化版 AuditLogOptimized（M5 编码路径）：event-only + recordId 编码归属，零存储锚点。
 * recordId 高 160 位编码 targetAgent，执行阶段从 recordId 解出做 pubKey 比对（零存储读）。
 * 审计数据全部走 event；不支持链上 getRecord 回读（可发现性靠链下 indexer / EIP-7745）。
 */
export class OptimizedAuditAdapter implements AuditAdapter {
  readonly mode = 'optimized' as const;
  readonly supportsOnChainReadback = false;
  private readonly contract: AuditLogOptimized;

  constructor(address: string, signer: ethers.Signer) {
    this.contract = AuditLogOptimized__factory.connect(address, signer);
  }

  async logSchedule(p: LogScheduleParams): Promise<LogScheduleResult> {
    // M5：logScheduleEncoded —— recordId = (uint160(targetAgent) << 96) | seq，零锚点
    const tx = await this.contract.logScheduleEncoded(
      p.requester,
      p.targetAgent,
      p.taskCommitment,
      p.reason,
      p.routerSigner,
      p.taskHash,
      p.rankedAgents,
      p.decisionTimestamp,
      p.decisionSig,
    );
    const r = await tx.wait();
    return { recordId: extractRecordId(r), txHash: r!.hash };
  }

  async updateExecution(p: UpdateExecutionParams): Promise<{ txHash: string }> {
    // M5：updateExecutionEncoded —— targetAgent 从 recordId 解出，不接受传参（防归属冒充）
    // 注意：优化版不存结果明文（event-only），故不传 result 字符串，只传 resultDigest
    const tx = await this.contract.updateExecutionEncoded(
      p.recordId,
      p.status,
      p.resultDigest,
      p.resultTimestamp,
      p.workerSig,
    );
    const r = await tx.wait();
    return { txHash: r!.hash };
  }
}

/** 工厂：按模式构造适配器 */
export function makeAuditAdapter(
  mode: 'full' | 'optimized',
  addresses: { AuditLog: string; AuditLogOptimized?: string },
  signer: ethers.Signer,
): AuditAdapter {
  if (mode === 'optimized') {
    if (!addresses.AuditLogOptimized) {
      throw new Error(
        "AUDIT_MODE='optimized' 需要 AUDIT_LOG_OPTIMIZED_ADDRESS（部署 AuditLogOptimized 后填入 .env）",
      );
    }
    return new OptimizedAuditAdapter(addresses.AuditLogOptimized, signer);
  }
  return new FullAuditAdapter(addresses.AuditLog, signer);
}
