// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title AgentDID (改造 2 + 改造 4A)
 * @notice Agent 身份注册，绑定 owner ↔ address ↔ DID ↔ 资质
 *   - 改造 2：新增 `pubKey`：Agent 用于签名执行结果（链上 ecrecover 验证）
 *   - 改造 4A：新增 `verifyQualificationEIP712`：用 EIP-712 签名替代 `keccak256(nullifier, secretHash)` 哈希比较
 *     旧 verifyQualification / verifyAndUseQualification 保留以兼容历史
 */
contract AgentDID {
    using ECDSA for bytes32;
    struct Agent {
        address owner;
        string did;
        bytes32 commitment;        // keccak256(abi.encodePacked(nullifier, secretHash)) - 旧式 ZKP
        string qualificationType;
        bool isActive;
        uint256 registeredAt;
        address pubKey;            // 新增：Agent 签名公钥地址（用于 ecrecover）
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
        string qualificationType,
        address pubKey
    );

    event QualificationVerified(
        address indexed agent,
        bytes32 nullifier,
        bool success
    );

    event PubKeyUpdated(address indexed agent, address pubKey);

    modifier onlyRegisteredAgent(address agent) {
        require(agents[agent].owner != address(0), "Agent not registered");
        _;
    }

    // 注册时绑定 pubKey（向后兼容：传 address(0) 表示暂未绑定）
    function registerAgent(
        string calldata did,
        bytes32 commitment,
        string calldata qualificationType
    ) external {
        _registerAgent(did, commitment, qualificationType, address(0));
    }

    function registerAgentWithPubKey(
        string calldata did,
        bytes32 commitment,
        string calldata qualificationType,
        address pubKey
    ) external {
        require(pubKey != address(0), "pubKey cannot be zero");
        _registerAgent(did, commitment, qualificationType, pubKey);
    }

    function _registerAgent(
        string calldata did,
        bytes32 commitment,
        string calldata qualificationType,
        address pubKey
    ) internal {
        require(agents[msg.sender].owner == address(0), "Already registered");
        require(bytes(did).length > 0, "DID cannot be empty");
        require(commitment != bytes32(0), "Commitment cannot be empty");

        agents[msg.sender] = Agent({
            owner: msg.sender,
            did: did,
            commitment: commitment,
            qualificationType: qualificationType,
            isActive: true,
            registeredAt: block.timestamp,
            pubKey: pubKey
        });

        bytes32 didHash = keccak256(abi.encodePacked(did));
        ownerToDIDHash[msg.sender] = didHash;

        agentList.push(msg.sender);
        agentCount++;

        emit AgentRegistered(msg.sender, did, commitment, qualificationType, pubKey);
    }

    // 注册后更新公钥（演示用：本地测试 Agent 可注册后绑定公钥）
    function setPubKey(address pubKey) external {
        require(agents[msg.sender].owner != address(0), "Not registered");
        require(pubKey != address(0), "pubKey cannot be zero");
        agents[msg.sender].pubKey = pubKey;
        emit PubKeyUpdated(msg.sender, pubKey);
    }

    function getPubKey(address agent) external view returns (address) {
        require(agents[agent].owner != address(0), "Agent not found");
        return agents[agent].pubKey;
    }

    // ===== 资质验证（哈希模拟，保留以兼容） =====
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

    // ===== 改造 4A：EIP-712 签名资质验证 =====
    // EIP-712 domain（链上读不出当前合约地址用 address(this)）
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant QUALIFICATION_TYPEHASH = keccak256(
        "Qualification(address agent,bytes32 nullifier,bytes32 secretHash,uint256 deadline)"
    );

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes("ORACLE AgentDID")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    /**
     * @notice 验证 Agent 通过 EIP-712 签名证明自己掌握 secretHash
     * @param agent Agent 地址
     * @param nullifier 一次性标识符
     * @param secretHash 秘密哈希
     * @param deadline 过期时间
     * @param sig Agent 用其私钥签的 EIP-712 typed-data 签名
     * @return 是否验证通过
     */
    function verifyQualificationEIP712(
        address agent,
        bytes32 nullifier,
        bytes32 secretHash,
        uint256 deadline,
        bytes calldata sig
    ) external returns (bool) {
        require(block.timestamp <= deadline, "Signature expired");
        require(agents[agent].owner != address(0), "Agent not registered");
        require(!usedNullifiers[nullifier], "Nullifier already used");
        require(sig.length == 65, "Invalid sig length");

        bytes32 structHash = keccak256(abi.encode(
            QUALIFICATION_TYPEHASH,
            agent,
            nullifier,
            secretHash,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        address recovered = digest.recover(sig);
        require(recovered == agents[agent].pubKey, "Sig not from agent pubKey");

        usedNullifiers[nullifier] = true;
        emit QualificationVerified(agent, nullifier, true);
        return true;
    }

    // ===== 读取 =====
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
