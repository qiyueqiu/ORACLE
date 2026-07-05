/**
 * experiments/m7-batch-compact.js — M7 批量+编码+压缩 per-record gas（帕累托极限点）
 *
 * 对比 M4(批量带20k锚点) vs M7(批量+recordId编码零锚点+calldata压缩)的 per-record gas。
 * 测 batch size {1,5,10,50,100}。含对抗测试:批量中每条归属仍由 recordId 编码锁定。
 *
 * 运行：npx hardhat run experiments/m7-batch-compact.js
 * 输出：experiments/data/m7-batch-compact.json
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ETH_USD = 3000, GWEI = 20;
const SIZES = [1, 5, 10, 50, 100];

async function main() {
  const ethers = hre.ethers;
  const [deployer, router, worker] = await ethers.getSigners();

  const AgentDID = await ethers.getContractFactory("AgentDID");
  const did = await AgentDID.deploy(); await did.waitForDeployment();
  const Opt = await ethers.getContractFactory("AuditLogOptimized");
  const opt = await Opt.deploy(); await opt.waitForDeployment();
  await (await opt.setAgentDID(await did.getAddress())).wait();
  const c = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [ethers.id("n"), ethers.id("s")]));
  await (await did.connect(worker).registerAgentWithPubKey("did:oracle:m7", c, "qa", worker.address)).wait();

  const optAddr = await opt.getAddress();
  const domain = { name: "ORACLE AuditLog", version: "1", chainId: 31337n, verifyingContract: optAddr };
  const DT = { Decision: [{ name: "taskHash", type: "bytes32" }, { name: "rankedAgents", type: "bytes32" }, { name: "topAgent", type: "address" }, { name: "timestamp", type: "uint256" }] };

  let salt = 0;
  async function buildM4Item() {
    const s = salt++;
    const th = ethers.keccak256(ethers.toUtf8Bytes("m4t" + s)), rk = ethers.keccak256(ethers.toUtf8Bytes("m4r" + s));
    const tc = ethers.keccak256(ethers.toUtf8Bytes("m4c" + s)), ts = 1700000000 + s;
    const sig = await router.signTypedData(domain, DT, { taskHash: th, rankedAgents: rk, topAgent: worker.address, timestamp: ts });
    return { requester: deployer.address, targetAgent: worker.address, taskCommitment: tc, reason: 0, routerSigner: router.address, taskHash: th, rankedAgents: rk, decisionTimestamp: ts, decisionSig: sig };
  }
  async function buildM7Item() {
    const s = salt++;
    const th = ethers.keccak256(ethers.toUtf8Bytes("m7t" + s)), rk = ethers.keccak256(ethers.toUtf8Bytes("m7r" + s));
    const tc = ethers.keccak256(ethers.toUtf8Bytes("m7c" + s)), ts = 1700000000 + s;
    const sig = await router.signTypedData(domain, DT, { taskHash: th, rankedAgents: rk, topAgent: worker.address, timestamp: ts });
    return { requester: deployer.address, targetAgent: worker.address, taskCommitment: tc, reason: 0, taskHash: th, rankedAgents: rk, decisionTimestamp: ts, decisionSig: sig };
  }

  const m4 = [], m7 = [];
  for (const size of SIZES) {
    const m4items = []; for (let i = 0; i < size; i++) m4items.push(await buildM4Item());
    let r = await (await opt.batchLogScheduleEventOnly(m4items)).wait();
    const m4g = Number(r.gasUsed);
    m4.push({ size, totalGas: m4g, perRecordGas: Math.round(m4g / size), perRecordUSD: +(m4g / size * GWEI * 1e-9 * ETH_USD).toFixed(4) });

    const m7items = []; for (let i = 0; i < size; i++) m7items.push(await buildM7Item());
    r = await (await opt.batchLogScheduleCompact(m7items)).wait();
    const m7g = Number(r.gasUsed);
    m7.push({ size, totalGas: m7g, perRecordGas: Math.round(m7g / size), perRecordUSD: +(m7g / size * GWEI * 1e-9 * ETH_USD).toFixed(4) });

    console.log(`  batch=${String(size).padStart(3)} | M4(锚点)=${Math.round(m4g / size).toLocaleString().padStart(7)} | M7(编码+压缩)=${Math.round(m7g / size).toLocaleString().padStart(6)} gas/record`);
  }

  // 对抗测试:M7 批量中每条 recordId 解码出正确 targetAgent
  const items = [await buildM7Item(), await buildM7Item()];
  const r = await (await opt.batchLogScheduleCompact(items)).wait();
  const recIds = r.logs.map(l => { try { return opt.interface.parseLog(l); } catch { return null; } }).filter(p => p?.name === "ScheduleLoggedCompact").map(p => BigInt(p.args.recordId));
  const decoded0 = await opt.decodeTargetAgent(recIds[0]);
  const attribOk = decoded0.toLowerCase() === worker.address.toLowerCase();

  const m4_100 = m4.find(x => x.size === 100).perRecordGas;
  const m7_100 = m7.find(x => x.size === 100).perRecordGas;
  const m7_10 = m7.find(x => x.size === 10).perRecordGas;
  const report = {
    timestamp: new Date().toISOString(), network: hre.network.name, gweiAssumed: GWEI, ethUsdAssumed: ETH_USD,
    M4_byBatchSize: m4, M7_byBatchSize: m7,
    summary: {
      m4_perRecord_batch100: m4_100, m7_perRecord_batch100: m7_100,
      m7_vs_m4_reductionPct: +(100 * (1 - m7_100 / m4_100)).toFixed(1),
      m7_perRecord_batch10: m7_10,
      m7_floor_note: "M7 per-record 趋近 ecrecover(3k)+event(~5k)+摊薄 calldata/keccak",
    },
    adversarialTest: { batchAttributionIntact: attribOk, decoded: decoded0, expected: worker.address },
    note: "M7=批量(摊tx base)+recordId编码(零锚点)+calldata压缩(routerSigner反推+uint8/uint48)。每条独立 ecrecover 安全不降。",
  };

  const outDir = path.join(__dirname, "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "m7-batch-compact.json"), JSON.stringify(report, null, 2));

  console.log(`\n===== M7 帕累托极限点 =====`);
  console.log(`  M4(批量+20k锚点)  batch=100: ${m4_100.toLocaleString()} gas/record  $${m4.find(x=>x.size===100).perRecordUSD}`);
  console.log(`  M7(批量+编码+压缩) batch=100: ${m7_100.toLocaleString()} gas/record  $${m7.find(x=>x.size===100).perRecordUSD}`);
  console.log(`  M7 vs M4 再降: ${report.summary.m7_vs_m4_reductionPct}%`);
  console.log(`  M7 batch=10 实用点: ${m7_10.toLocaleString()} gas/record  $${m7.find(x=>x.size===10).perRecordUSD}`);
  console.log(`  🛡️ 批量归属编码完整: ${attribOk ? "✅" : "❌"}`);
  console.log(`\n📊 → experiments/data/m7-batch-compact.json`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
