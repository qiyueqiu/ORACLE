// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Reputation {
    struct AgentReputation {
        uint256 totalScore;
        uint256 ratingCount;
        uint256 averageRating;
        uint256 lastUpdated;
        bool exists;
    }

    mapping(address => AgentReputation) public reputations;
    address[] public agentList;

    uint256 public constant MIN_RATING = 0;
    uint256 public constant MAX_RATING = 100;
    uint256 public constant RELIABLE_THRESHOLD = 60;
    uint256 public constant HIGHLY_RELIABLE_THRESHOLD = 80;

    event ReputationUpdated(
        address indexed agent,
        uint256 newAverage,
        uint256 totalRatings
    );

    event ReputationPenalty(
        address indexed agent,
        uint256 penaltyAmount,
        string reason
    );

    function addRating(address agent, uint256 rating) external returns (uint256) {
        require(rating >= MIN_RATING && rating <= MAX_RATING, "Invalid rating");
        require(agent != address(0), "Invalid address");

        AgentReputation storage rep = reputations[agent];

        if (!rep.exists) {
            rep.exists = true;
            rep.totalScore = rating;
            rep.ratingCount = 1;
            rep.averageRating = rating;
            rep.lastUpdated = block.timestamp;
            agentList.push(agent);
        } else {
            rep.totalScore += rating;
            rep.ratingCount++;
            rep.averageRating = rep.totalScore / rep.ratingCount;
            rep.lastUpdated = block.timestamp;
        }

        emit ReputationUpdated(agent, rep.averageRating, rep.ratingCount);

        return rep.averageRating;
    }

    function getReputation(address agent) external view returns (
        uint256 totalScore,
        uint256 ratingCount,
        uint256 averageRating,
        uint256 lastUpdated
    ) {
        AgentReputation memory rep = reputations[agent];
        return (
            rep.totalScore,
            rep.ratingCount,
            rep.averageRating,
            rep.lastUpdated
        );
    }

    function getAverageRating(address agent) external view returns (uint256) {
        return reputations[agent].averageRating;
    }

    function isReliable(address agent) external view returns (bool) {
        return reputations[agent].averageRating >= RELIABLE_THRESHOLD &&
               reputations[agent].ratingCount >= 3;
    }

    function meetsThreshold(address agent, uint256 threshold) external view returns (bool) {
        return reputations[agent].averageRating >= threshold;
    }

    function applyPenalty(address agent, uint256 penalty, string calldata reason) external {
        require(reputations[agent].exists, "Agent not found");
        require(penalty > 0 && penalty <= MAX_RATING, "Invalid penalty");

        AgentReputation storage rep = reputations[agent];

        if (rep.totalScore > penalty) {
            rep.totalScore -= penalty;
        } else {
            rep.totalScore = 1;
        }

        rep.averageRating = rep.totalScore / rep.ratingCount;
        rep.lastUpdated = block.timestamp;

        emit ReputationPenalty(agent, penalty, reason);
    }

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
}
