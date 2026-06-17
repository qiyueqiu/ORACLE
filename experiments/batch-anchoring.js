/**
 * experiments/batch-anchoring.js — 批量锚定 per-record gas 测量（M4）
 *
 * 测量 batchLogScheduleEventOnly 在 batch size ∈ {1,5,10,50,100} 下的
 * 总 gas 与摊薄后的 per-record gas，对比单条 M1，量化固定开销摊薄效应。
 * 每条仍带独立 EIP-712 签名 + 逐条 ecrecover（安全不降）。
 *
 * 运行：npx hardhat run experiments/batch-anchoring.js
 * 输出：paper2/data/batch-anchoring.json
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ETH_USD = 3000;
const GWEI = 20;
const SIZES = [1, 5, 10, 50, 100];

async function main() {
  const ethers = hre.ethers;
  const [deployer, router, worker, requester] = await ethers.getSigners();

  const AgentDID = await ethers.getContractFactory("AgentDID");
  const did = await AgentDID.deploy(); await did.waitForDeployment();
  const Opt = await ethers.getContractFactory("AuditLogOptimized");
  const opt = await Opt.deploy(); await opt.waitForDeployment();
  await (await opt.setAgentDID(await did.getAddress())).wait();

  const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [ethers.id("n"), ethers.id("s")]));
  await (await did.connect(worker).registerAgentWithPubKey("did:oracle:batch", commitment, "qa", worker.address)).wait();

  const optAddr = await opt.getAddress();
  const domain = { name: "ORACLE AuditLog", version: "1", chainId: 31337n, verifyingContract: optAddr };
  const DT = { Decision: [{ name: "taskHash", type: "bytes32" }, { name: "rankedAgents", type: "bytes32" }, { name: "topAgent", type: "address" }, { name: "timestamp", type: "uint256" }] };

  let saltCounter = 0;
  async function buildItem() {
    const s = saltCounter++;
    const taskHash = ethers.keccak256(ethers.toUtf8Bytes("bt" + s));
    const ranked = ethers.keccak256(ethers.toUtf8Bytes("br" + s));
    const tc = ethers.keccak256(ethers.toUtf8Bytes("bc" + s));
    const ts = Math.floor(Date.now() / 1000) + s;
    const sig = await router.signTypedData(domain, DT, { taskHash, rankedAgents: ranked, topAgent: worker.address, timestamp: ts });
    return { requester: requester.address, targetAgent: worker.address, taskCommitment: tc, reason: 0, routerSigner: router.address, taskHash, rankedAgents: ranked, decisionTimestamp: ts, decisionSig: sig };
  }

  const results = [];
  for (const size of SIZES) {
    const items = [];
    for (let i = 0; i < size; i++) items.push(await buildItem());
    const tx = await opt.batchLogScheduleEventOnly(items);
    const r = await tx.wait();
    const totalGas = Number(r.gasUsed);
    const perRecord = totalGas / size;
    results.push({ size, totalGas, perRecordGas: Math.round(perRecord), perRecordUSD: +(perRecord * GWEI * 1e-9 * ETH_USD).toFixed(4) });
    console.log(`  batch=${String(size).padStart(3)} | total=${totalGas.toLocaleString().padStart(9)} | per-record=${Math.round(perRecord).toLocaleString().padStart(7)} gas | $${(perRecord * GWEI * 1e-9 * ETH_USD).toFixed(4)}@${GWEI}gwei`);
  }

  // 对比基线：单条 M1（含 update 的完整 dispatch 不在此，仅 log 阶段对比）
  const single = results.find((x) => x.size === 1).perRecordGas;
  const best = results[results.length - 1];
  const report = {
    timestamp: new Date().toISOString(),
    network: hre.network.name,
    gweiAssumed: GWEI,
    ethUsdAssumed: ETH_USD,
    note: "batchLogScheduleEventOnly per-record gas vs batch size。每条独立 EIP-712 签名+逐条 ecrecover（安全不降）。摊薄的是 21k base + 计数器冷启动 + 函数固定开销。仅 log 阶段（不含 update）。",
    byBatchSize: results,
    summary: {
      singleRecordGas: single,
      batch100PerRecordGas: best.perRecordGas,
      reductionPct: +(100 * (1 - best.perRecordGas / single)).toFixed(1),
      perRecordUSD_single: +(single * GWEI * 1e-9 * ETH_USD).toFixed(4),
      perRecordUSD_batch100: best.perRecordUSD,
    },
  };

  const outDir = path.join(__dirname, "..", "paper2", "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "batch-anchoring.json"), JSON.stringify(report, null, 2));

  console.log(`\n  单条 per-record: ${single.toLocaleString()} gas ($${report.summary.perRecordUSD_single}@${GWEI}gwei)`);
  console.log(`  batch=100 per-record: ${best.perRecordGas.toLocaleString()} gas ($${best.perRecordUSD}@${GWEI}gwei)`);
  console.log(`  摊薄降幅: ${report.summary.reductionPct}%`);
  console.log(`\n📊 → paper2/data/batch-anchoring.json`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
