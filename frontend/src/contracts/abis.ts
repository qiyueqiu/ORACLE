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
  'function verifyQualification(bytes32 nullifier, bytes32 secretHash, bytes32 commitment) external view returns (bool)',
  'function getAgent(address agent) external view returns (address owner, string memory did, bytes32 commitment, string memory qualificationType, bool isActive, uint256 registeredAt)',
  'function agents(address) external view returns (address owner, string memory did, bytes32 commitment, string memory qualificationType, bool isActive, uint256 registeredAt)',
  'function agentList(uint256) external view returns (address)',
  'function agentCount() external view returns (uint256)',
  'event AgentRegistered(address indexed owner, string did, bytes32 commitment, string qualificationType)',
];

export const AuditLogABI = [
  'function logSchedule(address requester, address targetAgent, string calldata taskDescription, uint8 decisionReason) external returns (uint256)',
  'function updateExecution(uint256 recordId, uint8 status, string calldata result) external',
  'function submitRating(uint256 recordId, uint256 rating) external',
  'function getRecord(uint256 recordId) external view returns (uint256 id, uint256 timestamp, address requester, address targetAgent, string memory taskDescription, uint8 decisionReason, uint8 executionStatus, string memory executionResult, uint256 reputationRating, bytes32 transactionHash)',
  'function recordCount() external view returns (uint256)',
  'function getRecordsByTimeRange(uint256 startTime, uint256 endTime) external view returns (uint256[] memory)',
  'function getRecordsByAgent(address agent) external view returns (uint256[] memory)',
  'function getAllRecords() external view returns (uint256[] memory)',
  'event ScheduleLogged(uint256 indexed recordId, address indexed requester, address indexed targetAgent, uint8 reason, string taskDescription)',
  'event ExecutionUpdated(uint256 indexed recordId, uint8 status, string result)',
];

export const ReputationABI = [
  'function addRating(address agent, uint256 rating) external returns (uint256)',
  'function getReputation(address agent) external view returns (uint256 totalScore, uint256 ratingCount, uint256 averageRating, uint256 lastUpdated)',
  'function reputations(address agent) external view returns (uint256 totalScore, uint256 ratingCount, uint256 averageRating, uint256 lastUpdated, bool exists)',
  'function getAverageRating(address agent) external view returns (uint256)',
  'function hasReputation(address agent) external view returns (bool)',
  'function isReliable(address agent) external view returns (bool)',
  'event ReputationUpdated(address indexed agent, uint256 newAverage, uint256 totalRatings)',
];

export function getProvider() {
  return new ethers.JsonRpcProvider('http://localhost:8545');
}

const HARDHAT_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export function getSigner(): ethers.Wallet {
  const provider = getProvider();
  return new ethers.Wallet(HARDHAT_PRIVATE_KEY, provider);
}

export function getContracts(signer: ethers.Signer) {
  return {
    agentDID: new ethers.Contract(CONTRACT_ADDRESSES.AgentDID, AgentDIDABI, signer),
    auditLog: new ethers.Contract(CONTRACT_ADDRESSES.AuditLog, AuditLogABI, signer),
    reputation: new ethers.Contract(CONTRACT_ADDRESSES.Reputation, ReputationABI, signer),
  };
}
