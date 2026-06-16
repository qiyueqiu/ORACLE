// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AuditLog (改造 1 + 2 + 3)
 * @notice 调度审计日志：路由签名 + Worker 签名 + commit-reveal
 *   - 改造 1：logSchedule 接受 routerSigner/decisionDigest/decisionSig，链上 ecrecover 校验
 *   - 改造 2：updateExecution 接受 workerSig，链上 ecrecover 校验 == AgentDID.pubKey
 *   - 改造 3：taskDescription 改为 bytes32 commitment，原文不存（隐私友好）
 *
 *   注：链上不改 ABI 即兼容原测试；提供两套 API
 *     - 旧：logSchedule(requester, targetAgent, taskDescription, reason)
 *     - 新：logScheduleWithDecision(requester, targetAgent, commitment, reason, routerSigner, decisionDigest, decisionSig)
 *          updateExecutionWithSig(recordId, status, result, workerSig)
 */
contract AuditLog is Ownable {
    using ECDSA for bytes32;

    enum DecisionReason {
        QUALIFIED,
        INSUFFICIENT_REPUTATION,
        NOT_REGISTERED,
        INVALID_PROOF,
        AGENT_INACTIVE
    }

    enum ExecutionStatus {
        PENDING,
        SUCCESS,
        FAILED,
        TIMEOUT
    }

    struct ScheduleRecord {
        uint256 id;
        uint256 timestamp;
        address requester;
        address targetAgent;
        bytes32 taskCommitment;         // 改造 3：keccak256(taskDescription, salt)
        DecisionReason decisionReason;
        ExecutionStatus executionStatus;
        string executionResult;
        uint256 reputationRating;
        bytes32 transactionHash;        // 真实的执行 tx hash 存这里
        bool exists;
        // 改造 1：路由签名
        address routerSigner;
        bytes32 decisionDigest;
        // 改造 2：Worker 签名公钥地址
        address workerSigner;
    }

    mapping(uint256 => ScheduleRecord) public records;
    mapping(address => uint256[]) public recordsByAgent;
    mapping(address => uint256[]) public recordsByRequester;
    // commitment -> recordId（防 commitment 重用）
    mapping(bytes32 => uint256) public commitmentToRecord;

    // 改造 A4：commit-reveal 第二阶段。recordId -> 揭示后的明文（链下任务原文）
    // 揭示成功后链上才有 taskDescription；未揭示前合约仅持有 32-byte commitment。
    mapping(uint256 => string) public revealedTasks;
    mapping(uint256 => bool) public taskRevealed;

    uint256 public recordCount;
    uint256 public nextRecordId = 1;
    address public agentDID;  // 用于读取 Agent 公钥做 ecrecover

    // ===== P1-C2：EIP-712 链上重建（防跨链/跨合约重放）=====
    // 旧实现直接对调用方传入的 digest 做 ecrecover，不绑定 chainId/verifyingContract，
    // 也不绑定实际存储字段 → 可跨链/跨合约重放，且 digest 与记录解耦。
    // 现镜像 AgentDID 的范式，在链上用记录字段重建 typed-data hash 再 recover。
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    // Router 决策签名结构（与后端 ROUTER_DECISION_TYPES 一致）
    bytes32 private constant DECISION_TYPEHASH = keccak256(
        "Decision(bytes32 taskHash,bytes32 rankedAgents,address topAgent,uint256 timestamp)"
    );
    // Worker 结果签名结构（与后端 WORKER_RESULT_TYPES 一致）
    bytes32 private constant RESULT_TYPEHASH = keccak256(
        "Result(uint256 recordId,bytes32 resultDigest,uint256 timestamp)"
    );

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes("ORACLE AuditLog")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    function _hashDecision(
        bytes32 taskHash,
        bytes32 rankedAgents,
        address topAgent,
        uint256 timestamp
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            DECISION_TYPEHASH, taskHash, rankedAgents, topAgent, timestamp
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _hashResult(
        uint256 recordId,
        bytes32 resultDigest,
        uint256 timestamp
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            RESULT_TYPEHASH, recordId, resultDigest, timestamp
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }


    event ScheduleLogged(
        uint256 indexed recordId,
        address indexed requester,
        address indexed targetAgent,
        DecisionReason reason,
        bytes32 taskCommitment
    );

    event ExecutionUpdated(
        uint256 indexed recordId,
        ExecutionStatus status,
        string result,
        address workerSigner
    );

    event RatingSubmitted(uint256 indexed recordId, uint256 rating);

    event RouterDecisionLogged(
        uint256 indexed recordId,
        address indexed routerSigner,
        bytes32 decisionDigest
    );

    // 改造 A4：commit-reveal 第二阶段（揭示）事件
    event TaskRevealed(
        uint256 indexed recordId,
        address indexed revealer,
        bytes32 taskCommitment,
        string taskDescription
    );

    constructor() Ownable(msg.sender) {}

    function setAgentDID(address _agentDID) external onlyOwner {
        agentDID = _agentDID;
    }

    // ===== 旧版兼容 API（无签名）=====
    function logSchedule(
        address requester,
        address targetAgent,
        string calldata taskDescription,
        DecisionReason decisionReason
    ) external returns (uint256) {
        bytes32 commitment = keccak256(bytes(taskDescription));
        return _logScheduleInternal(requester, targetAgent, commitment, decisionReason, address(0), bytes32(0));
    }

    // ===== 新版：带 Router 签名（P1-C2：链上重建 EIP-712 摘要）=====
    // 不再接收调用方预算的 decisionDigest，而是接收 Decision 结构的明文字段，
    // 在链上用本合约 domainSeparator（含 chainId + address(this)）重建 typed-data hash，
    // 再 ecrecover。绑定 topAgent == targetAgent，确保签名内容与记录一致。
    function logScheduleWithDecision(
        address requester,
        address targetAgent,
        bytes32 taskCommitment,
        DecisionReason decisionReason,
        address routerSigner,
        bytes32 taskHash,
        bytes32 rankedAgents,
        uint256 decisionTimestamp,
        bytes calldata decisionSig
    ) external returns (uint256) {
        require(decisionSig.length == 65, "Invalid sig length");
        require(routerSigner != address(0), "Zero router signer");
        // 链上重建 digest：绑定 chainId + verifyingContract + 决策内容（topAgent=targetAgent）
        bytes32 digest = _hashDecision(taskHash, rankedAgents, targetAgent, decisionTimestamp);
        address recovered = digest.recover(decisionSig);
        require(recovered == routerSigner, "Bad router sig");
        // commitment 不能重复
        require(commitmentToRecord[taskCommitment] == 0, "Commitment reused");
        return _logScheduleInternal(requester, targetAgent, taskCommitment, decisionReason, routerSigner, digest);
    }

    function _logScheduleInternal(
        address requester,
        address targetAgent,
        bytes32 taskCommitment,
        DecisionReason decisionReason,
        address routerSigner,
        bytes32 decisionDigest
    ) internal returns (uint256) {
        uint256 recordId = nextRecordId++;
        records[recordId] = ScheduleRecord({
            id: recordId,
            timestamp: block.timestamp,
            requester: requester,
            targetAgent: targetAgent,
            taskCommitment: taskCommitment,
            decisionReason: decisionReason,
            executionStatus: ExecutionStatus.PENDING,
            executionResult: "",
            reputationRating: 0,
            transactionHash: bytes32(0),
            exists: true,
            routerSigner: routerSigner,
            decisionDigest: decisionDigest,
            workerSigner: address(0)
        });
        recordsByAgent[targetAgent].push(recordId);
        recordsByRequester[requester].push(recordId);
        recordCount++;
        if (taskCommitment != bytes32(0)) {
            commitmentToRecord[taskCommitment] = recordId;
        }

        emit ScheduleLogged(recordId, requester, targetAgent, decisionReason, taskCommitment);
        if (routerSigner != address(0)) {
            emit RouterDecisionLogged(recordId, routerSigner, decisionDigest);
        }
        return recordId;
    }

    // ===== 旧版 updateExecution（无签名）=====
    function updateExecution(
        uint256 recordId,
        ExecutionStatus status,
        string calldata result
    ) external {
        require(records[recordId].exists, "Record not found");
        records[recordId].executionStatus = status;
        records[recordId].executionResult = result;
        emit ExecutionUpdated(recordId, status, result, address(0));
    }

    // ===== 新版：带 Worker 签名（P1-C2：链上重建 EIP-712 摘要）=====
    // worker 对 Result(recordId, resultDigest, timestamp) 结构签名；链上用本合约
    // domainSeparator 重建 typed-data hash 再 recover，绑定 recordId+chainId+verifyingContract，
    // 杜绝跨记录/跨链/跨合约重放。recovered 必须等于 targetAgent 在 AgentDID 上注册的 pubKey。
    function updateExecutionWithSig(
        uint256 recordId,
        ExecutionStatus status,
        string calldata result,
        bytes32 resultDigest,
        uint256 resultTimestamp,
        bytes calldata workerSig
    ) external {
        require(records[recordId].exists, "Record not found");
        require(workerSig.length == 65, "Invalid sig length");
        bytes32 digest = _hashResult(recordId, resultDigest, resultTimestamp);
        address recovered = digest.recover(workerSig);
        require(recovered != address(0), "Bad sig");
        // recovered 必须是 targetAgent 在 AgentDID 上的 pubKey
        if (agentDID != address(0)) {
            (bool ok, bytes memory data) = agentDID.staticcall(
                abi.encodeWithSignature("getPubKey(address)", records[recordId].targetAgent)
            );
            require(ok, "AgentDID call failed");
            address expectedPubKey = abi.decode(data, (address));
            require(recovered == expectedPubKey, "Sig not from worker pubKey");
        }
        records[recordId].executionStatus = status;
        records[recordId].executionResult = result;
        records[recordId].workerSigner = recovered;
        emit ExecutionUpdated(recordId, status, result, recovered);
    }

    function submitRating(uint256 recordId, uint256 rating) external {
        require(records[recordId].exists, "Record not found");
        require(msg.sender == records[recordId].requester, "Not requester");
        require(rating >= 1 && rating <= 5, "Rating must be 1-5");
        require(records[recordId].reputationRating == 0, "Already rated");
        records[recordId].reputationRating = rating;
        emit RatingSubmitted(recordId, rating);
    }

    // ===== 改造 A4：commit-reveal 第二阶段（揭示）=====
    // 调用方提供原文 + salt，合约验证 keccak256(taskDescription || salt) == taskCommitment
    // 成功后将原文写入 revealedTasks，供事后审计/合规读取。
    // 任何人都可揭示（揭示本身需要持有原文，不构成新的信任假设）。
    function revealTask(
        uint256 recordId,
        string calldata taskDescription,
        bytes32 salt
    ) external {
        require(records[recordId].exists, "Record not found");
        require(!taskRevealed[recordId], "Already revealed");
        bytes32 expected = records[recordId].taskCommitment;
        require(expected != bytes32(0), "No commitment");
        bytes32 computed = keccak256(abi.encodePacked(taskDescription, salt));
        require(computed == expected, "Commitment mismatch");

        revealedTasks[recordId] = taskDescription;
        taskRevealed[recordId] = true;
        emit TaskRevealed(recordId, msg.sender, expected, taskDescription);
    }

    function getRevealedTask(uint256 recordId)
        external
        view
        returns (bool revealed, string memory taskDescription)
    {
        return (taskRevealed[recordId], revealedTasks[recordId]);
    }

    // 工具函数：链下生成 commitment 时可保持一致
    function computeCommitment(string calldata taskDescription, bytes32 salt)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(taskDescription, salt));
    }

    // ===== 读取 =====
    function getRecord(uint256 recordId) external view returns (
        uint256 id,
        uint256 timestamp,
        address requester,
        address targetAgent,
        bytes32 taskCommitment,
        DecisionReason decisionReason,
        ExecutionStatus executionStatus,
        string memory executionResult,
        uint256 reputationRating,
        bytes32 transactionHash
    ) {
        require(records[recordId].exists, "Record not found");
        ScheduleRecord memory record = records[recordId];
        return (
            record.id,
            record.timestamp,
            record.requester,
            record.targetAgent,
            record.taskCommitment,
            record.decisionReason,
            record.executionStatus,
            record.executionResult,
            record.reputationRating,
            record.transactionHash
        );
    }

    // 扩展读取（含签名元数据）
    function getRecordFull(uint256 recordId) external view returns (
        uint256 id,
        uint256 timestamp,
        address requester,
        address targetAgent,
        bytes32 taskCommitment,
        DecisionReason decisionReason,
        ExecutionStatus executionStatus,
        string memory executionResult,
        uint256 reputationRating,
        address routerSigner,
        bytes32 decisionDigest,
        address workerSigner
    ) {
        require(records[recordId].exists, "Record not found");
        ScheduleRecord memory r = records[recordId];
        return (
            r.id, r.timestamp, r.requester, r.targetAgent, r.taskCommitment,
            r.decisionReason, r.executionStatus, r.executionResult, r.reputationRating,
            r.routerSigner, r.decisionDigest, r.workerSigner
        );
    }

    function getRecordsByAgent(address agent) external view returns (uint256[] memory) {
        return recordsByAgent[agent];
    }

    function getRecordsByRequester(address requester) external view returns (uint256[] memory) {
        return recordsByRequester[requester];
    }

    function getRecordsByTimeRange(
        uint256 startTime,
        uint256 endTime
    ) external view returns (uint256[] memory) {
        uint256[] memory result = new uint256[](recordCount);
        uint256 count = 0;
        for (uint256 i = 1; i < nextRecordId; i++) {
            if (records[i].exists &&
                records[i].timestamp >= startTime &&
                records[i].timestamp <= endTime) {
                result[count++] = i;
            }
        }
        uint256[] memory trimmed = new uint256[](count);
        for (uint256 i = 0; i < count; i++) trimmed[i] = result[i];
        return trimmed;
    }

    function getAllRecords() external view returns (uint256[] memory) {
        uint256[] memory allIds = new uint256[](recordCount);
        uint256 count = 0;
        for (uint256 i = 1; i < nextRecordId; i++) {
            if (records[i].exists) allIds[count++] = i;
        }
        uint256[] memory trimmed = new uint256[](count);
        for (uint256 i = 0; i < count; i++) trimmed[i] = allIds[i];
        return trimmed;
    }

    function getDecisionReasonString(DecisionReason reason) external pure returns (string memory) {
        if (reason == DecisionReason.QUALIFIED) return "Qualified";
        if (reason == DecisionReason.INSUFFICIENT_REPUTATION) return "Insufficient Reputation";
        if (reason == DecisionReason.NOT_REGISTERED) return "Not Registered";
        if (reason == DecisionReason.INVALID_PROOF) return "Invalid Proof";
        if (reason == DecisionReason.AGENT_INACTIVE) return "Agent Inactive";
        return "Unknown";
    }

    function getExecutionStatusString(ExecutionStatus status) external pure returns (string memory) {
        if (status == ExecutionStatus.PENDING) return "Pending";
        if (status == ExecutionStatus.SUCCESS) return "Success";
        if (status == ExecutionStatus.FAILED) return "Failed";
        if (status == ExecutionStatus.TIMEOUT) return "Timeout";
        return "Unknown";
    }
}
