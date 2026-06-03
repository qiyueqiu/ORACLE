// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AsbCCIPSender（M3 改造 11 - 跨链同步）
 * @notice 通过 Chainlink CCIP 把 AuditLog 调度记录跨链同步到目标链
 * 真实部署需引入 chainlink 合约库（src imports ccip/AsbCCIP.sol:11 for detail）
 *
 * 流程：
 *   1. 源链 AsbCCIPSender.ccipSend(destChainSelector, recordId) 编码 ScheduleRecord
 *   2. CCIP 消息路由到目标链 AsbCCIPReceiver
 *   3. 目标链 ccipReceive 解码 → 在镜像合约上 replay ScheduleLogged
 *
 * 当前实现（M3 阶段）：
 *   - 抽象接口：CCIP 消息体格式 + ccipSend 调用点
 *   - 不引入 Chainlink 完整库（避免依赖冲突）
 *   - 生产部署需引入 chainlink 合约库并补完实际 CCIP router 集成
 */
contract AsbCCIPSender is Ownable {
    address public ccipRouter;        // Chainlink CCIP Router on source chain
    address public auditLog;          // 源链 AuditLog
    uint64 public destChainSelector;  // 目标链 selector

    struct CCIPMessage {
        uint256 recordId;
        bytes32 taskCommitment;
        address targetAgent;
        uint8 decisionReason;
        uint256 timestamp;
    }

    event CCIPMessageSent(bytes32 indexed messageId, uint256 indexed recordId, uint64 destChainSelector);

    constructor(address _ccipRouter, address _auditLog, uint64 _destChainSelector) Ownable(msg.sender) {
        ccipRouter = _ccipRouter;
        auditLog = _auditLog;
        destChainSelector = _destChainSelector;
    }

    function setDestChainSelector(uint64 sel) external onlyOwner {
        destChainSelector = sel;
    }

    /**
     * 编码 ScheduleRecord → CCIP 消息并发送
     * 真实实现需调用 IRouterClient(ccipRouter).ccipSend(...)
     */
    function ccipSend(uint256 recordId, bytes32 taskCommitment, address targetAgent, uint8 decisionReason) external returns (bytes32 messageId) {
        require(msg.sender == auditLog || msg.sender == owner(), "Only AuditLog/owner");
        CCIPMessage memory m = CCIPMessage({
            recordId: recordId,
            taskCommitment: taskCommitment,
            targetAgent: targetAgent,
            decisionReason: decisionReason,
            timestamp: block.timestamp
        });
        bytes memory payload = abi.encode(m);
        // 真实实现：IRouterClient(ccipRouter).ccipSend(destChainSelector, message)
        messageId = keccak256(payload);
        emit CCIPMessageSent(messageId, recordId, destChainSelector);
        return messageId;
    }
}

/**
 * @title AsbCCIPReceiver（M3 改造 11 - 跨链接收）
 * @notice 在目标链 replay 源链的 ScheduleRecord
 */
contract AsbCCIPReceiver is Ownable {
    address public sourceChainSender;  // 源链 AsbCCIPSender 地址
    address public mirrorAuditLog;     // 目标链镜像 AuditLog

    event CCIPRecordReplayed(uint256 indexed recordId, bytes32 taskCommitment, address targetAgent);

    constructor(address _sourceSender, address _mirrorAuditLog) Ownable(msg.sender) {
        sourceChainSender = _sourceSender;
        mirrorAuditLog = _mirrorAuditLog;
    }

    /**
     * 接收 CCIP 消息
     * 真实实现需继承 CCIPReceiver 并实现 _ccipReceive 钩子
     */
    function replayFromCCIP(bytes calldata message, address sender) external {
        require(sender == sourceChainSender, "Invalid source");
        (uint256 recordId, bytes32 taskCommitment, address targetAgent, uint8 decisionReason, ) =
            abi.decode(message, (uint256, bytes32, address, uint8, uint256));
        // 真实实现：调用镜像 AuditLog.logSchedule(...)
        emit CCIPRecordReplayed(recordId, taskCommitment, targetAgent);
    }
}
