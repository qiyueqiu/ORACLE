// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract AuditLog {
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
        string taskDescription;
        DecisionReason decisionReason;
        ExecutionStatus executionStatus;
        string executionResult;
        uint256 reputationRating;
        bytes32 transactionHash;
        bool exists;
    }

    mapping(uint256 => ScheduleRecord) public records;
    mapping(address => uint256[]) public recordsByAgent;
    mapping(address => uint256[]) public recordsByRequester;

    uint256 public recordCount;
    uint256 public nextRecordId = 1;

    event ScheduleLogged(
        uint256 indexed recordId,
        address indexed requester,
        address indexed targetAgent,
        DecisionReason reason,
        string taskDescription
    );

    event ExecutionUpdated(
        uint256 indexed recordId,
        ExecutionStatus status,
        string result
    );

    event RatingSubmitted(
        uint256 indexed recordId,
        uint256 rating
    );

    function logSchedule(
        address requester,
        address targetAgent,
        string calldata taskDescription,
        DecisionReason decisionReason
    ) external returns (uint256) {
        uint256 recordId = nextRecordId++;

        records[recordId] = ScheduleRecord({
            id: recordId,
            timestamp: block.timestamp,
            requester: requester,
            targetAgent: targetAgent,
            taskDescription: taskDescription,
            decisionReason: decisionReason,
            executionStatus: ExecutionStatus.PENDING,
            executionResult: "",
            reputationRating: 0,
            transactionHash: bytes32(block.number),
            exists: true
        });

        recordsByAgent[targetAgent].push(recordId);
        recordsByRequester[requester].push(recordId);
        recordCount++;

        emit ScheduleLogged(recordId, requester, targetAgent, decisionReason, taskDescription);

        return recordId;
    }

    function updateExecution(
        uint256 recordId,
        ExecutionStatus status,
        string calldata result
    ) external {
        require(records[recordId].exists, "Record not found");
        records[recordId].executionStatus = status;
        records[recordId].executionResult = result;

        emit ExecutionUpdated(recordId, status, result);
    }

    function submitRating(uint256 recordId, uint256 rating) external {
        require(records[recordId].exists, "Record not found");
        require(msg.sender == records[recordId].requester, "Not requester");
        require(rating >= 1 && rating <= 5, "Rating must be 1-5");
        require(records[recordId].reputationRating == 0, "Already rated");

        records[recordId].reputationRating = rating;

        emit RatingSubmitted(recordId, rating);
    }

    function getRecord(uint256 recordId) external view returns (
        uint256 id,
        uint256 timestamp,
        address requester,
        address targetAgent,
        string memory taskDescription,
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
            record.taskDescription,
            record.decisionReason,
            record.executionStatus,
            record.executionResult,
            record.reputationRating,
            record.transactionHash
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

        // Resize to actual count
        uint256[] memory trimmedResult = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            trimmedResult[i] = result[i];
        }

        return trimmedResult;
    }

    function getAllRecords() external view returns (uint256[] memory) {
        uint256[] memory allIds = new uint256[](recordCount);
        uint256 count = 0;

        for (uint256 i = 1; i < nextRecordId; i++) {
            if (records[i].exists) {
                allIds[count++] = i;
            }
        }

        uint256[] memory trimmedResult = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            trimmedResult[i] = allIds[i];
        }

        return trimmedResult;
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
