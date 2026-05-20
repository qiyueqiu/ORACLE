import { ethers } from 'ethers';

// 从部署文件读取合约地址
import addresses from './addresses.json';

export const CONTRACT_ADDRESSES = addresses.contracts;

// ABI fragments
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
