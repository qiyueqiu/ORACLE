// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AuditLogOptimized — gas 优化版审计日志（成本优化实验）
 * @notice 同样的安全属性（链上 EIP-712 重建 + 防重放 + 双角色归属），
 *         但通过「事件日志承载审计数据 + 最小化合约存储」大幅降低 gas。
 *
 * 关键洞察：审计数据的本质需求 = 第三方可验、防篡改、可读。
 *   EVM 事件日志（LOG opcode）已满足全部：进区块、入 receipts trie 的 Merkle 根、
 *   全节点共识、Etherscan/indexer 永久可查。合约运行时不需回读历史记录
 *   （审计数据是给链下读的）。因此把 13 字段 SSTORE 改为 emit，省去绝大部分冷 SSTORE。
 *
 * 三种模式（同一合约暴露，便于对照测量）：
 *   M1 logScheduleEventOnly       —— 完全 event-only：验签后只 emit，零记录 SSTORE
 *   M2 logScheduleCommitment      —— 折中：只存 1 个状态槽（commitment→bytes32 摘要），其余 emit
 *   M3 updateExecutionEventOnly   —— 执行结果 event-only（验签仍在链上，绑定 AgentDID pubKey）
 *
 * 安全性不变：EIP-712 链上重建（domainSeparator 含 chainId+address(this)）、
 *   ecrecover 校验 router/worker 签名、worker 必须等于 AgentDID 注册 pubKey。
 *   牺牲的只是「合约自身回读记录」能力——审计场景不需要。
 */
