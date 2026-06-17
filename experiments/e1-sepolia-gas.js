#!/usr/bin/env node
/**
 * experiments/e1-sepolia-gas.js — E1 Sepolia 真实 gas 基准（独立于 hardhat runtime）
 *
 * 为什么独立：hardhat 内置 provider 在 WSL+Alchemy 长连接下频繁 ECONNRESET（TLS keep-alive
 * 复用被重置）。本脚本用 ethers v6 + undici 自定义 agent，每请求新建连接（pipelining=0、
 * 短 keep-alive），并对每笔交易整体重试，稳定跑完 N 次。
 *
 * 复用 deployments/sepolia.json 已部署合约（不重新部署），attach 后跑 N 次双签 dispatch：
 *   logScheduleWithDecision（9 参，链上重建 Decision EIP-712 摘要）
 *   updateExecutionWithSig（6 参，链上重建 Result EIP-712 摘要）
 * 采集每笔 gasUsed + effectiveGasPrice + 钱包真实花费，算 USD 成本（多 gas price 区间）。
 *
 * 运行：BENCH_N=100 node experiments/e1-sepolia-gas.js
 * 输出：paper2/data/e1-sepolia-gas.json
 */
const fs = require("fs");
const path = require("path");
const { ethers, FetchRequest } = require("ethers");
const { Agent, setGlobalDispatcher } = require("undici");

// ── 关键：禁用连接复用，绕开 WSL+Node TLS reset ──
setGlobalDispatcher(new Agent({
  pipelining: 0,
  keepAliveTimeout: 1,        // 1ms：基本不复用
  keepAliveMaxTimeout: 1,
  connections: 1,
  connectTimeout: 30000,
}));

const N = Number(process.env.BENCH_N || 100);
const ETH_USD = Number(process.env.ETH_USD || 3000);  // 论文里以区间报，这里给一个基准

// ── .env 读取（不依赖 hardhat/dotenv 覆盖逻辑，直接解析文件）──
function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  const txt = fs.readFileSync(envPath, "utf8");
  const env = {};
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
  return env;
}

function withRetry(fn, label, maxTries = 5) {
  return (async () => {
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try { return await fn(); }
      catch (e) {
        lastErr = e;
        const msg = String(e.message || e);
        const retriable = /ECONNRESET|socket disconnected|timeout|ETIMEDOUT|network socket|503|429|fetch failed|other side closed/i.test(msg);
        if (!retriable || attempt === maxTries) throw e;
        const backoff = 1500 * attempt;
        console.log(`   ⚠️ ${label} 第 ${attempt} 次失败(${msg.slice(0, 45)})，${backoff}ms 后重试`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  })();
}

function pct(s, p) { return s.length ? s[Math.floor((p / 100) * (s.length - 1))] : 0; }
function summarize(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, median: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), min: s[0], max: s[s.length - 1] };
}

