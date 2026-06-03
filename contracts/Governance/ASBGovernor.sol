// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title ASBGovernor（M3 改造 8 - 链上治理）
 * @notice 简化版 Governor + 治理代币 + Timelock
 *
 * 范围（M3 阶段）：
 *   - 治理代币：ASBToken (ERC20Votes 简化版，按 stake 1:1 发放给 Router)
 *   - 提案：参数调整（阈值、权重、惩罚比例）、Router 白名单增删、合约升级授权
 *   - 投票：持币量加权
 *   - Timelock：执行延迟 24h
 *
 * 不引入完整 OZ Governor（依赖冲突）；提供与 OZ Governor 兼容的接口
 * （未来可平滑切换到 OZ Governor Bravo/Alpha）
 */
contract ASBGovernor is Ownable {
    struct Proposal {
        uint256 id;
        address proposer;
        address target;       // 目标合约
        bytes data;           // 调用数据
        string description;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 createdAt;
        uint256 eta;          // 执行解锁时间
        bool executed;
        bool canceled;
    }

    IERC20 public governanceToken;
    uint256 public proposalThreshold;     // 创建提案最低代币数
    uint256 public votingPeriod;          // 投票期（秒）
    uint256 public timelockDelay;         // 通过后延迟执行（秒）
    uint256 public quorumBps;             // 法定票数基点

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(address => uint256) public lastProposalTime;  // 防止刷提案

    enum ProposalState { Pending, Active, Defeated, Succeeded, Queued, Executed, Canceled }

    event ProposalCreated(uint256 indexed id, address indexed proposer, address target, string description);
    event VoteCast(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event ProposalQueued(uint256 indexed id, uint256 eta);
    event ProposalExecuted(uint256 indexed id);
    event ProposalCanceled(uint256 indexed id);

    constructor(IERC20 _token) Ownable(msg.sender) {
        governanceToken = _token;
        proposalThreshold = 100 * 1e18;
        votingPeriod = 3 days;
        timelockDelay = 1 days;
        quorumBps = 4000;  // 40%
    }

    function propose(address target, bytes calldata data, string calldata description) external returns (uint256) {
        require(governanceToken.balanceOf(msg.sender) >= proposalThreshold, "Below threshold");
        require(block.timestamp > lastProposalTime[msg.sender] + 1 hours, "Rate limited");
        uint256 id = ++proposalCount;
        proposals[id] = Proposal({
            id: id,
            proposer: msg.sender,
            target: target,
            data: data,
            description: description,
            forVotes: 0,
            againstVotes: 0,
            createdAt: block.timestamp,
            eta: 0,
            executed: false,
            canceled: false
        });
        lastProposalTime[msg.sender] = block.timestamp;
        emit ProposalCreated(id, msg.sender, target, description);
        return id;
    }

    function castVote(uint256 proposalId, bool support) external {
        Proposal storage p = proposals[proposalId];
        require(block.timestamp < p.createdAt + votingPeriod, "Voting ended");
        require(!hasVoted[proposalId][msg.sender], "Already voted");
        uint256 weight = governanceToken.balanceOf(msg.sender);
        if (support) p.forVotes += weight; else p.againstVotes += weight;
        hasVoted[proposalId][msg.sender] = true;
        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    function queue(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(block.timestamp >= p.createdAt + votingPeriod, "Voting not ended");
        require(p.executed == false && p.canceled == false, "Final state");
        uint256 total = p.forVotes + p.againstVotes;
        uint256 supply = governanceToken.totalSupply();
        require(total * 10000 >= supply * quorumBps, "Quorum not met");
        require(p.forVotes > p.againstVotes, "Defeated");
        p.eta = block.timestamp + timelockDelay;
        emit ProposalQueued(proposalId, p.eta);
    }

    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(p.eta > 0, "Not queued");
        require(block.timestamp >= p.eta, "Timelock not elapsed");
        require(!p.executed, "Already executed");
        p.executed = true;
        (bool ok, ) = p.target.call(p.data);
        require(ok, "Execution failed");
        emit ProposalExecuted(proposalId);
    }

    function cancel(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(msg.sender == p.proposer || msg.sender == owner(), "Not authorized");
        require(!p.executed, "Already executed");
        p.canceled = true;
        emit ProposalCanceled(proposalId);
    }

    function state(uint256 proposalId) external view returns (ProposalState) {
        Proposal storage p = proposals[proposalId];
        if (p.canceled) return ProposalState.Canceled;
        if (p.executed) return ProposalState.Executed;
        if (p.eta > 0 && block.timestamp >= p.eta) return ProposalState.Queued;
        if (block.timestamp < p.createdAt + votingPeriod) return ProposalState.Active;
        uint256 total = p.forVotes + p.againstVotes;
        uint256 supply = governanceToken.totalSupply();
        if (total * 10000 < supply * quorumBps) return ProposalState.Defeated;
        if (p.forVotes > p.againstVotes) return ProposalState.Succeeded;
        return ProposalState.Defeated;
    }

    // Owner 治理：调整参数
    function setProposalThreshold(uint256 v) external onlyOwner { proposalThreshold = v; }
    function setVotingPeriod(uint256 v) external onlyOwner { votingPeriod = v; }
    function setTimelockDelay(uint256 v) external onlyOwner { timelockDelay = v; }
    function setQuorumBps(uint256 v) external onlyOwner { quorumBps = v; }
}
