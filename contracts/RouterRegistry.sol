// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RouterRegistry（M3 Service Mesh 化多 Router）
 * @notice 多 Router 公钥白名单；支持多 Router 共识投票聚合
 *
 * 用法：
 *   - owner 注册 Router：每个 Router 注册公钥 + 质押 stake
 *   - Router 决策后调用：submitVote(recordId, decisionDigest, sig)
 *   - 共识达成 ≥2/3 通过后 emit ConsensusReached 事件
 *   - Owner 可注销/替换 Router
 *
 * 共识规则（简化）：
 *   - quorumBps（默认 6667 = 2/3）Router 通过即共识达成
 *   - 共识结果以 (decisionDigest => votes) 聚合
 */
contract RouterRegistry is Ownable {
    struct RouterInfo {
        address pubKey;       // Router 签名公钥地址
        uint256 stake;        // 质押（防 Sybil）
        bool active;
        uint256 activeSince;
    }

    mapping(address => RouterInfo) public routers;  // pubKey => info
    address[] public routerList;
    uint256 public activeRouterCount;

    // 共识：(recordId, decisionDigest) => 同意票数
    mapping(bytes32 => uint256) public votes;  // keccak256(recordId, digest) => votes
    mapping(bytes32 => mapping(address => bool)) public hasVoted;

    uint256 public quorumBps = 6667;  // 2/3
    uint256 public constant MAX_QUORUM_BPS = 10000;

    event RouterRegistered(address indexed pubKey, uint256 stake);
    event RouterDeactivated(address indexed pubKey);
    event RouterReactivated(address indexed pubKey);
    event VoteSubmitted(uint256 indexed recordId, bytes32 decisionDigest, address indexed voter, uint256 newVotes, uint256 quorum);
    event ConsensusReached(uint256 indexed recordId, bytes32 decisionDigest, uint256 votes);
    event QuorumUpdated(uint256 newQuorumBps);

    constructor() Ownable(msg.sender) {}

    modifier onlyRouter() {
        require(routers[msg.sender].active, "Not active router");
        _;
    }

    function setQuorumBps(uint256 newQuorum) external onlyOwner {
        require(newQuorum > 0 && newQuorum <= MAX_QUORUM_BPS, "Invalid quorum");
        quorumBps = newQuorum;
        emit QuorumUpdated(newQuorum);
    }

    function registerRouter(address pubKey, uint256 stakeAmount) external onlyOwner {
        require(pubKey != address(0), "Zero pubKey");
        require(!routers[pubKey].active, "Already registered");
        routers[pubKey] = RouterInfo({
            pubKey: pubKey,
            stake: stakeAmount,
            active: true,
            activeSince: block.timestamp
        });
        routerList.push(pubKey);
        activeRouterCount++;
        emit RouterRegistered(pubKey, stakeAmount);
    }

    function deactivateRouter(address pubKey) external onlyOwner {
        require(routers[pubKey].active, "Not active");
        routers[pubKey].active = false;
        activeRouterCount--;
        emit RouterDeactivated(pubKey);
    }

    function reactivateRouter(address pubKey) external onlyOwner {
        require(routers[pubKey].pubKey != address(0), "Not registered");
        require(!routers[pubKey].active, "Already active");
        routers[pubKey].active = true;
        routers[pubKey].activeSince = block.timestamp;
        activeRouterCount++;
        emit RouterReactivated(pubKey);
    }

    function isActiveRouter(address pubKey) external view returns (bool) {
        return routers[pubKey].active;
    }

    function getRouters() external view returns (address[] memory) {
        return routerList;
    }

    /**
     * Router 投票某 recordId 的 decisionDigest
     * 一旦票数 ≥ quorum（按 activeRouterCount 算），emit ConsensusReached
     */
    function submitVote(uint256 recordId, bytes32 decisionDigest) external onlyRouter {
        bytes32 key = keccak256(abi.encode(recordId, decisionDigest));
        require(!hasVoted[key][msg.sender], "Already voted");
        hasVoted[key][msg.sender] = true;
        uint256 newVotes = ++votes[key];

        uint256 required = (activeRouterCount * quorumBps) / MAX_QUORUM_BPS;
        if (activeRouterCount == 0 || required == 0) required = 1;

        emit VoteSubmitted(recordId, decisionDigest, msg.sender, newVotes, required);
        if (newVotes >= required) {
            emit ConsensusReached(recordId, decisionDigest, newVotes);
        }
    }

    function getVotes(uint256 recordId, bytes32 decisionDigest) external view returns (uint256) {
        return votes[keccak256(abi.encode(recordId, decisionDigest))];
    }
}