async function main() {
  const env = loadEnv();
  const rpc = env.PROVIDER_URL;
  const pk = (env.ROUTER_SIGNER_KEY || "").startsWith("0x") ? env.ROUTER_SIGNER_KEY : "0x" + env.ROUTER_SIGNER_KEY;

  // 自定义 FetchRequest（短超时，配合 undici agent）
  const fr = new FetchRequest(rpc);
  fr.timeout = 60000;
  const provider = new ethers.JsonRpcProvider(fr, 11155111, { staticNetwork: true });
  const wallet = new ethers.Wallet(pk, provider);
  console.log(`🚀 E1 Sepolia gas：N=${N} | 账户=${wallet.address}`);

  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "sepolia.json"), "utf8")).addresses;
  const auditAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "AuditLog.sol", "AuditLog.json"), "utf8")).abi;
  const didAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "AgentDID.sol", "AgentDID.json"), "utf8")).abi;
  const audit = new ethers.Contract(dep.AuditLog, auditAbi, wallet);
  const did = new ethers.Contract(dep.AgentDID, didAbi, wallet);

  const startBal = await withRetry(() => provider.getBalance(wallet.address), "getBalance");
  console.log(`   起始余额：${ethers.formatEther(startBal)} ETH`);

  // 幂等注册 worker（= wallet 自己，单账户模式）
  let registered = false;
  try { const info = await withRetry(() => did.getAgent(wallet.address), "getAgent"); registered = Boolean(info.isActive ?? info[4]); } catch { /* not found */ }
  if (!registered) {
    const nf = ethers.id("e1-nullifier"), sh = ethers.id("e1-secret");
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [nf, sh]));
    console.log("   注册 worker...");
    await withRetry(async () => (await did.registerAgentWithPubKey("did:oracle:e1", commitment, "qa", wallet.address)).wait(), "register");
  } else {
    console.log("   worker 已注册，跳过");
  }

  const domain = { name: "ORACLE AuditLog", version: "1", chainId: 11155111, verifyingContract: dep.AuditLog };
  const decisionTypes = { Decision: [{ name: "taskHash", type: "bytes32" }, { name: "rankedAgents", type: "bytes32" }, { name: "topAgent", type: "address" }, { name: "timestamp", type: "uint256" }] };
  const resultTypes = { Result: [{ name: "recordId", type: "uint256" }, { name: "resultDigest", type: "bytes32" }, { name: "timestamp", type: "uint256" }] };

  const stats = { logSchedule: { gas: [] }, updateExecution: { gas: [] }, total: { gas: [], latency: [], gasPriceGwei: [], costEth: [] } };
  const outDir = path.join(__dirname, "..", "paper2", "data");
  fs.mkdirSync(outDir, { recursive: true });
  const partialPath = path.join(outDir, "e1-sepolia-gas.partial.json");

  for (let i = 0; i < N; i++) {
    const task = `e1-task-${i}-${Date.now()}`;
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const taskCommitment = ethers.keccak256(ethers.solidityPacked(["string", "bytes32"], [task, salt]));
    const taskHash = ethers.keccak256(ethers.toUtf8Bytes(task));
    const ranked = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [[wallet.address]]));
    const ts = Math.floor(Date.now() / 1000);

    const t0 = process.hrtime.bigint();
    // 4a) logScheduleWithDecision
    const decisionSig = await wallet.signTypedData(domain, decisionTypes, { taskHash, rankedAgents: ranked, topAgent: wallet.address, timestamp: ts });
    const r1 = await withRetry(async () => (await audit.logScheduleWithDecision(wallet.address, wallet.address, taskCommitment, 0, wallet.address, taskHash, ranked, ts, decisionSig)).wait(), `logSchedule#${i}`);
    const recordId = Number(r1.logs[0].topics[1]);
    const g1 = Number(r1.gasUsed);

    // 4b) updateExecutionWithSig
    const resultStr = `result-${i}`;
    const resultHash = ethers.keccak256(ethers.toUtf8Bytes(resultStr));
    const innerDigest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32", "uint256"], [recordId, resultHash, ts]));
    const workerSig = await wallet.signTypedData(domain, resultTypes, { recordId, resultDigest: innerDigest, timestamp: ts });
    const r2 = await withRetry(async () => (await audit.updateExecutionWithSig(recordId, 1, resultStr, innerDigest, ts, workerSig)).wait(), `updateExec#${i}`);
    const g2 = Number(r2.gasUsed);
    const latency = Number(process.hrtime.bigint() - t0) / 1e6;

    // 真实 gas price 与花费（effectiveGasPrice 来自回执）
    const gp1 = r1.gasPrice ?? 0n, gp2 = r2.gasPrice ?? 0n;
    const costWei = BigInt(g1) * gp1 + BigInt(g2) * gp2;
    const avgGpGwei = Number((gp1 + gp2) / 2n) / 1e9;

    stats.logSchedule.gas.push(g1);
    stats.updateExecution.gas.push(g2);
    stats.total.gas.push(g1 + g2);
    stats.total.latency.push(latency);
    stats.total.gasPriceGwei.push(avgGpGwei);
    stats.total.costEth.push(Number(ethers.formatEther(costWei)));

    console.log(`  [${i + 1}/${N}] gas=${g1 + g2} | gp=${avgGpGwei.toFixed(2)}gwei | ${(latency / 1000).toFixed(1)}s | recId=${recordId}`);
    if ((i + 1) % 10 === 0) fs.writeFileSync(partialPath, JSON.stringify({ done: i + 1, total: N, stats }, null, 2));
  }

  const endBal = await withRetry(() => provider.getBalance(wallet.address), "getBalance");
  const totalSpentEth = Number(ethers.formatEther(startBal - endBal));
  const meanGasTotal = stats.total.gas.reduce((a, b) => a + b, 0) / stats.total.gas.length;

  // USD 成本：以多 gas price 区间报（论文 §6 要求注明假设）
  const usdAt = (gwei) => (meanGasTotal * gwei * 1e-9) * ETH_USD;

  const report = {
    timestamp: new Date().toISOString(),
    network: "sepolia",
    chainId: 11155111,
    samples: N,
    account: wallet.address,
    logScheduleWithDecision: { gas: summarize(stats.logSchedule.gas) },
    updateExecutionWithSig: { gas: summarize(stats.updateExecution.gas) },
    total_per_dispatch: {
      gas: summarize(stats.total.gas),
      latency_ms: summarize(stats.total.latency),
      gasPriceGwei: summarize(stats.total.gasPriceGwei),
      costEth: summarize(stats.total.costEth),
    },
    realCost: {
      totalSpentEth,
      meanCostEthPerDispatch: totalSpentEth / N,
      note: "totalSpentEth = 钱包真实余额差（含可能的注册交易）",
    },
    usdCostModel: {
      ethUsdAssumed: ETH_USD,
      perDispatchUSD: { "at_5gwei": usdAt(5), "at_20gwei": usdAt(20), "at_50gwei": usdAt(50), "at_100gwei": usdAt(100) },
      note: "USD = meanGas × gwei × 1e-9 × ETH_USD；论文以区间报，不断言单一值。",
    },
    note: "Sepolia 真实测试网双签 dispatch gas 基准（E1）。链上写入受真实出块波动影响。",
  };

  const outPath = path.join(outDir, "e1-sepolia-gas.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n📊 E1 报告 → ${outPath}`);
  console.log(`   gas/dispatch mean=${Math.round(meanGasTotal)} | 真实总花费=${totalSpentEth.toFixed(5)} ETH | USD@20gwei=$${usdAt(20).toFixed(4)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
