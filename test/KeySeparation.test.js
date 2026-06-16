const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * P2 密钥分离（修复 C1）集成测试
 *
 * 验证核心安全性质：worker 结果签名必须来自该 agent 在 AgentDID 上绑定的 pubKey。
 *   - 正例：agent 用自己的密钥签 Result → updateExecutionWithSig 通过
 *   - 反例：后端运营方（或任意第三方）用别的密钥签 → 链上拒绝 "Sig not from worker pubKey"
 * 这证明后端即使持有自己的密钥，也无法伪造任意 agent 的执行结果（消除单密钥代签的信任坍塌）。
 */
describe("Key Separation (P2 / fixes C1)", function () {
  let auditLog, agentDID;
  let owner, router, worker, attacker, requester;

  // 与 AuditLog.sol domainSeparator / typehash 完全一致
  const RESULT_TYPES = {
    Result: [
      { name: "recordId", type: "uint256" },
      { name: "resultDigest", type: "bytes32" },
      { name: "timestamp", type: "uint256" },
    ],
  };
  const DECISION_TYPES = {
    Decision: [
      { name: "taskHash", type: "bytes32" },
      { name: "rankedAgents", type: "bytes32" },
      { name: "topAgent", type: "address" },
      { name: "timestamp", type: "uint256" },
    ],
  };

  async function domain() {
    return {
      name: "ORACLE AuditLog",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await auditLog.getAddress(),
    };
  }

  beforeEach(async function () {
    [owner, router, worker, attacker, requester] = await ethers.getSigners();

    const AgentDID = await ethers.getContractFactory("AgentDID");
    agentDID = await AgentDID.deploy();
    await agentDID.waitForDeployment();

    const AuditLog = await ethers.getContractFactory("AuditLog");
    auditLog = await AuditLog.deploy();
    await auditLog.waitForDeployment();
    await auditLog.setAgentDID(await agentDID.getAddress());

    // worker 注册并绑定 pubKey = worker 自己的地址（P2 demo 模型）
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("worker-secret"));
    await agentDID
      .connect(worker)
      .registerAgentWithPubKey("did:oracle:Worker", commitment, "code_review", worker.address);
  });

  // 先记录一条调度，返回 recordId，供 updateExecution 使用
  async function logOneSchedule() {
    const taskHash = ethers.keccak256(ethers.toUtf8Bytes("task"));
    const rankedAgents = ethers.keccak256(ethers.toUtf8Bytes("ranked"));
    const taskCommitment = ethers.keccak256(ethers.toUtf8Bytes("commitment-1"));
    const ts = Math.floor(Date.now() / 1000);
    const d = await domain();
    const decisionValue = {
      taskHash,
      rankedAgents,
      topAgent: worker.address,
      timestamp: ts,
    };
    const decisionSig = await router.signTypedData(d, DECISION_TYPES, decisionValue);
    const tx = await auditLog.logScheduleWithDecision(
      requester.address,
      worker.address,
      taskCommitment,
      0,
      router.address,
      taskHash,
      rankedAgents,
      ts,
      decisionSig,
    );
    const r = await tx.wait();
    return Number(r.logs[0].topics[1]);
  }

  it("accepts a result signed by the agent's own key (bound pubKey)", async function () {
    const recordId = await logOneSchedule();
    const resultDigest = ethers.keccak256(ethers.toUtf8Bytes("result-content"));
    const ts = Math.floor(Date.now() / 1000);
    const d = await domain();
    // worker 用自己的密钥签名
    const workerSig = await worker.signTypedData(d, RESULT_TYPES, {
      recordId,
      resultDigest,
      timestamp: ts,
    });
    await expect(
      auditLog.updateExecutionWithSig(recordId, 1, "done", resultDigest, ts, workerSig),
    ).to.emit(auditLog, "ExecutionUpdated");

    const rec = await auditLog.getRecordFull(recordId);
    expect(rec.workerSigner).to.equal(worker.address);
  });

  it("rejects a result signed by a DIFFERENT key (e.g. backend operator forging)", async function () {
    const recordId = await logOneSchedule();
    const resultDigest = ethers.keccak256(ethers.toUtf8Bytes("result-content"));
    const ts = Math.floor(Date.now() / 1000);
    const d = await domain();
    // attacker（模拟后端运营方用自己的密钥代签）签名 —— 应被链上拒绝
    const forgedSig = await attacker.signTypedData(d, RESULT_TYPES, {
      recordId,
      resultDigest,
      timestamp: ts,
    });
    await expect(
      auditLog.updateExecutionWithSig(recordId, 1, "forged", resultDigest, ts, forgedSig),
    ).to.be.revertedWith("Sig not from worker pubKey");
  });

  it("rejects when an unregistered agent's worker key is used (no bound pubKey)", async function () {
    // 用 owner 作为 targetAgent（未注册 → getPubKey revert / 无 pubKey）
    const taskHash = ethers.keccak256(ethers.toUtf8Bytes("task2"));
    const rankedAgents = ethers.keccak256(ethers.toUtf8Bytes("ranked2"));
    const taskCommitment = ethers.keccak256(ethers.toUtf8Bytes("commitment-2"));
    const ts = Math.floor(Date.now() / 1000);
    const d = await domain();
    const decisionSig = await router.signTypedData(d, DECISION_TYPES, {
      taskHash,
      rankedAgents,
      topAgent: owner.address,
      timestamp: ts,
    });
    // owner 未注册为 agent；logSchedule 仍可记录（targetAgent 不要求注册），
    // 但 updateExecutionWithSig 时 getPubKey(owner) 会 revert "Agent not found"
    await auditLog.logScheduleWithDecision(
      requester.address,
      owner.address,
      taskCommitment,
      0,
      router.address,
      taskHash,
      rankedAgents,
      ts,
      decisionSig,
    );
    const recordId = 1;
    const resultDigest = ethers.keccak256(ethers.toUtf8Bytes("r"));
    const sig = await worker.signTypedData(d, RESULT_TYPES, {
      recordId,
      resultDigest,
      timestamp: ts,
    });
    await expect(
      auditLog.updateExecutionWithSig(recordId, 1, "x", resultDigest, ts, sig),
    ).to.be.reverted; // getPubKey(owner) reverts "Agent not found"
  });
});
