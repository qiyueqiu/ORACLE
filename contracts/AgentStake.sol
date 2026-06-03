// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AgentStake (改造 6)
 * @notice Worker 质押：注册时质押 ≥ MIN_STAKE；任务失败按 slashBps 比例 slash
 *
 * 扩展点：可由 DAO（M3 阶段）替代 owner 治理
 */
contract AgentStake is Ownable, ReentrancyGuard {
    IERC20 public immutable stakingToken;
    uint256 public minStake;          // 注册最低质押（token base units）
    uint256 public slashBps;          // slash 比例（基点 10000 = 100%）
    address public auditLog;          // AuditLog 合约地址（仅它能调 slash）

    mapping(address => uint256) public stakes;
    mapping(address => uint256) public slashedAmount;
    address[] public stakers;

    event Staked(address indexed agent, uint256 amount, uint256 newBalance);
    event Unstaked(address indexed agent, uint256 amount);
    event Slashed(address indexed agent, uint256 amount, string reason);
    event MinStakeUpdated(uint256 newMin);
    event SlashBpsUpdated(uint256 newBps);
    event AuditLogUpdated(address indexed newAuditLog);

    constructor(IERC20 _token) Ownable(msg.sender) {
        stakingToken = _token;
        minStake = 100 * 1e18;   // 默认 100 token
        slashBps = 1000;         // 默认 10%
        auditLog = address(0);
    }

    modifier onlyAuditLog() {
        require(msg.sender == auditLog, "Only AuditLog");
        _;
    }

    function setAuditLog(address _auditLog) external onlyOwner {
        auditLog = _auditLog;
        emit AuditLogUpdated(_auditLog);
    }

    function setMinStake(uint256 newMin) external onlyOwner {
        minStake = newMin;
        emit MinStakeUpdated(newMin);
    }

    function setSlashBps(uint256 newBps) external onlyOwner {
        require(newBps <= 10000, "Bps out of range");
        slashBps = newBps;
        emit SlashBpsUpdated(newBps);
    }

    /**
     * Agent 质押 / 追加质押
     */
    function stake(uint256 amount) external nonReentrant returns (uint256 newBalance) {
        require(amount > 0, "Zero amount");
        if (stakes[msg.sender] == 0) stakers.push(msg.sender);
        require(stakingToken.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        stakes[msg.sender] += amount;
        newBalance = stakes[msg.sender];
        emit Staked(msg.sender, amount, newBalance);
    }

    /**
     * Agent 提取质押（需先在 AuditLog 注销）
     */
    function unstake(uint256 amount) external nonReentrant {
        require(stakes[msg.sender] >= amount, "Insufficient stake");
        stakes[msg.sender] -= amount;
        require(stakingToken.transfer(msg.sender, amount), "Transfer failed");
        emit Unstaked(msg.sender, amount);
    }

    /**
     * 由 AuditLog 调用：任务失败 slash
     */
    function slash(address agent, string calldata reason) external onlyAuditLog nonReentrant returns (uint256) {
        uint256 cur = stakes[agent];
        if (cur == 0) return 0;
        uint256 slashAmount = (cur * slashBps) / 10000;
        stakes[agent] = cur - slashAmount;
        slashedAmount[agent] += slashAmount;
        // 转入 owner 财库（可后续改为销毁或回购）
        require(stakingToken.transfer(owner(), slashAmount), "Transfer failed");
        emit Slashed(agent, slashAmount, reason);
        return slashAmount;
    }

    function getStake(address agent) external view returns (uint256) {
        return stakes[agent];
    }

    function isStaked(address agent) external view returns (bool) {
        return stakes[agent] >= minStake;
    }

    function stakerCount() external view returns (uint256) {
        return stakers.length;
    }
}
