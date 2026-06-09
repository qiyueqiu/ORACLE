/**
 * scripts/benchmark.js
 *
 * 论文 5.3 节性能数据复现脚本（A1 修复）
 *   - 部署 AgentDID + AuditLog + Reputation 到 hardhat 内存网络
 *   - 跑 N 次完整调度链路（logScheduleWithDecision + updateExecutionWithSig）
 *   - 输出 gas、延迟、P50/P95 摘要到 paper/benchmark.json
 *
 * 运行：npx hardhat run scripts/benchmark.js
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const SAMPLE_N = Number(process.env.BENCH_N || 30);  // 默认 30 次

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sortedArr.length - 1));
  return sortedArr[idx];
}

async function main() {
  const ethers = hre.ethers;
  console.log(`🚀 ORACLE benchmark: SAMPLE_N=${SAMPLE_N}`);
  const [deployer, router, worker, requester] = await ethers.getSigners();

  // 1) Deploy
  const AgentDID = await ethers.getContractFactory("AgentDID");
  const did = await AgentDID.deploy(); await did.waitForDeployment();
  const AuditLog = await ethers.getContractFactory("AuditLog");
  const audit = await AuditLog.deploy(); await audit.waitForDeployment();
  const Reputation = await ethers.getContractFactory("Reputation");
  const rep = await Reputation.deploy(); await rep.waitForDeployment();

  await audit.setAgentDID(await did.getAddress());

  // 2) Register a worker with pubKey
  const nullifier = ethers.id("benchmark-nullifier");
  const secretHash = ethers.id("benchmark-secret");
  const commitment = ethers.keccak256(
    ethers.solidityPacked(["bytes32", "bytes32"], [nullifier, secretHash])
  );
  await did.connect(worker).registerAgentWithPubKey(
    "did:oracle:worker:bench",
    commitment,
    "qa",
    worker.address
  );

  // 3) EIP-712 domain & types
  const domain = {
    name: "ORACLE Agent Bus",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
  };
  const decisionTypes = {
    Decision: [
      { name: "taskHash", type: "bytes32" },
      { name: "rankedAgents", type: "bytes32" },
      { name: "topAgent", type: "address" },
      { name: "timestamp", type: "uint256" },
    ],
  };
  const resultTypes = {
    Result: [
      { name: "recordId", type: "uint256" },
      { name: "resultDigest", type: "bytes32" },
      { name: "timestamp", type: "uint256" },
    ],
  };

  const stats = {
    logSchedule: { gas: [], latency: [] },
    updateExecution: { gas: [], latency: [] },
    total: { gas: [], latency: [] },
  };

  for (let i = 0; i < SAMPLE_N; i++) {
    const task = `bench-task-${i}-${Date.now()}`;
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const taskCommitment = ethers.keccak256(
      ethers.solidityPacked(["string", "bytes32"], [task, salt])
    );
    const taskHash = ethers.keccak256(ethers.toUtf8Bytes(task));
    const ts = Math.floor(Date.now() / 1000);
    const ranked = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [[worker.address]])
    );

    // Router decision sign
    const decisionInnerDigest = ethers.TypedDataEncoder.hash(domain, decisionTypes, {
      taskHash, rankedAgents: ranked, topAgent: worker.address, timestamp: ts,
    });
    const decisionSig = await router.signTypedData(domain, decisionTypes, {
      taskHash, rankedAgents: ranked, topAgent: worker.address, timestamp: ts,
    });

    // 4a) logScheduleWithDecision —— 传入合约的 digest 必须等于签名时的 digest
    const t1 = process.hrtime.bigint();
    const tx1 = await audit.connect(requester).logScheduleWithDecision(
      requester.address, worker.address, taskCommitment,
      0 /* QUALIFIED */, router.address, decisionInnerDigest, decisionSig
    );
    const r1 = await tx1.wait();
    const t2 = process.hrtime.bigint();
    const recordId = Number(r1.logs[0].topics[1]);
    const g1 = Number(r1.gasUsed);
    stats.logSchedule.gas.push(g1);
    stats.logSchedule.latency.push(Number(t2 - t1) / 1e6);

    // Worker result sign
    // 关键：合约 ecrecover 直接对传入的 32 字节 digest 做 ECDSA.recover，
    // 因此"链下签的 32 字节"必须 == "传入合约的 32 字节 digest"。
    // 我们采用 EIP-712 typed-data hash 作为合约端 digest，达成：
    //   digest = hashStruct(domainSeparator, WorkerResultTypes, value)
    // 这把 recordId / result / timestamp 全部通过 typedData 域绑进签名。
    // 公式：
    //   resultDigest = keccak256(abi.encode(recordId, keccak256(result), ts))
    // 然后 digest_for_recover = EIP-712 hashStruct(Result, ...)
    const resultStr = `result-${i}`;
    const resultHash = ethers.keccak256(ethers.toUtf8Bytes(resultStr));
    const innerDigest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "bytes32", "uint256"],
        [recordId, resultHash, ts]
      )
    );
    // 真实签的 32 字节消息 = EIP-712 hashStruct
    const signedDigest = ethers.TypedDataEncoder.hash(domain, resultTypes, {
      recordId, resultDigest: innerDigest, timestamp: ts,
    });
    const workerSig = await worker.signTypedData(domain, resultTypes, {
      recordId, resultDigest: innerDigest, timestamp: ts,
    });

    // 4b) updateExecutionWithSig —— 传入合约的 digest 必须等于签名时的 digest
    const t3 = process.hrtime.bigint();
    const tx2 = await audit.connect(worker).updateExecutionWithSig(
      recordId, 1 /* SUCCESS */, resultStr, signedDigest, workerSig
    );
    const r2 = await tx2.wait();
    const t4 = process.hrtime.bigint();
    const g2 = Number(r2.gasUsed);
    stats.updateExecution.gas.push(g2);
    stats.updateExecution.latency.push(Number(t4 - t3) / 1e6);
    stats.total.gas.push(g1 + g2);
    stats.total.latency.push(Number(t4 - t1) / 1e6);

    if ((i + 1) % 10 === 0) console.log(`  done ${i + 1}/${SAMPLE_N}`);
  }

  const summarize = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      n: arr.length,
      mean: arr.reduce((a, b) => a + b, 0) / arr.length,
      median: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  };

  const report = {
    timestamp: new Date().toISOString(),
    network: hre.network.name,
    samples: SAMPLE_N,
    logScheduleWithDecision: {
      gas: summarize(stats.logSchedule.gas),
      latency_ms: summarize(stats.logSchedule.latency),
    },
    updateExecutionWithSig: {
      gas: summarize(stats.updateExecution.gas),
      latency_ms: summarize(stats.updateExecution.latency),
    },
    total_per_dispatch: {
      gas: summarize(stats.total.gas),
      latency_ms: summarize(stats.total.latency),
    },
    note: "本数据仅覆盖链上交互；端到端 (LLM+链上+SSE) 时延需额外采集，见 scripts/benchmark-e2e.js",
  };

  const outPath = path.join(__dirname, "..", "paper", "benchmark.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n📊 Benchmark report → ${outPath}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
