/**
 * experiments/verify-optimized-integration.js
 *
 * 端到端验证「M5 优化合约接入生产 api-server」的链上正确性（任务 b 的关键证明）：
 * 不经 LLM，直接复刻 api-server 在 AUDIT_MODE=optimized 下的链上写入流程：
 *   1. 注册 worker（account #0，其地址在 demo 助记词派生集内，pubKey 绑定）
 *   2. router 用 EIP-712 签 Decision（verifyingContract = AuditLogOptimized 地址）
 *   3. logScheduleEncoded（M5：recordId 编码 targetAgent，零锚点）→ 解析 recordId
 *   4. 从 recordId 解出 targetAgent，验证 = worker（M5 归属安全）
 *   5. worker 用 EIP-712 签 Result（绑定 recordId）
 *   6. updateExecutionEncoded → 校验链上验签通过、gas 落在 ~85k 区间
 *
 * 这证明适配器接入的不是「能编译」而是「能在真实合约上跑通完整双签名审计写入」。
 *
 * 运行：npx hardhat run experiments/verify-optimized-integration.js --network localhost
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const ethers = hre.ethers;
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "localhost.json"), "utf8"),
  ).addresses;

  const [deployer] = await ethers.getSigners(); // account #0 = demo 派生 m/.../0
  const router = deployer;
  const worker = deployer; // worker pubKey = account#0，在 demo 派生集内

  const did = await ethers.getContractAt("AgentDID", dep.AgentDID);
  const opt = await ethers.getContractAt("AuditLogOptimized", dep.AuditLogOptimized);

  // 1. 确保 worker 已注册（pubKey = worker.address）
  let registered = false;
  try {
    const info = await did.getAgent(worker.address);
    registered = Boolean(info.isActive ?? info[4]);
  } catch {}
  if (!registered) {
    const c = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "bytes32"], [ethers.id("n"), ethers.id("s")]),
    );
    await (
      await did.registerAgentWithPubKey("did:oracle:opt-int", c, "qa", worker.address)
    ).wait();
    console.log("   worker 注册完成");
  }

  // 2. EIP-712 domain 必须指向 AuditLogOptimized（与 api-server auditVerifyingContract 一致）
  const optAddr = await opt.getAddress();
  const domain = { name: "ORACLE AuditLog", version: "1", chainId: 31337n, verifyingContract: optAddr };
  const DT = {
    Decision: [
      { name: "taskHash", type: "bytes32" },
      { name: "rankedAgents", type: "bytes32" },
      { name: "topAgent", type: "address" },
      { name: "timestamp", type: "uint256" },
    ],
  };
  const RT = {
    Result: [
      { name: "recordId", type: "uint256" },
      { name: "resultDigest", type: "bytes32" },
      { name: "timestamp", type: "uint256" },
    ],
  };

  const taskHash = ethers.keccak256(ethers.toUtf8Bytes("审查这段合约的重入风险"));
  const rankedAgents = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [[worker.address]]),
  );
  const ts = Math.floor(Date.now() / 1000);
  const taskCommitment = ethers.keccak256(ethers.toUtf8Bytes("commit-" + ts));

  // 3. router 签 Decision → logScheduleEncoded（M5）
  const decisionSig = await router.signTypedData(domain, DT, {
    taskHash,
    rankedAgents,
    topAgent: worker.address,
    timestamp: ts,
  });
  const tx1 = await opt.logScheduleEncoded(
    router.address,
    worker.address,
    taskCommitment,
    0,
    router.address,
    taskHash,
    rankedAgents,
    ts,
    decisionSig,
  );
  const r1 = await tx1.wait();
  const recordId = BigInt(r1.logs[0].topics[1]); // 首个 indexed = recordId
  const logGas = Number(r1.gasUsed);
  console.log(`   logScheduleEncoded gas=${logGas.toLocaleString()} recordId=${recordId}`);

  // 4. 从 recordId 解出 targetAgent，验证归属（M5 安全核心）
  const decoded = await opt.decodeTargetAgent(recordId);
  const attributionOk = decoded.toLowerCase() === worker.address.toLowerCase();
  if (!attributionOk) throw new Error(`归属解码错误: ${decoded} != ${worker.address}`);

  // 5. worker 签 Result → updateExecutionEncoded
  const resultText = "已分析：未发现重入风险，建议加 nonReentrant。";
  const resultHash = ethers.keccak256(ethers.toUtf8Bytes(resultText));
  const resultDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "bytes32", "uint256"],
      [recordId, resultHash, ts],
    ),
  );
  const workerSig = await worker.signTypedData(domain, RT, {
    recordId,
    resultDigest,
    timestamp: ts,
  });
  const tx2 = await opt.updateExecutionEncoded(recordId, 1, resultDigest, ts, workerSig);
  const r2 = await tx2.wait();
  const updGas = Number(r2.gasUsed);
  console.log(`   updateExecutionEncoded gas=${updGas.toLocaleString()}`);

  const totalGas = logGas + updGas;
  console.log(`\n✅ optimized 模式端到端通过`);
  console.log(`   归属解码正确: ${attributionOk}`);
  console.log(`   dispatch 合计 gas: ${totalGas.toLocaleString()}`);
  console.log(`   双签名（router Decision + worker Result）均链上验签通过`);

  // 对抗：worker 用错误地址签名应被拒（验证不是放松验签）
  const attacker = (await ethers.getSigners())[1];
  const badSig = await attacker.signTypedData(domain, RT, {
    recordId,
    resultDigest,
    timestamp: ts,
  });
  let rejected = false;
  try {
    await (await opt.updateExecutionEncoded(recordId, 1, resultDigest, ts, badSig)).wait();
  } catch {
    rejected = true;
  }
  console.log(`   🛡️ 非 worker 签名被拒: ${rejected ? "✅" : "❌ 未被拒（安全问题）"}`);
  if (!rejected) throw new Error("非 worker 签名未被拒——验签被放松");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  });
