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

// RPC 容错：Sepolia + Alchemy 偶发 ECONNRESET / TLS 抖动 / timeout。
// 对幂等的只读/等待操作自动重试。交易发送本身不重试（避免重复广播），
// 仅重试「构造交易→等待回执」这一整个闭包，闭包内每次都用新 nonce 重新发。
async function withRetry(fn, label, maxTries = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      const retriable = /ECONNRESET|socket disconnected|timeout|ETIMEDOUT|network socket|503|429|fetch failed/i.test(msg);
      if (!retriable || attempt === maxTries) throw e;
      const backoff = 2000 * attempt;
      console.log(`   ⚠️ ${label} 第 ${attempt} 次失败(${msg.slice(0, 50)})，${backoff}ms 后重试`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

async function main() {
  const ethers = hre.ethers;
  console.log(`🚀 ORACLE benchmark: SAMPLE_N=${SAMPLE_N} network=${hre.network.name}`);
  const signers = await ethers.getSigners();
  // 单账户模式（Sepolia 只有一个充值钱包）：同一 signer 扮演所有角色。
  // 本地 Hardhat 有 20 个账户时仍用不同角色，行为不变。
  const [deployer, router = deployer, worker = deployer, requester = deployer] = signers;
  if (signers.length === 1) {
    console.log(`   单账户模式：${deployer.address} 扮演 deployer/router/worker/requester`);
  }

  // 1) Deploy（本地）或 attach（Sepolia 等已部署网络，复用 deployments/<network>.json）
  //    复用已部署合约避免每次 benchmark 重复部署交易——既省 gas 又减少 Sepolia 长连接抖动。
  let did, audit, rep;
  const deployFile = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost" && fs.existsSync(deployFile)) {
    const dep = JSON.parse(fs.readFileSync(deployFile, "utf8")).addresses;
    console.log(`   attach 已部署合约：${deployFile}`);
    did = await ethers.getContractAt("AgentDID", dep.AgentDID);
    audit = await ethers.getContractAt("AuditLog", dep.AuditLog);
    rep = await ethers.getContractAt("Reputation", dep.Reputation);
  } else {
    const AgentDID = await ethers.getContractFactory("AgentDID");
    did = await AgentDID.deploy(); await did.waitForDeployment();
    const AuditLog = await ethers.getContractFactory("AuditLog");
    audit = await AuditLog.deploy(); await audit.waitForDeployment();
    const Reputation = await ethers.getContractFactory("Reputation");
    rep = await Reputation.deploy(); await rep.waitForDeployment();
    await audit.setAgentDID(await did.getAddress());
  }

  // 2) Register a worker with pubKey（幂等：已注册则跳过，支持复用部署）
  const nullifier = ethers.id("benchmark-nullifier");
  const secretHash = ethers.id("benchmark-secret");
  const commitment = ethers.keccak256(
    ethers.solidityPacked(["bytes32", "bytes32"], [nullifier, secretHash])
  );
  let alreadyRegistered = false;
  try {
    const info = await did.getAgent(worker.address);
    alreadyRegistered = Boolean(info.isActive ?? info[4]);
  } catch { /* 未注册时 getAgent revert "Agent not found"，视为未注册 */ }
  if (!alreadyRegistered) {
    await did.connect(worker).registerAgentWithPubKey(
      "did:oracle:worker:bench",
      commitment,
      "qa",
      worker.address
    );
  } else {
    console.log("   worker 已注册，跳过注册交易");
  }

  // 3) EIP-712 domain & types（P1-C2：必须与 AuditLog.domainSeparator() 一致）
  const domain = {
    name: "ORACLE AuditLog",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await audit.getAddress(),
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

    // Router decision sign（P1-C2:合约链上重建 digest,这里只需签名,传明文字段）
    const decisionSig = await router.signTypedData(domain, decisionTypes, {
      taskHash, rankedAgents: ranked, topAgent: worker.address, timestamp: ts,
    });

    // 4a) logScheduleWithDecision —— 传 Decision 明文字段,合约链上重建 EIP-712 摘要
    const t1 = process.hrtime.bigint();
    const r1 = await withRetry(async () => {
      const tx1 = await audit.connect(requester).logScheduleWithDecision(
        requester.address, worker.address, taskCommitment,
        0 /* QUALIFIED */, router.address, taskHash, ranked, ts, decisionSig
      );
      return tx1.wait();
    }, `logSchedule#${i}`);
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
    // P1-C2:合约链上重建 Result 摘要,这里只需签名,传 resultDigest + timestamp 明文
    const workerSig = await worker.signTypedData(domain, resultTypes, {
      recordId, resultDigest: innerDigest, timestamp: ts,
    });

    // 4b) updateExecutionWithSig —— 传 resultDigest + timestamp,合约链上重建摘要
    const t3 = process.hrtime.bigint();
    const r2 = await withRetry(async () => {
      const tx2 = await audit.connect(worker).updateExecutionWithSig(
        recordId, 1 /* SUCCESS */, resultStr, innerDigest, ts, workerSig
      );
      return tx2.wait();
    }, `updateExec#${i}`);
    const t4 = process.hrtime.bigint();
    const g2 = Number(r2.gasUsed);
    stats.updateExecution.gas.push(g2);
    stats.updateExecution.latency.push(Number(t4 - t3) / 1e6);
    stats.total.gas.push(g1 + g2);
    stats.total.latency.push(Number(t4 - t1) / 1e6);

    const last = stats.total.gas[stats.total.gas.length - 1];
    console.log(`  [${i + 1}/${SAMPLE_N}] dispatch gas=${last} | 累计样本=${stats.total.gas.length}`);
    // 增量写盘：每 10 次存一次中间结果，崩溃也不丢已采集数据
    if ((i + 1) % 10 === 0) {
      const tmpPath = path.join(__dirname, "..", "paper", "benchmark.partial.json");
      fs.writeFileSync(tmpPath, JSON.stringify({ done: i + 1, total: SAMPLE_N, stats }, null, 2));
    }
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

  // 按网络分文件：Sepolia 真实数据单独存，不覆盖本地基线
  const suffix = (hre.network.name === "hardhat" || hre.network.name === "localhost") ? "" : `.${hre.network.name}`;
  const outPath = path.join(__dirname, "..", "paper", `benchmark${suffix}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n📊 Benchmark report → ${outPath}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // 实验数据已增量写盘；若是退出阶段的连接杂音则不算失败
    const msg = String(e.message || e);
    if (/ECONNRESET|socket disconnected/i.test(msg)) {
      console.log(`\n⚠️ 退出时连接重置（数据已写盘，忽略）：${msg.slice(0, 60)}`);
      process.exit(0);
    }
    console.error(e);
    process.exit(1);
  });
