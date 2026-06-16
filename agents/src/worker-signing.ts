/**
 * Worker 签名 Provider（P2：密钥分离）
 *
 * 目的：消除「后端用单一 WORKER_DEMO_PK 代所有 agent 签名」的信任坍塌（审计 C1）。
 * 改为每个 worker 用自己的密钥签名，后端退化为无特权中继：它只能为某 agent 取出
 * 「该 agent 自己的」签名器，无法用一把钥伪造任意 agent 的结果。链上 AuditLog
 * 的 updateExecutionWithSig 会校验 recovered == AgentDID.getPubKey(targetAgent)，
 * 因此后端即使作恶也无法让错误签名通过。
 *
 * 两种模式：
 *   - 'demo'：本地/测试。worker 密钥由助记词按 agent 地址确定性派生（Hardhat 内置账户）。
 *     残留信任：密钥仍在后端进程内——这是 demo 取舍，须如实披露。
 *   - 'relay'：生产。后端不持有 worker 密钥，只转发 agent 端预签名的 payload。
 *     （接口预留，本阶段给出 stub + 抛错指引，P4/生产接入。）
 */

import { ethers } from 'ethers';

export type WorkerSigningMode = 'demo' | 'relay';

/** 单个 worker 的签名能力：能对 EIP-712 typed-data 签名，并暴露其地址（= 链上 pubKey） */
export interface WorkerSigner {
  readonly address: string;
  signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

export interface WorkerSigningProvider {
  readonly mode: WorkerSigningMode;
  /** 取得某 agent 地址对应的签名器；demo 模式按助记词派生，relay 模式取预签名通道 */
  forAgent(agentAddress: string): WorkerSigner;
}

export interface WorkerSigningOptions {
  /** demo 模式：HD 助记词（默认 Hardhat 标准助记词） */
  mnemonic?: string;
  /** demo 模式：预派生的账户数量（覆盖前 N 个 Hardhat 账户，足够覆盖 demo agents） */
  derivationCount?: number;
  /** relay 模式：预签名查找回调（由调用方注入） */
  relayLookup?: (agentAddress: string) => WorkerSigner | undefined;
}

const HARDHAT_DEFAULT_MNEMONIC = 'test test test test test test test test test test test junk';

/**
 * 构造 worker 签名 provider。
 *
 * demo 模式实现：预派生 m/44'/60'/0'/0/i（i=0..derivationCount-1），建立
 * 地址(小写) → Wallet 映射。forAgent 用 agent 地址查表，命中即返回该 agent
 * 自己的钱包作为签名器；未命中（agent 不在派生集中）抛错，绝不退回到某把"默认钥"
 * —— 这正是与旧 workerDemoSigner 的本质区别。
 */
export function makeWorkerSigningProvider(
  mode: WorkerSigningMode,
  opts: WorkerSigningOptions = {},
): WorkerSigningProvider {
  if (mode === 'relay') {
    const lookup = opts.relayLookup;
    return {
      mode,
      forAgent(agentAddress: string): WorkerSigner {
        const signer = lookup?.(agentAddress);
        if (!signer) {
          throw new Error(
            `relay 模式下未找到 agent ${agentAddress} 的预签名通道；` +
              `生产中 worker 必须自行签名后由后端转发，后端不持有 worker 密钥。`,
          );
        }
        return signer;
      },
    };
  }

  // demo 模式：按助记词预派生地址 → 钱包
  const mnemonic = opts.mnemonic || HARDHAT_DEFAULT_MNEMONIC;
  const count = opts.derivationCount ?? 20;
  const byAddress = new Map<string, ethers.HDNodeWallet>();
  for (let i = 0; i < count; i++) {
    const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`);
    byAddress.set(wallet.address.toLowerCase(), wallet);
  }

  return {
    mode,
    forAgent(agentAddress: string): WorkerSigner {
      const wallet = byAddress.get(agentAddress.toLowerCase());
      if (!wallet) {
        throw new Error(
          `demo 签名 provider 未覆盖 agent 地址 ${agentAddress}` +
            `（派生集大小=${count}）；该 agent 的 pubKey 未在后端可派生范围内，` +
            `后端无法（也不应）代其签名。`,
        );
      }
      return wallet;
    },
  };
}