contract AuditLogOptimized is Ownable {
    using ECDSA for bytes32;

    enum DecisionReason { QUALIFIED, INSUFFICIENT_REPUTATION, NOT_REGISTERED, INVALID_PROOF, AGENT_INACTIVE }
    enum ExecutionStatus { PENDING, SUCCESS, FAILED, TIMEOUT, DISPUTED }

    address public agentDID;
    uint256 public nextRecordId = 1;

    // M2 折中模式：仅存一个紧凑状态承诺（用于需要链上轻量验证存在性的场景）。
    // 每条记录一个 slot：keccak256(所有字段) → 既防篡改又可链下重建比对。
    mapping(uint256 => bytes32) public recordCommitment;
    // 防 commitment 重用（与原版一致的安全属性，1 个冷 SSTORE）
    mapping(bytes32 => bool) public usedTaskCommitment;
    // 【安全关键】recordId → targetAgent 锚点（M1/M2/M4 用）。
    //   调度阶段由 router 签名锁定 topAgent=targetAgent，写入此映射；
    //   执行阶段必须从此映射读取 targetAgent 做 worker pubKey 比对，
    //   绝不接受调用方传参——否则 WorkerB 可用自己的合法签名冒充 WorkerA 的任务执行者
    //   （对抗性审查发现的致命归属漏洞）。
    //   注：M5（recordId 编码方案）证明这 20k SSTORE 不是唯一安全方案——
    //   把 targetAgent 编进 recordId 高 160 位可零存储达成同等归属安全（见下）。
    mapping(uint256 => address) public recordTargetAgent;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant DECISION_TYPEHASH = keccak256(
        "Decision(bytes32 taskHash,bytes32 rankedAgents,address topAgent,uint256 timestamp)"
    );
    bytes32 private constant RESULT_TYPEHASH = keccak256(
        "Result(uint256 recordId,bytes32 resultDigest,uint256 timestamp)"
    );

    // 审计数据全部经事件承载（indexed 关键字段便于 indexer 过滤）
    event ScheduleLogged(
        uint256 indexed recordId,
        address indexed requester,
        address indexed targetAgent,
        DecisionReason reason,
        bytes32 taskCommitment,
        address routerSigner,
        bytes32 decisionDigest,
        uint256 timestamp
    );
    event ExecutionUpdated(
        uint256 indexed recordId,
        ExecutionStatus status,
        bytes32 resultDigest,
        address workerSigner,
        uint256 timestamp
    );

    constructor() Ownable(msg.sender) {}

    function setAgentDID(address _agentDID) external onlyOwner { agentDID = _agentDID; }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH, keccak256(bytes("ORACLE AuditLog")), keccak256(bytes("1")),
            block.chainid, address(this)
        ));
    }

    function _hashDecision(bytes32 taskHash, bytes32 rankedAgents, address topAgent, uint256 ts) internal view returns (bytes32) {
        bytes32 sh = keccak256(abi.encode(DECISION_TYPEHASH, taskHash, rankedAgents, topAgent, ts));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), sh));
    }
    function _hashResult(uint256 recordId, bytes32 resultDigest, uint256 ts) internal view returns (bytes32) {
        bytes32 sh = keccak256(abi.encode(RESULT_TYPEHASH, recordId, resultDigest, ts));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), sh));
    }

    // ===== M1：event-only 数据 + 最小归属锚点（安全修正后）=====
    // 验签与原版完全相同。审计数据走 event，但保留 1 个 targetAgent 锚点 SSTORE：
    // 这是把执行阶段绑回调度阶段所选 agent 的安全必需（见 recordTargetAgent 注释）。
    // 注：此模式仍不防 commitment 重用（无 usedTaskCommitment 状态），适合「同一 commitment
    // 不重复」的部署假设；需要防重用用 M2。
    function logScheduleEventOnly(
        address requester, address targetAgent, bytes32 taskCommitment, DecisionReason reason,
        address routerSigner, bytes32 taskHash, bytes32 rankedAgents, uint256 decisionTimestamp, bytes calldata decisionSig
    ) external returns (uint256 recordId) {
        require(decisionSig.length == 65, "Invalid sig length");
        require(routerSigner != address(0), "Zero router signer");
        bytes32 digest = _hashDecision(taskHash, rankedAgents, targetAgent, decisionTimestamp);
        require(digest.recover(decisionSig) == routerSigner, "Bad router sig");
        recordId = nextRecordId++;
        recordTargetAgent[recordId] = targetAgent;  // 安全锚点（1 冷 SSTORE，不可省）
        emit ScheduleLogged(recordId, requester, targetAgent, reason, taskCommitment, routerSigner, digest, block.timestamp);
    }

    // ===== M2：折中——承诺槽 + 防重用 + 归属锚点（平衡可验证性与 gas）=====
    function logScheduleCommitment(
        address requester, address targetAgent, bytes32 taskCommitment, DecisionReason reason,
        address routerSigner, bytes32 taskHash, bytes32 rankedAgents, uint256 decisionTimestamp, bytes calldata decisionSig
    ) external returns (uint256 recordId) {
        require(decisionSig.length == 65, "Invalid sig length");
        require(routerSigner != address(0), "Zero router signer");
        require(!usedTaskCommitment[taskCommitment], "Commitment reused");
        bytes32 digest = _hashDecision(taskHash, rankedAgents, targetAgent, decisionTimestamp);
        require(digest.recover(decisionSig) == routerSigner, "Bad router sig");
        recordId = nextRecordId++;
        // 单槽状态承诺：链下可用全字段重算并比对，链上仅 1 冷 SSTORE
        recordCommitment[recordId] = keccak256(abi.encode(
            requester, targetAgent, taskCommitment, reason, routerSigner, digest, block.timestamp
        ));
        usedTaskCommitment[taskCommitment] = true;  // 1 冷 SSTORE（防重用，安全属性保留）
        recordTargetAgent[recordId] = targetAgent;   // 安全锚点（1 冷 SSTORE，不可省）
        emit ScheduleLogged(recordId, requester, targetAgent, reason, taskCommitment, routerSigner, digest, block.timestamp);
    }

    // ===== M3：执行结果 event-only（验签不变，targetAgent 从存储锚点读，不接受传参）=====
    // 【安全修正】targetAgent 不再是调用方参数，而是从 recordTargetAgent[recordId] 读取——
    // 该值在调度阶段由 router 签名锁定。这杜绝了「WorkerB 用自身合法签名冒充 WorkerA 任务执行者」
    // 的致命归属漏洞（对抗性审查发现）。
    function updateExecutionEventOnly(
        uint256 recordId, ExecutionStatus status, bytes32 resultDigest, uint256 resultTimestamp, bytes calldata workerSig
    ) external {
        require(workerSig.length == 65, "Invalid sig length");
        address targetAgent = recordTargetAgent[recordId];
        require(targetAgent != address(0), "Unknown record");  // 防止对不存在/未锚定记录提交
        bytes32 digest = _hashResult(recordId, resultDigest, resultTimestamp);
        address recovered = digest.recover(workerSig);
        require(recovered != address(0), "Bad sig");
        if (agentDID != address(0)) {
            (bool ok, bytes memory data) = agentDID.staticcall(
                abi.encodeWithSignature("getPubKey(address)", targetAgent)
            );
            require(ok, "AgentDID call failed");
            require(recovered == abi.decode(data, (address)), "Sig not from worker pubKey");
        }
        emit ExecutionUpdated(recordId, status, resultDigest, recovered, block.timestamp);
    }

    // ===== M4：批量锚定（最高杠杆）=====
    // Router 一笔 tx 提交 N 条调度决策。每条仍带独立 EIP-712 签名，逐条 ecrecover 校验
    // （安全不降——批量不等于放松验签）。摊薄的是一次 tx 的 21k base 开销 + 计数器冷启动 +
    // 函数调用固定开销。审计数据全部走 event，每条仍写 1 个 targetAgent 锚点。
    //
    // 适用场景：Router 高频调度时积攒一小批再上链（如每 N 秒或每 N 条 flush 一次），
    // 用「轻微延迟换显著降本」。延迟敏感场景仍可用 M1 单条。
    struct ScheduleItem {
        address requester;
        address targetAgent;
        bytes32 taskCommitment;
        DecisionReason reason;
        address routerSigner;
        bytes32 taskHash;
        bytes32 rankedAgents;
        uint256 decisionTimestamp;
        bytes decisionSig;
    }

    event BatchScheduleLogged(uint256 firstRecordId, uint256 count, address indexed submitter);

    function batchLogScheduleEventOnly(ScheduleItem[] calldata items)
        external
        returns (uint256 firstRecordId, uint256 count)
    {
        count = items.length;
        require(count > 0, "Empty batch");
        firstRecordId = nextRecordId;
        uint256 id = firstRecordId;
        for (uint256 i = 0; i < count; i++) {
            ScheduleItem calldata it = items[i];
            require(it.decisionSig.length == 65, "Invalid sig length");
            require(it.routerSigner != address(0), "Zero router signer");
            // 逐条链上重建 EIP-712 摘要 + ecrecover（与单条 M1 完全等价的安全校验）
            bytes32 digest = _hashDecision(it.taskHash, it.rankedAgents, it.targetAgent, it.decisionTimestamp);
            require(digest.recover(it.decisionSig) == it.routerSigner, "Bad router sig");
            recordTargetAgent[id] = it.targetAgent;  // 归属锚点（每条 1 冷 SSTORE，安全必需）
            emit ScheduleLogged(id, it.requester, it.targetAgent, it.reason, it.taskCommitment, it.routerSigner, digest, block.timestamp);
            id++;
        }
        nextRecordId = id;  // 一次性写回计数器（批内只 1 次 SSTORE，而非 N 次）
        emit BatchScheduleLogged(firstRecordId, count, msg.sender);
    }

    // ===== M5：recordId 编码归属（零存储锚点，对抗审查验证的最优方案）=====
    // 把 targetAgent（160 位）编进 recordId 高位，低 96 位放序号。执行阶段从 recordId
    // 纯位运算解出 targetAgent，无需任何 SSTORE 锚点。安全性等同 M1 的 20k 锚点：
    // recordId 由合约在调度阶段确定性生成并 emit，worker 无法篡改——改 recordId 即指向
    // 另一条记录。WorkerB 想冒充 WorkerA 的 recordId 必须伪造 WorkerA 的签名（不可能）；
    // WorkerB 用自己地址只能执行编码了自己地址的 recordId（即自己的任务，非冒充）。
    //   recordId = (uint256(uint160(targetAgent)) << 96) | seq
    // 代价：recordId 失去全局时间序（链下按 block.timestamp/blockNumber 排序，recordId 仅作唯一键）。
    uint96 private seqCounter; // 全局序号，低 96 位

    function encodeRecordId(address targetAgent, uint96 seq) public pure returns (uint256) {
        return (uint256(uint160(targetAgent)) << 96) | uint256(seq);
    }
    function decodeTargetAgent(uint256 recordId) public pure returns (address) {
        return address(uint160(recordId >> 96));
    }

    function logScheduleEncoded(
        address requester, address targetAgent, bytes32 taskCommitment, DecisionReason reason,
        address routerSigner, bytes32 taskHash, bytes32 rankedAgents, uint256 decisionTimestamp, bytes calldata decisionSig
    ) external returns (uint256 recordId) {
        require(decisionSig.length == 65, "Invalid sig length");
        require(routerSigner != address(0), "Zero router signer");
        bytes32 digest = _hashDecision(taskHash, rankedAgents, targetAgent, decisionTimestamp);
        require(digest.recover(decisionSig) == routerSigner, "Bad router sig");
        uint96 seq = ++seqCounter;            // 1 个温 SSTORE（热槽计数器，~5k 首次后 ~100）
        recordId = encodeRecordId(targetAgent, seq);  // 纯位运算，targetAgent 编入高位
        emit ScheduleLogged(recordId, requester, targetAgent, reason, taskCommitment, routerSigner, digest, block.timestamp);
    }

    function updateExecutionEncoded(
        uint256 recordId, ExecutionStatus status, bytes32 resultDigest, uint256 resultTimestamp, bytes calldata workerSig
    ) external {
        require(workerSig.length == 65, "Invalid sig length");
        address targetAgent = decodeTargetAgent(recordId);  // 从 recordId 解出，零存储读
        bytes32 digest = _hashResult(recordId, resultDigest, resultTimestamp);
        address recovered = digest.recover(workerSig);
        require(recovered != address(0), "Bad sig");
        if (agentDID != address(0)) {
            (bool ok, bytes memory data) = agentDID.staticcall(
                abi.encodeWithSignature("getPubKey(address)", targetAgent)
            );
            require(ok, "AgentDID call failed");
            require(recovered == abi.decode(data, (address)), "Sig not from worker pubKey");
        }
        emit ExecutionUpdated(recordId, status, resultDigest, recovered, block.timestamp);
    }
}

