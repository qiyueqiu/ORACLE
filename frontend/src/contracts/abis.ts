import { ethers } from 'ethers';
import addresses from './addresses.json';

export const CONTRACT_ADDRESSES = addresses.contracts;

export const QUALIFICATION_CONFIG: Record<string, { name: string; icon: string; color: string }> = {
  code_review: { name: '代码审查', icon: '🔍', color: '#3b82f6' },
  data_analysis: { name: '数据分析', icon: '📊', color: '#10b981' },
  translation: { name: '翻译服务', icon: '🌐', color: '#f59e0b' },
  research: { name: '研究分析', icon: '🔬', color: '#6366f1' },
  creative: { name: '创意写作', icon: '✍️', color: '#ec4899' },
  weather: { name: '天气服务', icon: '🌤️', color: '#06b6d4' },
  content: { name: '内容创作', icon: '📝', color: '#8b5cf6' },
  calc: { name: '计算服务', icon: '🔢', color: '#eab308' },
};

export const AgentDIDABI = [
  'function registerAgent(string calldata did, bytes32 commitment, string calldata qualificationType) external',
  'function registerAgentWithPubKey(string calldata did, bytes32 commitment, string calldata qualificationType, address pubKey) external',
  'function setPubKey(address pubKey) external',
  'function getPubKey(address agent) external view returns (address)',
  'function verifyQualification(bytes32 nullifier, bytes32 secretHash, bytes32 commitment) external view returns (bool)',
  'function verifyAndUseQualification(address agent, bytes32 nullifier, bytes32 secretHash) external returns (bool)',
  'function getAgent(address agentAddress) external view returns (address owner, string memory did, bytes32 commitment, string memory qualificationType, bool isActive, uint256 registeredAt)',
  'function agents(address) external view returns (address owner, string did, bytes32 commitment, string qualificationType, bool isActive, uint256 registeredAt, address pubKey)',
  'function agentList(uint256) external view returns (address)',
  'function agentCount() external view returns (uint256)',
  'function isRegistered(address) external view returns (bool)',
  'function getAllAgents() external view returns (address[] memory)',
  'function setAgentActive(address agent, bool isActive) external',
  'function getCommitment(address agent) external view returns (bytes32)',
  'event AgentRegistered(address indexed owner, string did, bytes32 commitment, string qualificationType, address pubKey)',
  'event QualificationVerified(address indexed agent, bytes32 nullifier, bool success)',
  'event PubKeyUpdated(address indexed agent, address pubKey)',
];

export const AuditLogABI = [
  'function logSchedule(address requester, address targetAgent, string calldata taskDescription, uint8 decisionReason) external returns (uint256)',
  'function logScheduleWithDecision(address requester, address targetAgent, bytes32 taskCommitment, uint8 decisionReason, address routerSigner, bytes32 decisionDigest, bytes calldata decisionSig) external returns (uint256)',
  'function updateExecution(uint256 recordId, uint8 status, string calldata result) external',
  'function updateExecutionWithSig(uint256 recordId, uint8 status, string calldata result, bytes32 resultDigest, bytes calldata workerSig) external',
  'function submitRating(uint256 recordId, uint256 rating) external',
  'function getRecord(uint256 recordId) external view returns (uint256 id, uint256 timestamp, address requester, address targetAgent, bytes32 taskCommitment, uint8 decisionReason, uint8 executionStatus, string memory executionResult, uint256 reputationRating, bytes32 transactionHash)',
  'function getRecordFull(uint256 recordId) external view returns (uint256 id, uint256 timestamp, address requester, address targetAgent, bytes32 taskCommitment, uint8 decisionReason, uint8 executionStatus, string memory executionResult, uint256 reputationRating, address routerSigner, bytes32 decisionDigest, address workerSigner)',
  'function getRecordsByTimeRange(uint256 startTime, uint256 endTime) external view returns (uint256[] memory)',
  'function getRecordsByAgent(address agent) external view returns (uint256[] memory)',
  'function getAllRecords() external view returns (uint256[] memory)',
  'function recordCount() external view returns (uint256)',
  'function commitmentToRecord(bytes32) external view returns (uint256)',
  'event ScheduleLogged(uint256 indexed recordId, address indexed requester, address indexed targetAgent, uint8 reason, bytes32 taskCommitment)',
  'event ExecutionUpdated(uint256 indexed recordId, uint8 status, string result, address workerSigner)',
  'event RatingSubmitted(uint256 indexed recordId, uint256 rating)',
  'event RouterDecisionLogged(uint256 indexed recordId, address indexed routerSigner, bytes32 decisionDigest)',
];

