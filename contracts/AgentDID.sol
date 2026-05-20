// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract AgentDID {
    struct Agent {
        address owner;
        string did;
        bytes32 commitment; // hash(secret, qualification)
        string qualificationType;
        bool isActive;
        uint256 registeredAt;
    }

    struct Proof {
        bytes32 nullifier;
        bytes32 secretHash;
        address agent;
        bool used;
    }

    mapping(address => Agent) public agents;
    mapping(bytes32 => bool) public usedCommitments;
    mapping(bytes32 => bool) public usedNullifiers;
    mapping(address => bytes32) public ownerToDIDHash;

    address[] public agentList;
    uint256 public agentCount;

    event AgentRegistered(
        address indexed owner,
        string did,
        bytes32 commitment,
        string qualificationType
    );

    event QualificationVerified(
        address indexed agent,
        bytes32 nullifier,
        bool success
    );

    modifier onlyRegisteredAgent(address agent) {
        require(agents[agent].owner != address(0), "Agent not registered");
        _;
    }

    function registerAgent(
        string calldata did,
        bytes32 commitment,
        string calldata qualificationType
    ) external {
        require(agents[msg.sender].owner == address(0), "Already registered");
        require(bytes(did).length > 0, "DID cannot be empty");
        require(commitment != bytes32(0), "Commitment cannot be empty");

        agents[msg.sender] = Agent({
            owner: msg.sender,
            did: did,
            commitment: commitment,
            qualificationType: qualificationType,
            isActive: true,
            registeredAt: block.timestamp
        });

        bytes32 didHash = keccak256(abi.encodePacked(did));
        ownerToDIDHash[msg.sender] = didHash;

        agentList.push(msg.sender);
        agentCount++;

        emit AgentRegistered(msg.sender, did, commitment, qualificationType);
    }

    function verifyQualification(
        bytes32 nullifier,
        bytes32 secretHash,
        bytes32 commitment
    ) external view returns (bool) {
        require(!usedNullifiers[nullifier], "Nullifier already used");

        bytes32 computedCommitment = keccak256(abi.encodePacked(nullifier, secretHash));
        return computedCommitment == commitment;
    }

    function verifyAndUseQualification(
        address agent,
        bytes32 nullifier,
        bytes32 secretHash
    ) external returns (bool) {
        require(agents[agent].owner != address(0), "Agent not registered");
        require(!usedNullifiers[nullifier], "Nullifier already used");

        bytes32 computedCommitment = keccak256(abi.encodePacked(nullifier, secretHash));
        require(computedCommitment == agents[agent].commitment, "Invalid qualification proof");

        usedNullifiers[nullifier] = true;

        emit QualificationVerified(agent, nullifier, true);
        return true;
    }

    function getAgent(address agentAddress) external view returns (
        address owner,
        string memory did,
        bytes32 commitment,
        string memory qualificationType,
        bool isActive,
        uint256 registeredAt
    ) {
        Agent memory agent = agents[agentAddress];
        require(agent.owner != address(0), "Agent not found");
        return (
            agent.owner,
            agent.did,
            agent.commitment,
            agent.qualificationType,
            agent.isActive,
            agent.registeredAt
        );
    }

    function getAllAgents() external view returns (address[] memory) {
        return agentList;
    }

    function isRegistered(address agent) external view returns (bool) {
        return agents[agent].owner != address(0);
    }

    function setAgentActive(address agent, bool isActive) external {
        require(msg.sender == agents[agent].owner, "Not owner");
        agents[agent].isActive = isActive;
    }

    function getCommitment(address agent) external view returns (bytes32) {
        require(agents[agent].owner != address(0), "Agent not found");
        return agents[agent].commitment;
    }
}
