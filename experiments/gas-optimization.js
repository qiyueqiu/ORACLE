/**
 * experiments/gas-optimization.js — 成本优化对照实验
 *
 * 本地精确测量原版 AuditLog vs 优化版 AuditLogOptimized 各模式的 gas，
 * 产出帕累托决策表（gas vs 保留的属性）。本地 gas 确定性，可直接外推主网 USD。
 *
 * 对照组：
 *   baseline_logSchedule       原版 logScheduleWithDecision（13 字段 SSTORE）
 *   baseline_updateExecution   原版 updateExecutionWithSig
 *   M1_logEventOnly            完全 event-only（零记录 SSTORE）
 *   M2_logCommitment           折中：1 承诺槽 + 防重用
 *   M3_updateEventOnly         执行结果 event-only
 *
 * 运行：npx hardhat run experiments/gas-optimization.js
 * 输出：experiments/data/gas-optimization.json
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ETH_USD = 3000;
const GWEI_POINTS = [5, 20, 50, 100];

async function main() {
  const ethers = hre.ethers;
  const [deployer, router, worker, requester] = await ethers.getSigners();

  // 部署原版 + 优化版 + AgentDID
  const AgentDID = await ethers.getContractFactory("AgentDID");
  const did = await AgentDID.deploy(); await did.waitForDeployment();
  const AuditLog = await ethers.getContractFactory("AuditLog");
  const base = await AuditLog.deploy(); await base.waitForDeployment();
  await (await base.setAgentDID(await did.getAddress())).wait();
  const Opt = await ethers.getContractFactory("AuditLogOptimized");
  const opt = await Opt.deploy(); await opt.waitForDeployment();
  await (await opt.setAgentDID(await did.getAddress())).wait();

  // 注册 worker（pubKey = worker 自己）
  const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [ethers.id("n"), ethers.id("s")]));
  await (await did.connect(worker).registerAgentWithPubKey("did:oracle:opt", commitment, "qa", worker.address)).wait();

  const mkDomain = (addr) => ({ name: "ORACLE AuditLog", version: "1", chainId: 31337n, verifyingContract: addr });
  const DT = { Decision: [{ name: "taskHash", type: "bytes32" }, { name: "rankedAgents", type: "bytes32" }, { name: "topAgent", type: "address" }, { name: "timestamp", type: "uint256" }] };
  const RT = { Result: [{ name: "recordId", type: "uint256" }, { name: "resultDigest", type: "bytes32" }, { name: "timestamp", type: "uint256" }] };

  const N = 10;
  const acc = {}; // label -> [gas,...]
  const push = (k, g) => { (acc[k] ||= []).push(Number(g)); };

  for (let i = 0; i < N; i++) {
    const baseDomain = mkDomain(await base.getAddress());
    const optDomain = mkDomain(await opt.getAddress());
    const th = ethers.keccak256(ethers.toUtf8Bytes("t" + i));
    const rk = ethers.keccak256(ethers.toUtf8Bytes("r" + i));
    const ts = Math.floor(Date.now() / 1000) + i;
    const tcBase = ethers.keccak256(ethers.toUtf8Bytes("cbase" + i));
    const tcM1 = ethers.keccak256(ethers.toUtf8Bytes("cm1" + i));
    const tcM2 = ethers.keccak256(ethers.toUtf8Bytes("cm2" + i));

    // ---- baseline log ----
    const sigBase = await router.signTypedData(baseDomain, DT, { taskHash: th, rankedAgents: rk, topAgent: worker.address, timestamp: ts });
    let r = await (await base.logScheduleWithDecision(requester.address, worker.address, tcBase, 0, router.address, th, rk, ts, sigBase)).wait();
    push("baseline_logSchedule", r.gasUsed);
    const recId = Number(r.logs.find(l => l.topics.length >= 2)?.topics[1] ?? i + 1);

    // baseline update
    const resHash = ethers.keccak256(ethers.toUtf8Bytes("res" + i));
    const innerDigest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32", "uint256"], [recId, resHash, ts]));
    const wsigBase = await worker.signTypedData(baseDomain, RT, { recordId: recId, resultDigest: innerDigest, timestamp: ts });
    r = await (await base.connect(worker).updateExecutionWithSig(recId, 1, "res" + i, innerDigest, ts, wsigBase)).wait();
    push("baseline_updateExecution", r.gasUsed);

    // ---- M1 event-only log ----
    const sigM1 = await router.signTypedData(optDomain, DT, { taskHash: th, rankedAgents: rk, topAgent: worker.address, timestamp: ts });
    r = await (await opt.logScheduleEventOnly(requester.address, worker.address, tcM1, 0, router.address, th, rk, ts, sigM1)).wait();
    push("M1_logEventOnly", r.gasUsed);
    const recIdOpt = Number(r.logs.find(l => l.topics.length >= 2)?.topics[1] ?? i + 1);

    // ---- M2 commitment log ----
    const sigM2 = await router.signTypedData(optDomain, DT, { taskHash: th, rankedAgents: rk, topAgent: worker.address, timestamp: ts });
    r = await (await opt.logScheduleCommitment(requester.address, worker.address, tcM2, 0, router.address, th, rk, ts, sigM2)).wait();
    push("M2_logCommitment", r.gasUsed);

    // ---- M3 update event-only（targetAgent 从存储锚点读，不传参）----
    const wsigM3 = await worker.signTypedData(optDomain, RT, { recordId: recIdOpt, resultDigest: innerDigest, timestamp: ts });
    r = await (await opt.updateExecutionEventOnly(recIdOpt, 1, innerDigest, ts, wsigM3)).wait();
    push("M3_updateEventOnly", r.gasUsed);
  }

  const mean = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const summary = {};
  for (const k of Object.keys(acc)) summary[k] = mean(acc[k]);

  // ===== 对抗测试：证明 M3 归属漏洞已修（对抗性审查发现的致命漏洞）=====
  // WorkerB 注册自己的 pubKey，尝试用自己的合法签名把执行结果记到 WorkerA 的任务上。
  // 修复后应被拒（targetAgent 从 recordTargetAgent 存储锚点读，WorkerB 的 sig != WorkerA pubKey）。
  const attackResult = { description: "WorkerB 用自身合法签名冒充 WorkerA 任务执行者", rejected: false, revertReason: "" };
  {
    const workerB = requester; // 复用一个不同地址作为 WorkerB
    const cB = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [ethers.id("nB"), ethers.id("sB")]));
    try { await (await did.connect(workerB).registerAgentWithPubKey("did:oracle:B", cB, "qa", workerB.address)).wait(); } catch { /* 已注册 */ }
    const optDomain = mkDomain(await opt.getAddress());
    // WorkerA 的任务：先建一条 M1 记录，targetAgent=worker(A)
    const thA = ethers.keccak256(ethers.toUtf8Bytes("attack-task"));
    const rkA = ethers.keccak256(ethers.toUtf8Bytes("attack-rank"));
    const tsA = Math.floor(Date.now() / 1000);
    const sigA = await router.signTypedData(optDomain, DT, { taskHash: thA, rankedAgents: rkA, topAgent: worker.address, timestamp: tsA });
    const rA = await (await opt.logScheduleEventOnly(requester.address, worker.address, ethers.keccak256(ethers.toUtf8Bytes("attack-c")), 0, router.address, thA, rkA, tsA, sigA)).wait();
    const attackRecId = Number(rA.logs.find(l => l.topics.length >= 2)?.topics[1]);
    // WorkerB 对该 recordId 签自己的 Result（B 的签名本身完全合法）
    const digestB = ethers.keccak256(ethers.toUtf8Bytes("resB"));
    const wsigB = await workerB.signTypedData(optDomain, RT, { recordId: attackRecId, resultDigest: digestB, timestamp: tsA });
    try {
      await opt.connect(workerB).updateExecutionEventOnly.staticCall(attackRecId, 1, digestB, tsA, wsigB);
      attackResult.rejected = false; // 没 revert = 漏洞仍在 = 致命
    } catch (e) {
      attackResult.rejected = true;
      attackResult.revertReason = (String(e.message).match(/'([^']+)'/) || [, "reverted"])[1].slice(0, 60);
    }
  }
  console.log(`\n🛡️ 归属漏洞对抗测试：WorkerB 冒充 WorkerA → ${attackResult.rejected ? "✅ 被拒(" + attackResult.revertReason + ")" : "❌ 通过(漏洞仍在!)"}\n`);

  // 组合成完整 dispatch 成本对比
  const dispatches = {
    "原版（baseline）": summary.baseline_logSchedule + summary.baseline_updateExecution,
    "M1+M3（全 event-only）": summary.M1_logEventOnly + summary.M3_updateEventOnly,
    "M2+M3（折中：log 存承诺 + update event-only）": summary.M2_logCommitment + summary.M3_updateEventOnly,
  };

  const usdRows = {};
  for (const [name, gas] of Object.entries(dispatches)) {
    usdRows[name] = { gas, usd: Object.fromEntries(GWEI_POINTS.map(g => [`${g}gwei`, +(gas * g * 1e-9 * ETH_USD).toFixed(2)])) };
  }

  const baselineGas = dispatches["原版（baseline）"];
  const report = {
    timestamp: new Date().toISOString(),
    network: hre.network.name,
    samples: N,
    perOperation_gas: summary,
    perDispatch_gas: dispatches,
    perDispatch_usd: usdRows,
    savings: Object.fromEntries(Object.entries(dispatches).map(([k, v]) => [k, {
      gas: v, vsBaseline_pct: +(100 * (1 - v / baselineGas)).toFixed(1),
    }])),
    propertyMatrix: {
      note: "各模式保留的安全/可验证性属性。关键 nuance（WebSearch 核实 EIP-7745/7792）：event logs 经 receipts trie 获协议级防篡改（根入区块头，与 storage 同等），但「按 topic 跨块 trustless 检索」当前依赖 bloom filter+需信任 RPC，非 trustless，直到 EIP-7745 落地。storage 方案可经 eth_getProof 对槽做 trustless 存在性证明。另：M3 event-only 只记录 resultDigest 摘要，不记录明文执行结果（原版 storage 存明文 executionResult 字符串）——明文需链下持有+revealTask 式揭示。",
      columns: ["EIP-712链上验签", "防跨链重放", "worker归属(=本record的targetAgent)", "协议级防篡改", "防commitment重用", "链上trustless存在性证明", "已知tx的Merkle证明", "链上记录明文结果"],
      rows: {
        "原版(storage)":        [true, true, true,  true, true,  true,  true, true],
        "M1全event-only":       [true, true, true,  true, false, false, true, false],
        "M2折中(承诺+锚点)":     [true, true, true,  true, true,  true,  true, false],
        "M3 update event-only": [true, true, true,  true, "n/a", false, true, false],
      },
    },
    attributionAttackTest: attackResult,
    ethUsdAssumed: ETH_USD,
  };

  const outDir = path.join(__dirname, "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "gas-optimization.json"), JSON.stringify(report, null, 2));

  console.log("\n===== 成本优化对照（本地 Hardhat，确定性 gas）=====\n");
  console.log("单操作 gas:");
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(28)} ${v.toLocaleString()}`);
  console.log("\n每 dispatch 总 gas + 节省:");
  for (const [k, v] of Object.entries(dispatches)) {
    const pct = (100 * (1 - v / baselineGas)).toFixed(1);
    console.log(`  ${k.padEnd(40)} ${v.toLocaleString().padStart(9)} gas  (省 ${pct}%)`);
  }
  console.log("\n主网 USD 成本（ETH=$3000）:");
  console.log("  " + "方案".padEnd(40) + GWEI_POINTS.map(g => `${g}gwei`.padStart(10)).join(""));
  for (const [name, row] of Object.entries(usdRows)) {
    console.log("  " + name.padEnd(40) + GWEI_POINTS.map(g => `$${row.usd[g + "gwei"]}`.padStart(10)).join(""));
  }
  console.log(`\n📊 → experiments/data/gas-optimization.json`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
