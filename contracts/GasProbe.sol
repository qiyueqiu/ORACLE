// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title GasProbe — M6 logScheduleCompact gas 成分增量探针
 * @notice 每个函数只做 M6 的一部分操作,通过 estimateGas 差分隔离各成分真实 gas。
 *         仅用于成本分析实验,非生产合约。
 */
contract GasProbe {
    using ECDSA for bytes32;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant DECISION_TYPEHASH = keccak256(
        "Decision(bytes32 taskHash,bytes32 rankedAgents,address topAgent,uint256 timestamp)"
    );

    uint96 private seqCounter;

    event ScheduleLoggedCompact(
        uint256 indexed recordId, address indexed requester, address indexed routerSigner,
        uint8 reason, bytes32 taskCommitment, bytes32 decisionDigest, uint48 timestamp
    );

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes("ORACLE AuditLog")), keccak256(bytes("1")), block.chainid, address(this)));
    }
    function _hashDecision(bytes32 taskHash, bytes32 rankedAgents, address topAgent, uint256 ts) internal view returns (bytes32) {
        bytes32 sh = keccak256(abi.encode(DECISION_TYPEHASH, taskHash, rankedAgents, topAgent, ts));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), sh));
    }

    // p0：空函数,仅 tx base
    function p0_empty() external {}

    // p1：读全部 calldata 参数(用 assembly 防止被优化掉)
    function p1_calldata(address a, address b, bytes32 c, uint8 d, bytes32 e, bytes32 f, uint256 g, bytes calldata sig) external {
        assembly { let x := add(add(a, b), add(d, g)) }
        bytes32 sink = c ^ e ^ f ^ keccak256(sig);
        assembly { sstore(0x99, sink) }
    }

    // p2：+_hashDecision(2x keccak + domain)
    function p2_keccak(address topAgent, bytes32 taskHash, bytes32 rankedAgents, uint256 ts) external {
        bytes32 d = _hashDecision(taskHash, rankedAgents, topAgent, ts);
        assembly { sstore(0x99, d) }
    }

    // p3：+ecrecover
    function p3_ecrecover(bytes32 taskHash, bytes32 rankedAgents, address topAgent, uint256 ts, bytes calldata sig) external {
        bytes32 d = _hashDecision(taskHash, rankedAgents, topAgent, ts);
        address r = d.recover(sig);
        assembly { sstore(0x99, r) }
    }

    // p4：+seqCounter++
    function p4_sstore() external {
        uint96 s = ++seqCounter;
        assembly { sstore(0x9a, s) }
    }

    // p5：+emit 7 字段事件
    function p5_event(address requester, address routerSigner, bytes32 tc, uint8 reason, bytes32 digest) external {
        emit ScheduleLoggedCompact(12345, requester, routerSigner, reason, tc, digest, 1700000000);
    }
}
