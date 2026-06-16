const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * P6 slash 管线安全不变量测试（dispute-gated + 断路器）
 *
 * 证明：
 *   - 安全不变量：成功路径（updateExecution SUCCESS）绝不触发 slash
 *   - DISPUTED 状态只能经 raiseDispute 进入；updateExecution* 直接写 DISPUTED 被拒
 *   - 仅 requester 能对 FAILED 记录发起争议
 *   - slash 仅经 resolveDispute(true) 且 slashEnabled=true 时触发（断路器默认关闭）
 *   - 访问控制：非 requester 不能 raiseDispute，非 owner 不能 resolveDispute
 */
describe("Slash Pipeline (P6 dispute-gated)", function () {
  let token, stake, auditLog, agentDID;
  let owner, requester, worker, other;

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
    [owner, requester, worker, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy();
    await token.waitForDeployment();

    const AgentStake = await ethers.getContractFactory("AgentStake");
    stake = await AgentStake.deploy(await token.getAddress());
    await stake.waitForDeployment();

    const AgentDID = await ethers.getContractFactory("AgentDID");
    agentDID = await AgentDID.deploy();
    await agentDID.waitForDeployment();

    const AuditLog = await ethers.getContractFactory("AuditLog");
    auditLog = await AuditLog.deploy();
    await auditLog.waitForDeployment();

    // 接线：AuditLog 知道 AgentStake；AgentStake 只接受 AuditLog 调 slash
    await auditLog.setAgentStake(await stake.getAddress());
    await stake.setAuditLog(await auditLog.getAddress());

    // worker 质押
    await token.mint(worker.address, ethers.parseEther("1000"));
    await token.connect(worker).approve(await stake.getAddress(), ethers.parseEther("1000"));
    await stake.connect(worker).stake(ethers.parseEther("1000"));
  });

  // 记录一条调度（router 签名），返回 recordId
  async function logSchedule() {
    const taskHash = ethers.keccak256(ethers.toUtf8Bytes("t"));
    const rankedAgents = ethers.keccak256(ethers.toUtf8Bytes("r"));
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("c-" + Math.random()));
    const ts = (await ethers.provider.getBlock("latest")).timestamp;
    const sig = await owner.signTypedData(await domain(), DECISION_TYPES, {
      taskHash,
      rankedAgents,
      topAgent: worker.address,
      timestamp: ts,
    });
    const tx = await auditLog
      .connect(requester)
      .logScheduleWithDecision(
        requester.address,
        worker.address,
        commitment,
        0,
        owner.address,
        taskHash,
        rankedAgents,
        ts,
        sig,
      );
    const r = await tx.wait();
    return Number(r.logs[0].topics[1]);
  }

  describe("safety invariant: success path NEVER slashes", function () {
    it("updateExecution(SUCCESS) leaves stake untouched and emits no Slashed", async function () {
      const recordId = await logSchedule();
      const before = await stake.getStake(worker.address);
      const tx = await auditLog.updateExecution(recordId, 1, "ok"); // 1 = SUCCESS
      await tx.wait();
      // 成功路径绝不触发 slash
      expect(await stake.getStake(worker.address)).to.equal(before);
      // 无法对 SUCCESS 记录发起争议
      await expect(auditLog.connect(requester).raiseDispute(recordId)).to.be.revertedWith(
        "Only FAILED records",
      );
    });

    it("updateExecution cannot write DISPUTED directly (must use raiseDispute)", async function () {
      const recordId = await logSchedule();
      await expect(auditLog.updateExecution(recordId, 4, "x")).to.be.revertedWith("Use raiseDispute");
    });
  });

  describe("dispute flow + circuit breaker", function () {
    async function toFailed() {
      const recordId = await logSchedule();
      await auditLog.updateExecution(recordId, 2, "failed"); // 2 = FAILED
      return recordId;
    }

    it("only requester can raise dispute on a FAILED record", async function () {
      const recordId = await toFailed();
      await expect(auditLog.connect(other).raiseDispute(recordId)).to.be.revertedWith(
        "Only requester",
      );
      await expect(auditLog.connect(requester).raiseDispute(recordId)).to.emit(
        auditLog,
        "DisputeRaised",
      );
      // 进入 DISPUTED 状态
      const rec = await auditLog.getRecord(recordId);
      expect(rec.executionStatus).to.equal(4);
    });

    it("resolveDispute with slashEnabled=false does NOT slash (circuit breaker)", async function () {
      const recordId = await toFailed();
      await auditLog.connect(requester).raiseDispute(recordId);
      const before = await stake.getStake(worker.address);
      // slashEnabled 默认 false
      await expect(auditLog.connect(owner).resolveDispute(recordId, true)).to.emit(
        auditLog,
        "DisputeResolved",
      );
      expect(await stake.getStake(worker.address)).to.equal(before); // 未 slash
    });

    it("resolveDispute(true) with slashEnabled=true DOES slash exactly once", async function () {
      const recordId = await toFailed();
      await auditLog.connect(requester).raiseDispute(recordId);
      await auditLog.connect(owner).setSlashEnabled(true);
      const before = await stake.getStake(worker.address);
      await expect(auditLog.connect(owner).resolveDispute(recordId, true)).to.emit(
        stake,
        "Slashed",
      );
      const after = await stake.getStake(worker.address);
      // 默认 slashBps=1000 (10%) → 扣 10%
      expect(after).to.be.lessThan(before);
      expect(after).to.equal((before * 9000n) / 10000n);
    });

    it("resolveDispute(false) closes dispute without slashing even if enabled", async function () {
      const recordId = await toFailed();
      await auditLog.connect(requester).raiseDispute(recordId);
      await auditLog.connect(owner).setSlashEnabled(true);
      const before = await stake.getStake(worker.address);
      await auditLog.connect(owner).resolveDispute(recordId, false);
      expect(await stake.getStake(worker.address)).to.equal(before);
    });

    it("non-owner cannot resolve dispute", async function () {
      const recordId = await toFailed();
      await auditLog.connect(requester).raiseDispute(recordId);
      await expect(
        auditLog.connect(requester).resolveDispute(recordId, true),
      ).to.be.revertedWithCustomError(auditLog, "OwnableUnauthorizedAccount");
    });
  });
});