export const ReputationABI = [
  'function addRating(address agent, uint256 rating) external returns (uint256)',
  'function rateWeighted(address agent, uint256 rating) external returns (uint256)',
  'function getReputation(address agent) external view returns (uint256 totalScore, uint256 ratingCount, uint256 averageRating, uint256 lastUpdated)',
  'function reputations(address agent) external view returns (uint256 totalScore, uint256 weightSum, uint256 ratingCount, uint256 averageRating, uint256 lastUpdated, bool exists)',
  'function getAverageRating(address agent) external view returns (uint256)',
  'function hasReputation(address agent) external view returns (bool)',
  'function isReliable(address agent) external view returns (bool)',
  'function isReliableWeighted(address agent) external view returns (bool)',
  'function timeDecayed(address agent) external view returns (uint256)',
  'function meetsThreshold(address agent, uint256 threshold) external view returns (bool)',
  'function applyPenalty(address agent, uint256 penalty, string calldata reason) external',
  'function setHalfLife(uint256 newHalfLife) external',
  'function setMinRaterReputation(uint256 newMin) external',
  'function setRestrictRaters(bool restrict) external',
  'function setAuthorizedRater(address rater, bool allowed) external',
  'function getTopAgents(uint256 limit) external view returns (address[] memory, uint256[] memory)',
  'function getAllReputations() external view returns (address[] memory, uint256[] memory)',
  'function getAgentCount() external view returns (uint256)',
  'event ReputationUpdated(address indexed agent, uint256 newAverage, uint256 totalRatings, uint256 appliedWeight)',
  'event ReputationPenalty(address indexed agent, uint256 penaltyAmount, string reason)',
];

/**
 * Provider：本地 Hardhat 节点（演示用）。
 * 生产部署应使用环境变量 `VITE_PROVIDER_URL`。
 */
export function getProvider(): ethers.JsonRpcProvider {
  const url = (import.meta as any).env?.VITE_PROVIDER_URL || 'http://localhost:8545';
  return new ethers.JsonRpcProvider(url);
}

/**
 * 钱包提供者抽象（改造 6：MetaMask 接入）
 *
 * - hasInjectedProvider(): 检测浏览器是否安装了 MetaMask
 * - getInjectedProvider(): 获取 window.ethereum
 * - connectWallet(): 用户点击"连接钱包"时调用，弹出 MetaMask
 * - getSigner(): 当前已连接的钱包 signer（未连接返回 null）
 */
export interface WalletState {
  address: string;
  chainId: number;
}

let _currentSigner: ethers.Signer | null = null;
let _walletState: WalletState | null = null;
const _listeners: Array<(s: WalletState | null) => void> = [];

export function hasInjectedProvider(): boolean {
  return typeof window !== 'undefined' && !!(window as any).ethereum;
}

export function getInjectedProvider(): any {
  if (!hasInjectedProvider()) {
    throw new Error('No injected wallet provider found. Please install MetaMask.');
  }
  return (window as any).ethereum;
}

export async function connectWallet(): Promise<WalletState> {
  // 本地开发（chainId 31337）且无 MetaMask：自动 fallback 到 Hardhat 默认 signer
  // 说明：与 CLAUDE.md 描述一致 —— 本地演示模式使用 Hardhat 内置 signer。
  if (!hasInjectedProvider()) {
    const provider = getProvider();
    const network = await provider.getNetwork();
    if (Number(network.chainId) === 31337) {
      const fallbackWallet = new ethers.Wallet(
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        provider
      );
      _currentSigner = fallbackWallet;
      _walletState = { address: fallbackWallet.address, chainId: 31337 };
      _emitChange(_walletState);
      return _walletState;
    }
    throw new Error('No injected wallet provider found. Please install MetaMask.');
  }
  const injected = getInjectedProvider();
  const accounts: string[] = await injected.request({ method: 'eth_requestAccounts' });
  if (!accounts || accounts.length === 0) throw new Error('No accounts available');
  const provider = new ethers.BrowserProvider(injected);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();
  _currentSigner = signer;
  _walletState = { address: accounts[0], chainId: Number(network.chainId) };
  _emitChange(_walletState);
  return _walletState;
}

export function getCurrentSigner(): ethers.Signer | null {
  return _currentSigner;
}

export function getWalletState(): WalletState | null {
  return _walletState;
}

export function onWalletChange(fn: (s: WalletState | null) => void): () => void {
  _listeners.push(fn);
  return () => {
    const i = _listeners.indexOf(fn);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

function _emitChange(s: WalletState | null) {
  for (const fn of _listeners) {
    try { fn(s); } catch { /* noop */ }
  }
}

/**
 * 旧版 getSigner() 已废弃——私钥不再硬编码在客户端。
 * 如果调用方未连接钱包，请改用 connectWallet() + getCurrentSigner()。
 */
export function getSigner(): ethers.Wallet {
  throw new Error(
    'getSigner() is deprecated. Use connectWallet() to connect MetaMask, ' +
    'then getCurrentSigner() to obtain the signer. ' +
    'This change removes hardcoded private keys from the client.'
  );
}

export function getContracts(signer: ethers.Signer) {
  return {
    agentDID: new ethers.Contract(CONTRACT_ADDRESSES.AgentDID, AgentDIDABI, signer),
    auditLog: new ethers.Contract(CONTRACT_ADDRESSES.AuditLog, AuditLogABI, signer),
    reputation: new ethers.Contract(CONTRACT_ADDRESSES.Reputation, ReputationABI, signer),
  };
}
