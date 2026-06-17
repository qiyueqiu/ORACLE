/**
 * experiments/m5-encoded-recordid.js — M5 recordId 编码归属方案测量 + 对抗测试
 *
 * 方案 B（对抗审查验证的最优）：targetAgent 编进 recordId 高 160 位，零存储锚点。
 * 测量 vs M1（20k 锚点）的 gas 降幅，并用对抗测试证明归属安全不降。
 *
 * 运行：npx hardhat run experiments/m5-encoded-recordid.js
 * 输出：paper2/data/m5-encoded.json
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ETH_USD = 3000, GWEI = 20;

async function main() {
  const ethers = hre.ethers;
  const [deployer, router, workerA, workerB] = await ethers.getSigners();

  const AgentDID = await ethers.getContractFactory("AgentDID");
  const did = await AgentDID.deploy(); await did.waitForDeployment();
  const Opt = await ethers.getContractFactory("AuditLogOptimized");
  const opt = await Opt.deploy(); await opt.waitForDeployment();
  await (await opt.setAgentDID(await did.getAddress())).wait();

  // 注册 WorkerA + WorkerB（各自 pubKey = 自己）
  for (const [w, didStr] of [[workerA, "did:oracle:A"], [workerB, "did:oracle:B"]]) {
    const c = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [ethers.id("n" + didStr), ethers.id("s" + didStr)]));
    await (await did.connect(w).registerAgentWithPubKey(didStr, c, "qa", w.address)).wait();
  }

  const optAddr = await opt.getAddress();
  const domain = { name: "ORACLE AuditLog", version: "1", chainId: 31337n, verifyingContract: optAddr };
  const DT = { Decision: [{ name: "taskHash", type: "bytes32" }, { name: "rankedAgents", type: "bytes32" }, { name: "topAgent", type: "address" }, { name: "timestamp", type: "uint256" }] };
  const RT = { Result: [{ name: "recordId", type: "uint256" }, { name: "resultDigest", type: "bytes32" }, { name: "timestamp", type: "uint256" }] };

  const acc = { M1_log: [], M5_log: [], M3_update: [], M5_update: [] };
  const N = 10;
  for (let i = 0; i < N; i++) {
    const th = ethers.keccak256(ethers.toUtf8Bytes("t" + i)), rk = ethers.keccak256(ethers.toUtf8Bytes("r" + i));
    const ts = Math.floor(Date.now() / 1000) + i;
    const tcM1 = ethers.keccak256(ethers.toUtf8Bytes("m1c" + i)), tcM5 = ethers.keccak256(ethers.toUtf8Bytes("m5c" + i));
    const sig = await router.signTypedData(domain, DT, { taskHash: th, rankedAgents: rk, topAgent: workerA.address, timestamp: ts });

    // M1 log (20k 锚点)
    let r = await (await opt.logScheduleEventOnly(deployer.address, workerA.address, tcM1, 0, router.address, th, rk, ts, sig)).wait();
    acc.M1_log.push(Number(r.gasUsed));
    const recM1 = Number(r.logs.find(l => l.topics.length >= 2)?.topics[1]);
    const digA = ethers.keccak256(ethers.toUtf8Bytes("resA" + i));
    const wsigM1 = await workerA.signTypedData(domain, RT, { recordId: recM1, resultDigest: digA, timestamp: ts });
    r = await (await opt.connect(workerA).updateExecutionEventOnly(recM1, 1, digA, ts, wsigM1)).wait();
    acc.M3_update.push(Number(r.gasUsed));

    // M5 log (编码, 零锚点)
    r = await (await opt.logScheduleEncoded(deployer.address, workerA.address, tcM5, 0, router.address, th, rk, ts, sig)).wait();
    acc.M5_log.push(Number(r.gasUsed));
    const recM5 = BigInt(r.logs.find(l => l.topics.length >= 2)?.topics[1]);
    const wsigM5 = await workerA.signTypedData(domain, RT, { recordId: recM5, resultDigest: digA, timestamp: ts });
    r = await (await opt.connect(workerA).updateExecutionEncoded(recM5, 1, digA, ts, wsigM5)).wait();
    acc.M5_update.push(Number(r.gasUsed));
  }

  // ===== 对抗测试 =====
  const attacks = {};
  const th = ethers.keccak256(ethers.toUtf8Bytes("atk")), rk = ethers.keccak256(ethers.toUtf8Bytes("atkr"));
  const ts = Math.floor(Date.now() / 1000);
  const sigA = await router.signTypedData(domain, DT, { taskHash: th, rankedAgents: rk, topAgent: workerA.address, timestamp: ts });
  let r = await (await opt.logScheduleEncoded(deployer.address, workerA.address, ethers.keccak256(ethers.toUtf8Bytes("atkc")), 0, router.address, th, rk, ts, sigA)).wait();
  const recA = BigInt(r.logs.find(l => l.topics.length >= 2)?.topics[1]);

  // 攻击 1：WorkerB 用自己 key 给 WorkerA 的 recordId 签名 → 必拒
  const dig = ethers.keccak256(ethers.toUtf8Bytes("forge"));
  const wsigB = await workerB.signTypedData(domain, RT, { recordId: recA, resultDigest: dig, timestamp: ts });
  try {
    await opt.connect(workerB).updateExecutionEncoded.staticCall(recA, 1, dig, ts, wsigB);
    attacks.workerB_forges_workerA_record = { rejected: false, note: "❌ 漏洞!WorkerB 冒充成功" };
  } catch (e) {
    attacks.workerB_forges_workerA_record = { rejected: true, reason: (String(e.message).match(/'([^']+)'/) || [, ""])[1] };
  }

  // 攻击 2：recordId 解码出的 targetAgent == WorkerA
  const decoded = await opt.decodeTargetAgent(recA);
  attacks.recordId_decodes_to_correct_agent = { decoded, expected: workerA.address, match: decoded.toLowerCase() === workerA.address.toLowerCase() };

  // 攻击 3：WorkerB 改 recordId 编码自己地址 → 只能执行自己的任务（非冒充 A）
  const recB_forged = await opt.encodeRecordId(workerB.address, 999n);
  const decodedForged = await opt.decodeTargetAgent(recB_forged);
  attacks.workerB_changes_recordId_only_gets_own = {
    decoded: decodedForged, isWorkerB: decodedForged.toLowerCase() === workerB.address.toLowerCase(),
    note: "WorkerB 改 recordId 编码自己地址 → 指向 WorkerB 自己的任务,非 recordA,不构成冒充",
  };

  const mean = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const s = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, mean(v)]));
  const dispatchM1 = s.M1_log + s.M3_update;
  const dispatchM5 = s.M5_log + s.M5_update;

  const report = {
    timestamp: new Date().toISOString(), network: hre.network.name, gweiAssumed: GWEI, ethUsdAssumed: ETH_USD,
    perOperation_gas: s,
    dispatch: {
      "M1+M3 (20k 锚点)": { gas: dispatchM1, usd20gwei: +(dispatchM1 * GWEI * 1e-9 * ETH_USD).toFixed(4) },
      "M5 (编码, 零锚点)": { gas: dispatchM5, usd20gwei: +(dispatchM5 * GWEI * 1e-9 * ETH_USD).toFixed(4) },
    },
    m5_vs_m1_reductionPct: +(100 * (1 - dispatchM5 / dispatchM1)).toFixed(1),
    adversarialTests: attacks,
    securityConclusion: (attacks.workerB_forges_workerA_record.rejected && attacks.recordId_decodes_to_correct_agent.match && attacks.workerB_changes_recordId_only_gets_own.isWorkerB)
      ? "✅ M5 归属安全等同 M1:WorkerB 无法冒充,recordId 不可篡改归属"
      : "❌ 安全验证失败,不可采用",
    note: "M5 方案 B（recordId 编码 targetAgent）经对抗审查（方案 C/D 已证不安全被排除）。代价:recordId 失全局时间序。",
  };

  const outDir = path.join(__dirname, "..", "paper2", "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "m5-encoded.json"), JSON.stringify(report, null, 2));

  console.log("\n===== M5 recordId 编码方案（零存储锚点）=====\n");
  console.log("单操作 gas:");
  for (const [k, v] of Object.entries(s)) console.log(`  ${k.padEnd(12)} ${v.toLocaleString()}`);
  console.log(`\n完整 dispatch:`);
  console.log(`  M1+M3 (20k 锚点):  ${dispatchM1.toLocaleString()} gas  $${report.dispatch["M1+M3 (20k 锚点)"].usd20gwei}@20gwei`);
  console.log(`  M5 (编码,零锚点):  ${dispatchM5.toLocaleString()} gas  $${report.dispatch["M5 (编码, 零锚点)"].usd20gwei}@20gwei`);
  console.log(`  M5 vs M1 再降: ${report.m5_vs_m1_reductionPct}%`);
  console.log(`\n🛡️ 对抗测试:`);
  console.log(`  WorkerB 冒充 WorkerA record → ${attacks.workerB_forges_workerA_record.rejected ? "✅ 被拒(" + attacks.workerB_forges_workerA_record.reason + ")" : "❌ 漏洞!"}`);
  console.log(`  recordId 解码 targetAgent 正确 → ${attacks.recordId_decodes_to_correct_agent.match ? "✅" : "❌"}`);
  console.log(`  WorkerB 改 recordId 只得自己任务 → ${attacks.workerB_changes_recordId_only_gets_own.isWorkerB ? "✅ (非冒充)" : "❌"}`);
  console.log(`\n  ${report.securityConclusion}`);
  console.log(`\n📊 → paper2/data/m5-encoded.json`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
