/**
 * P4 实验 E3 + E5：链上安全属性与 dispute 环的 gas 测量（本地 Hardhat）
 *
 * E3 — relay 伪造 / 跨链重放抗性：验证各攻击被拒，测失败尝试的 gas。
 * E5 — dispute-slash-信誉环：测量 FAILED→raiseDispute→resolveDispute→slash→penalty
 *      全环 gas 与断路器开销。
 *
 * 输出 paper2/data/e3-e5-results.json（供 paper2 表格与 matplotlib 图）。
 * 运行：npx hardhat run experiments/e3-e5-onchain.js
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const ethers = hre.ethers;
  const signers = await ethers.getSigners();
  const [owner, router, worker, requester, attacker] = signers;

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

  // ---- 部署 ----
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy();
  const AgentDID = await ethers.getContractFactory("AgentDID");
  const agentDID = await AgentDID.deploy();
  const AgentStake = await ethers.getContractFactory("AgentStake");
  const stake = await AgentStake.deploy(await token.getAddress());
  const AuditLog = await ethers.getContractFactory("AuditLog");
  const audit = await AuditLog.deploy();
  await audit.setAgentDID(await agentDID.getAddress());
  await audit.setAgentStake(await stake.getAddress());
  await stake.setAuditLog(await audit.getAddress());

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: "ORACLE AuditLog",
    version: "1",
    chainId,
    verifyingContract: await audit.getAddress(),
  };

  // worker 注册(pubKey=自身) + 质押
  const commitment = ethers.keccak256(ethers.toUtf8Bytes("w-secret"));
  await agentDID.connect(worker).registerAgentWithPubKey("did:oracle:W", commitment, "code_review", worker.address);
  await token.mint(worker.address, ethers.parseEther("1000"));
  await token.connect(worker).approve(await stake.getAddress(), ethers.parseEther("1000"));
  await stake.connect(worker).stake(ethers.parseEther("1000"));

  async function logOne(salt) {
    const taskHash = ethers.keccak256(ethers.toUtf8Bytes("task" + salt));
    const ranked = ethers.keccak256(ethers.toUtf8Bytes("rank" + salt));
    const commit = ethers.keccak256(ethers.toUtf8Bytes("c" + salt));
    const ts = (await ethers.provider.getBlock("latest")).timestamp;
    const sig = await router.signTypedData(domain, DECISION_TYPES, {
      taskHash, rankedAgents: ranked, topAgent: worker.address, timestamp: ts,
    });
    const tx = await audit.logScheduleWithDecision(
      requester.address, worker.address, commit, 0, router.address, taskHash, ranked, ts, sig);
    const r = await tx.wait();
    return { recordId: Number(r.logs[0].topics[1]), gas: Number(r.gasUsed), ts };
  }

  const results = { generatedNote: "P4 E3+E5 local Hardhat; stamp time externally", e3: {}, e5: {} };

  // ===== E3：安全属性 =====
  // (1) 合法 worker 签名 → 成功 + gas 基线
  const rec1 = await logOne("ok");
  const rd = ethers.keccak256(ethers.toUtf8Bytes("result-ok"));
  const goodSig = await worker.signTypedData(domain, RESULT_TYPES, { recordId: rec1.recordId, resultDigest: rd, timestamp: rec1.ts });
  const okTx = await audit.updateExecutionWithSig(rec1.recordId, 1, "ok", rd, rec1.ts, goodSig);
  const okR = await okTx.wait();
  results.e3.legitWorkerUpdateGas = Number(okR.gasUsed);

  // (2) relay 用自己的钥伪造 worker 签名 → 必拒
  const rec2 = await logOne("forge");
  const forgeSig = await attacker.signTypedData(domain, RESULT_TYPES, { recordId: rec2.recordId, resultDigest: rd, timestamp: rec2.ts });
  let relayForgeRejected = false, relayForgeErr = "";
  try { await audit.updateExecutionWithSig.staticCall(rec2.recordId, 1, "forged", rd, rec2.ts, forgeSig); }
  catch (e) { relayForgeRejected = true; relayForgeErr = (e.message.match(/'([^']+)'/) || [,e.message])[1].slice(0,60); }
  results.e3.relayForgeRejected = relayForgeRejected;
  results.e3.relayForgeRevertReason = relayForgeErr;

  // (3) 跨链重放：用错误 chainId 域签名 → 必拒
  const wrongDomain = { ...domain, chainId: 999999 };
  const rec3 = await logOne("replay");
  const replaySig = await worker.signTypedData(wrongDomain, RESULT_TYPES, { recordId: rec3.recordId, resultDigest: rd, timestamp: rec3.ts });
  let replayRejected = false;
  try { await audit.updateExecutionWithSig.staticCall(rec3.recordId, 1, "replay", rd, rec3.ts, replaySig); }
  catch { replayRejected = true; }
  results.e3.crossChainReplayRejected = replayRejected;

  // (4) 决策签名跨链重放(wrong chainId) → logSchedule 必拒
  let decisionReplayRejected = false;
  const th = ethers.keccak256(ethers.toUtf8Bytes("t")), rk = ethers.keccak256(ethers.toUtf8Bytes("r"));
  const ts4 = (await ethers.provider.getBlock("latest")).timestamp;
  const badSig = await router.signTypedData(wrongDomain, DECISION_TYPES, { taskHash: th, rankedAgents: rk, topAgent: worker.address, timestamp: ts4 });
  try {
    await audit.logScheduleWithDecision.staticCall(requester.address, worker.address,
      ethers.keccak256(ethers.toUtf8Bytes("c-bad")), 0, router.address, th, rk, ts4, badSig);
  } catch { decisionReplayRejected = true; }
  results.e3.decisionCrossChainReplayRejected = decisionReplayRejected;

  // 4 行属性对比表(布尔矩阵,供论文 Table)
  results.e3.propertyMatrix = {
    columns: ["ORACLE", "centralized_HMAC_log", "Qi_et_al_plain_ECDSA", "ERC8004_storage_only"],
    rows: {
      tamper_evidence_third_party: [true, false, true, true],
      relay_forgery_resistance: [true, false, false, false],
      cross_chain_replay_resistance: [true, "n/a", false, false],
      worker_forgery_resistance: [false, false, false, false], // 开放问题(引 Tool Receipts)
    },
    note: "worker_forgery_resistance=false for all: signature proves authorship not correctness (arXiv:2603.10060)",
  };

  // ===== E5：dispute-slash-信誉环 =====
  const rec5 = await logOne("dispute");
  // FAILED
  const failTx = await audit.updateExecution(rec5.recordId, 2, "failed");
  results.e5.updateFailedGas = Number((await failTx.wait()).gasUsed);
  // raiseDispute
  const rdTx = await audit.connect(requester).raiseDispute(rec5.recordId);
  results.e5.raiseDisputeGas = Number((await rdTx.wait()).gasUsed);
  // 断路器关闭时 resolveDispute(true) → 不 slash
  const resolveOffTx = await audit.connect(owner).resolveDispute(rec5.recordId, true);
  results.e5.resolveDisputeSlashDisabledGas = Number((await resolveOffTx.wait()).gasUsed);
  const stakeAfterOff = await stake.getStake(worker.address);

  // 开断路器,新争议,resolveDispute(true) → slash
  const rec6 = await logOne("dispute2");
  await audit.updateExecution(rec6.recordId, 2, "failed");
  await audit.connect(requester).raiseDispute(rec6.recordId);
  await audit.connect(owner).setSlashEnabled(true);
  const beforeSlash = await stake.getStake(worker.address);
  const resolveOnTx = await audit.connect(owner).resolveDispute(rec6.recordId, true);
  results.e5.resolveDisputeSlashEnabledGas = Number((await resolveOnTx.wait()).gasUsed);
  const afterSlash = await stake.getStake(worker.address);
  results.e5.slashAmount = (beforeSlash - afterSlash).toString();
  results.e5.slashBpsObserved = Number((beforeSlash - afterSlash) * 10000n / beforeSlash);
  results.e5.circuitBreakerOverheadGas = results.e5.resolveDisputeSlashEnabledGas - results.e5.resolveDisputeSlashDisabledGas;

  // 输出
  const outDir = path.join(__dirname, "..", "paper2", "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "e3-e5-results.json"), JSON.stringify(results, null, 2));
  console.log("E3+E5 done →", path.join(outDir, "e3-e5-results.json"));
  console.log(JSON.stringify(results, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
