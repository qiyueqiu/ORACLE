// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice AgentStake 的最小只读接口（评分权重按质押计价时读取质押额）。
 */
interface IAgentStake {
    function getStake(address agent) external view returns (uint256);
}

/**
 * @title Reputation (改造 5)
 * @notice 百分制信誉系统，支持：
 *   - 评分权重：rater 自身信誉分越高，权重越大（防 Sybil）
 *   - 时间衰减：e^(-Δt / halfLife)，halfLife 由 owner 设置
 *   - 评分权限：可由 owner 收紧为白名单
 *   - 整数平方根（防溢出）
 *   - 质押绑定评分权重（rateStakeWeighted）：权重 = 质押 / 单位，线性且守恒，
 *     破解 √ 加权的拆分有利性与廉价 Sybil（论文 §4.3 A 层）
 *
 * 向后兼容：保留旧 addRating/getReputation 签名；新增 rateWeighted/timeDecayed/isReliableWeighted。
 */
contract Reputation is Ownable {
    struct AgentReputation {
        uint256 totalScore;     // 累计评分（加权后）
        uint256 weightSum;      // 累计权重
        uint256 ratingCount;    // 评分次数
        uint256 averageRating;  // 加权平均
        uint256 lastUpdated;
        bool exists;
    }

    // ===== 配置 =====
    uint256 public constant MIN_RATING = 0;
    uint256 public constant MAX_RATING = 100;
    uint256 public constant RELIABLE_THRESHOLD = 60;
    uint256 public constant HIGHLY_RELIABLE_THRESHOLD = 80;
    uint256 public constant MIN_RATINGS_FOR_RELIABLE = 3;
    uint256 public halfLifeSeconds;            // 衰减半衰期（秒）
    uint256 public minRaterReputation;         // 评分者自身信誉门槛
    bool public restrictRaters;                // 是否仅白名单可评分

    // ===== 质押绑定评分权重（论文 §4.3 A 层）=====
    // weight = raterStake / stakeWeightUnit。质押线性且守恒：拆分一份质押到多账户，
    // 各账户权重之和不变（≤ 原权重），拆分零获利；无质押者权重 0，廉价 Sybil 失效。
    // 这与 √ 加权（拆分有利、新账户白送权重 1）形成对照，破解 Bennett 凹函数不可能性。
    IAgentStake public agentStake;             // 质押源（AgentStake）
    uint256 public stakeWeightUnit;            // 每单位权重对应的质押额（token base units）

    mapping(address => AgentReputation) public reputations;
    mapping(address => bool) public authorizedRater;
    address[] public agentList;

    event ReputationUpdated(
        address indexed agent,
        uint256 newAverage,
        uint256 totalRatings,
        uint256 appliedWeight
    );

    event ReputationPenalty(
        address indexed agent,
        uint256 penaltyAmount,
        string reason
    );

    event RaterAuthorized(address indexed rater, bool allowed);
    event ConfigUpdated(uint256 halfLifeSeconds, uint256 minRaterReputation, bool restrictRaters);
    event StakeWeightConfigUpdated(address indexed agentStake, uint256 stakeWeightUnit);

    constructor() Ownable(msg.sender) {
        halfLifeSeconds = 30 days;
        minRaterReputation = 0;
        restrictRaters = false;
        stakeWeightUnit = 1e18;   // 默认 1 token = 1 单位权重
    }

    // ===== 旧版兼容：addRating 任意地址（权重 1，但同样遵守 restrictRaters） =====
    function addRating(address agent, uint256 rating) external returns (uint256) {
        if (restrictRaters) {
            require(authorizedRater[msg.sender], "Not authorized rater");
        }
        return _addRatingWeighted(agent, rating, 1);
    }

    // ===== 新版：rater 带权重评分 =====
    function rateWeighted(address agent, uint256 rating) external returns (uint256) {
        if (restrictRaters) {
            require(authorizedRater[msg.sender], "Not authorized rater");
        }
        require(rating >= MIN_RATING && rating <= MAX_RATING, "Invalid rating");
        require(agent != address(0), "Invalid address");
        if (minRaterReputation > 0) {
            require(reputations[msg.sender].averageRating >= minRaterReputation, "Low rater rep");
        }
        uint256 raterAvg = reputations[msg.sender].averageRating;
        uint256 weight = raterAvg == 0 ? 1 : _sqrt(raterAvg);
        return _addRatingWeighted(agent, rating, weight);
    }

    // ===== 质押绑定评分（论文 §4.3 A 层）=====
    // 权重 = raterStake / stakeWeightUnit（线性、守恒）。相较 rateWeighted 的 √ 加权：
    //   - 廉价 Sybil：无质押 → weight 0 → revert，零成本刷分被彻底关闭；
    //   - 账户拆分：把 S 的质押拆到 k 个账户，Σ⌊Sᵢ/U⌋ ≤ ⌊S/U⌋，拆分不获利（守恒），
    //     与 √ 加权下 4×⌊√25⌋=20 > ⌊√100⌋=10 的拆分有利性正好相反。
    // 要求已配置 agentStake；评分者须有质押。仍受 restrictRaters/minRaterReputation 约束。
    function rateStakeWeighted(address agent, uint256 rating) external returns (uint256) {
        require(address(agentStake) != address(0), "Stake source unset");
        if (restrictRaters) {
            require(authorizedRater[msg.sender], "Not authorized rater");
        }
        require(rating >= MIN_RATING && rating <= MAX_RATING, "Invalid rating");
        require(agent != address(0), "Invalid address");
        if (minRaterReputation > 0) {
            require(reputations[msg.sender].averageRating >= minRaterReputation, "Low rater rep");
        }
        uint256 weight = agentStake.getStake(msg.sender) / stakeWeightUnit;
        require(weight > 0, "No stake weight");
        return _addRatingWeighted(agent, rating, weight);
    }

    function _addRatingWeighted(address agent, uint256 rating, uint256 weight) internal returns (uint256) {
        require(rating >= MIN_RATING && rating <= MAX_RATING, "Invalid rating");
        require(agent != address(0), "Invalid address");
        require(weight > 0, "Zero weight");

        AgentReputation storage rep = reputations[agent];
        uint256 newAvg;
        if (!rep.exists) {
            rep.exists = true;
            rep.totalScore = rating * weight;
            rep.weightSum = weight;
            rep.ratingCount = 1;
            newAvg = rating;
            agentList.push(agent);
        } else {
            rep.totalScore += rating * weight;
            rep.weightSum += weight;
            rep.ratingCount++;
            newAvg = rep.totalScore / rep.weightSum;
        }
        rep.averageRating = newAvg;
        rep.lastUpdated = block.timestamp;

        emit ReputationUpdated(agent, newAvg, rep.ratingCount, weight);
        return newAvg;
    }

    // ===== 读取（兼容旧版） =====
    function getReputation(address agent) external view returns (
        uint256 totalScore,
        uint256 ratingCount,
        uint256 averageRating,
        uint256 lastUpdated
    ) {
        AgentReputation memory rep = reputations[agent];
        return (rep.totalScore, rep.ratingCount, rep.averageRating, rep.lastUpdated);
    }

    function getAverageRating(address agent) external view returns (uint256) {
        return reputations[agent].averageRating;
    }

    function isReliable(address agent) public view returns (bool) {
        return reputations[agent].averageRating >= RELIABLE_THRESHOLD &&
               reputations[agent].ratingCount >= MIN_RATINGS_FOR_RELIABLE;
    }

    function meetsThreshold(address agent, uint256 threshold) external view returns (bool) {
        return reputations[agent].averageRating >= threshold;
    }

    // ===== 新版：时间衰减后的 effective rating =====
    // 指数衰减 decay(Δt) = averageRating · 2^(-Δt/halfLife)，实现论文公式 (2) e^(-λΔt)（λ=ln2/τ）。
    // Solidity 无浮点：将 Δt 拆为「整数个半衰期 n」+「余数 r」。
    //   2^(-Δt/τ) = 2^(-n) · 2^(-r/τ)
    // 整数部分用移位精确减半；余数部分 2^(-r/τ)（r/τ∈[0,1)）用割线下界近似 1 - 0.5·(r/τ)，
    // 在单个半衰期内连接 (0,1) 与 (1,0.5)。该近似单调、连续，无旧实现的 30 天硬归零悬崖——
    // 信誉随时间平滑趋近 0（永不人为置 0，也不设非零下限：不活跃 Agent 不应永久保留信誉）。
    uint256 public constant DECAY_PRECISION = 1e18;

    function timeDecayed(address agent) public view returns (uint256) {
        AgentReputation memory rep = reputations[agent];
        if (rep.ratingCount == 0) return 0;
        if (halfLifeSeconds == 0) return rep.averageRating;
        uint256 dt = block.timestamp > rep.lastUpdated ? block.timestamp - rep.lastUpdated : 0;
        if (dt == 0) return rep.averageRating;

        // 整数个半衰期：每个精确减半（右移）
        uint256 nHalfLives = dt / halfLifeSeconds;
        uint256 remainder = dt % halfLifeSeconds;

        // factor 以 1e18 为基准（=1.0）
        uint256 factor = DECAY_PRECISION;
        // 限制移位次数，避免无意义的长循环；>=256 个半衰期后已衰减到尘埃（factor=0）
        if (nHalfLives >= 256) {
            return 0;
        }
        factor >>= nHalfLives; // 乘以 2^(-nHalfLives)

        // 余数部分：2^(-remainder/halfLife) ≈ 1 - 0.5 · (remainder/halfLife)
        // remainder/halfLife ∈ [0,1)，割线连接 (0,1) 与 (1,0.5)
        if (remainder > 0) {
            uint256 fracDecayBps = (remainder * 5000) / halfLifeSeconds; // 0.5·frac，单位 bps
            factor = (factor * (10000 - fracDecayBps)) / 10000;
        }

        return (rep.averageRating * factor) / DECAY_PRECISION;
    }

    function isReliableWeighted(address agent) external view returns (bool) {
        return timeDecayed(agent) >= RELIABLE_THRESHOLD &&
               reputations[agent].ratingCount >= MIN_RATINGS_FOR_RELIABLE;
    }

    // ===== Penalty（仅 owner，可防止任意 slash） =====
    function applyPenalty(address agent, uint256 penalty, string calldata reason) external onlyOwner {
        require(reputations[agent].exists, "Agent not found");
        require(penalty > 0 && penalty <= MAX_RATING, "Invalid penalty");

        AgentReputation storage rep = reputations[agent];
        if (rep.totalScore > penalty * rep.weightSum) {
            rep.totalScore -= penalty * rep.weightSum;
        } else {
            rep.totalScore = 1;
        }
        rep.averageRating = rep.weightSum == 0 ? 0 : rep.totalScore / rep.weightSum;
        rep.lastUpdated = block.timestamp;

        emit ReputationPenalty(agent, penalty, reason);
    }

    // ===== Owner 治理 =====
    function setHalfLife(uint256 newHalfLife) external onlyOwner {
        halfLifeSeconds = newHalfLife;
        emit ConfigUpdated(newHalfLife, minRaterReputation, restrictRaters);
    }

    function setMinRaterReputation(uint256 newMin) external onlyOwner {
        minRaterReputation = newMin;
        emit ConfigUpdated(halfLifeSeconds, newMin, restrictRaters);
    }

    function setRestrictRaters(bool restrict) external onlyOwner {
        restrictRaters = restrict;
        emit ConfigUpdated(halfLifeSeconds, minRaterReputation, restrict);
    }

    function setAuthorizedRater(address rater, bool allowed) external onlyOwner {
        authorizedRater[rater] = allowed;
        emit RaterAuthorized(rater, allowed);
    }

    // 配置质押绑定评分权重的来源与计价单位（论文 §4.3 A 层）。
    function setAgentStake(address _agentStake) external onlyOwner {
        agentStake = IAgentStake(_agentStake);
        emit StakeWeightConfigUpdated(_agentStake, stakeWeightUnit);
    }

    function setStakeWeightUnit(uint256 newUnit) external onlyOwner {
        require(newUnit > 0, "Zero unit");
        stakeWeightUnit = newUnit;
        emit StakeWeightConfigUpdated(address(agentStake), newUnit);
    }

    // ===== 批量查询 =====
    function getAllReputations() external view returns (
        address[] memory addresses,
        uint256[] memory averages
    ) {
        addresses = new address[](agentList.length);
        averages = new uint256[](agentList.length);
        for (uint256 i = 0; i < agentList.length; i++) {
            addresses[i] = agentList[i];
            averages[i] = reputations[agentList[i]].averageRating;
        }
        return (addresses, averages);
    }

    function getTopAgents(uint256 limit) external view returns (
        address[] memory addresses,
        uint256[] memory averages
    ) {
        uint256 actualLimit = limit > agentList.length ? agentList.length : limit;
        address[] memory sortedAgents = new address[](agentList.length);
        uint256[] memory sortedScores = new uint256[](agentList.length);
        for (uint256 i = 0; i < agentList.length; i++) {
            sortedAgents[i] = agentList[i];
            sortedScores[i] = reputations[agentList[i]].averageRating;
        }
        for (uint256 i = 0; i < agentList.length - 1; i++) {
            for (uint256 j = 0; j < agentList.length - i - 1; j++) {
                if (sortedScores[j] < sortedScores[j + 1]) {
                    (sortedScores[j], sortedScores[j + 1]) = (sortedScores[j + 1], sortedScores[j]);
                    (sortedAgents[j], sortedAgents[j + 1]) = (sortedAgents[j + 1], sortedAgents[j]);
                }
            }
        }
        addresses = new address[](actualLimit);
        averages = new uint256[](actualLimit);
        for (uint256 i = 0; i < actualLimit; i++) {
            addresses[i] = sortedAgents[i];
            averages[i] = sortedScores[i];
        }
        return (addresses, averages);
    }

    function getAgentCount() external view returns (uint256) {
        return agentList.length;
    }

    function hasReputation(address agent) external view returns (bool) {
        return reputations[agent].exists;
    }

    // ===== Helpers =====
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}
