/**
 * ASB 后端共享 ABI（单一来源）
 * 任何后端服务（api-server / router-agent / worker-agent / reputation-analyzer）均从此模块加载。
 * 修改合约后必须同步更新本文件，并删除各文件中的 inline ABI。
 */
'use strict';

const { ethers } = require('ethers');

// ===== AgentDID ABI =====
const AgentDIDABI = [
  'function registerAgent(string calldata did, bytes32 commitment, string calldata qualificationType) external',
  'function registerAgentWithPubKey(string calldata did, bytes32 commitment, string calldata qualificationType, address pubKey) external',
  'function setPubKey(address pubKey) external',
  'function getPubKey(address agent) external view returns (address)',
  'function verifyQualification(bytes32 nullifier, bytes32 secretHash, bytes32 commitment) external view returns (bool)',
  'function verifyAndUseQualification(address agent, bytes32 nullifier, bytes32 secretHash) external returns (bool)',
  'function getAgent(address agentAddress) external view returns (address owner, string memory did, bytes32 commitment, string memory qualificationType, bool isActive, uint256 registeredAt)',
  'function agents(address) external view returns (address owner, string memory did, bytes32 commitment, string memory qualificationType, bool isActive, uint256 registeredAt, address pubKey)',
  'function agentList(uint256) external view returns (address)',
  'function agentCount() external view returns (uint256)',
  'function isRegistered(address) external view returns (bool)',
  'function getCommitment(address agent) external view returns (bytes32)',
  'function getAllAgents() external view returns (address[] memory)',
  'event AgentRegistered(address indexed owner, string did, bytes32 commitment, string qualificationType, address pubKey)',
  'event QualificationVerified(address indexed agent, bytes32 nullifier, bool success)',
  'event PubKeyUpdated(address indexed agent, address pubKey)',
];

// ===== AuditLog ABI =====
const AuditLogABI = [
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
  'function setAgentDID(address _agentDID) external',
  'function commitmentToRecord(bytes32) external view returns (uint256)',
  'event ScheduleLogged(uint256 indexed recordId, address indexed requester, address indexed targetAgent, uint8 reason, bytes32 taskCommitment)',
  'event ExecutionUpdated(uint256 indexed recordId, uint8 status, string result, address workerSigner)',
  'event RatingSubmitted(uint256 indexed recordId, uint256 rating)',
  'event RouterDecisionLogged(uint256 indexed recordId, address indexed routerSigner, bytes32 decisionDigest)',
];

// ===== Reputation ABI =====
const ReputationABI = [
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
  'event RaterAuthorized(address indexed rater, bool allowed)',
  'event ConfigUpdated(uint256 halfLifeSeconds, uint256 minRaterReputation, bool restrictRaters)',
];

// ===== MockERC20 ABI =====
const MockERC20ABI = [
  'function mint(address to, uint256 amount) external',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
];

// ===== AgentStake ABI =====
const AgentStakeABI = [
  'function stake(uint256 amount) external returns (uint256)',
  'function unstake(uint256 amount) external',
  'function slash(address agent, string calldata reason) external returns (uint256)',
  'function getStake(address agent) external view returns (uint256)',
  'function isStaked(address agent) external view returns (bool)',
  'function minStake() external view returns (uint256)',
  'function slashBps() external view returns (uint256)',
  'function setAuditLog(address _auditLog) external',
  'function setMinStake(uint256 newMin) external',
  'function setSlashBps(uint256 newBps) external',
  'event Staked(address indexed agent, uint256 amount, uint256 newBalance)',
  'event Unstaked(address indexed agent, uint256 amount)',
  'event Slashed(address indexed agent, uint256 amount, string reason)',
];

// ===== PaymentEscrow ABI =====
const PaymentEscrowABI = [
  'function fundTask(uint256 recordId, address worker, uint256 deadline, uint256 amount) external',
  'function release(uint256 recordId) external',
  'function refund(uint256 recordId) external',
  'function getEscrow(uint256 recordId) external view returns (tuple(address payer, address worker, uint256 amount, uint256 deadline, uint8 status))',
  'function setAuditLog(address _auditLog) external',
  'function setFeeBps(uint256 newBps) external',
  'function feeBps() external view returns (uint256)',
  'event TaskFunded(uint256 indexed recordId, address indexed payer, address indexed worker, uint256 amount)',
  'event TaskReleased(uint256 indexed recordId, address indexed worker, uint256 amount, uint256 fee)',
  'event TaskRefunded(uint256 indexed recordId, address indexed payer, uint256 amount)',
];

// ===== RouterRegistry ABI =====
const RouterRegistryABI = [
  'function registerRouter(address pubKey, uint256 stakeAmount) external',
  'function deactivateRouter(address pubKey) external',
  'function reactivateRouter(address pubKey) external',
  'function submitVote(uint256 recordId, bytes32 decisionDigest) external',
  'function isActiveRouter(address pubKey) external view returns (bool)',
  'function activeRouterCount() external view returns (uint256)',
  'function quorumBps() external view returns (uint256)',
  'function getVotes(uint256 recordId, bytes32 decisionDigest) external view returns (uint256)',
  'function setQuorumBps(uint256 newQuorum) external',
  'event RouterRegistered(address indexed pubKey, uint256 stake)',
  'event RouterDeactivated(address indexed pubKey)',
  'event VoteSubmitted(uint256 indexed recordId, bytes32 decisionDigest, address indexed voter, uint256 newVotes, uint256 quorum)',
  'event ConsensusReached(uint256 indexed recordId, bytes32 decisionDigest, uint256 votes)',
];

// ===== ASBGovernor ABI =====
const ASBGovernorABI = [
  'function propose(address target, bytes calldata data, string calldata description) external returns (uint256)',
  'function castVote(uint256 proposalId, bool support) external',
  'function queue(uint256 proposalId) external',
  'function execute(uint256 proposalId) external',
  'function cancel(uint256 proposalId) external',
  'function state(uint256 proposalId) external view returns (uint8)',
  'function proposals(uint256 proposalId) external view returns (uint256 id, address proposer, address target, bytes memory data, string memory description, uint256 forVotes, uint256 againstVotes, uint256 createdAt, uint256 eta, bool executed, bool canceled)',
  'function proposalCount() external view returns (uint256)',
  'function setQuorumBps(uint256 v) external',
  'function setVotingPeriod(uint256 v) external',
  'function setTimelockDelay(uint256 v) external',
];

const ALL_ABIS = {
  AgentDID: AgentDIDABI,
  AuditLog: AuditLogABI,
  Reputation: ReputationABI,
  MockERC20: MockERC20ABI,
  AgentStake: AgentStakeABI,
  PaymentEscrow: PaymentEscrowABI,
  RouterRegistry: RouterRegistryABI,
  ASBGovernor: ASBGovernorABI,
};

module.exports = {
  AgentDIDABI, AuditLogABI, ReputationABI,
  MockERC20ABI, AgentStakeABI, PaymentEscrowABI,
  RouterRegistryABI, ASBGovernorABI,
  ALL_ABIS,
};
