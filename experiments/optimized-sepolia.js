#!/usr/bin/env node
/**
 * experiments/optimized-sepolia.js — 优化合约 Sepolia 实测（坐实本地 79.5% 节省）
 *
 * 独立 ethers + undici（绕 WSL+Alchemy TLS reset），部署 AuditLogOptimized 到 Sepolia，
 * 实测 M1(event-only+锚点) / M5(编码,零锚点) / batch 的真实 gas，对比 E1 原版基线(405k)。
 *
 * 运行：node experiments/optimized-sepolia.js
 * 输出：experiments/data/optimized-sepolia.json
 */
const fs = require("fs");
const path = require("path");
const { ethers, FetchRequest } = require("ethers");
const { Agent, setGlobalDispatcher } = require("undici");

setGlobalDispatcher(new Agent({ pipelining: 0, keepAliveTimeout: 1, keepAliveMaxTimeout: 1, connections: 1, connectTimeout: 30000 }));

const ETH_USD = 3000, GWEI = 20;

function loadEnv() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
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
        lastErr = e; const msg = String(e.message || e);
        if (!/ECONNRESET|socket disconnected|timeout|ETIMEDOUT|network socket|503|429|fetch failed|other side closed/i.test(msg) || attempt === maxTries) throw e;
        console.log(`   ⚠️ ${label} 第 ${attempt} 次失败,${1500 * attempt}ms 后重试`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastErr;
  })();
}

async function main() {
  const env = loadEnv();
  const pk = (env.ROUTER_SIGNER_KEY || "").startsWith("0x") ? env.ROUTER_SIGNER_KEY : "0x" + env.ROUTER_SIGNER_KEY;
  const fr = new FetchRequest(env.PROVIDER_URL); fr.timeout = 60000;
  const provider = new ethers.JsonRpcProvider(fr, 11155111, { staticNetwork: true });
  const wallet = new ethers.Wallet(pk, provider);
  console.log(`🚀 优化合约 Sepolia 实测 | 账户=${wallet.address}`);

  // 读 artifacts（AuditLogOptimized + AgentDID）
  const optArt = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "AuditLogOptimized.sol", "AuditLogOptimized.json"), "utf8"));
  const didArt = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "AgentDID.sol", "AgentDID.json"), "utf8"));

  // 复用已部署的 AgentDID（Sepolia 上已有），部署新的 AuditLogOptimized
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "sepolia.json"), "utf8")).addresses;
  const did = new ethers.Contract(dep.AgentDID, didArt.abi, wallet);

  console.log("   部署 AuditLogOptimized...");
  const OptFactory = new ethers.ContractFactory(optArt.abi, optArt.bytecode, wallet);
  const opt = await withRetry(async () => { const c = await OptFactory.deploy(); await c.waitForDeployment(); return c; }, "deploy");
  const optAddr = await opt.getAddress();
  console.log(`   AuditLogOptimized: ${optAddr}`);
  await withRetry(async () => (await opt.setAgentDID(dep.AgentDID)).wait(), "setAgentDID");

  // 确认 wallet 已注册为 agent（E1 已注册过）
  let registered = false;
  try { const info = await withRetry(() => did.getAgent(wallet.address), "getAgent"); registered = Boolean(info.isActive ?? info[4]); } catch {}
  if (!registered) {
    const c = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [ethers.id("on"), ethers.id("os")]));
    await withRetry(async () => (await did.registerAgentWithPubKey("did:oracle:opt", c, "qa", wallet.address)).wait(), "register");
  }

  const domain = { name: "ORACLE AuditLog", version: "1", chainId: 11155111, verifyingContract: optAddr };
  const DT = { Decision: [{ name: "taskHash", type: "bytes32" }, { name: "rankedAgents", type: "bytes32" }, { name: "topAgent", type: "address" }, { name: "timestamp", type: "uint256" }] };
  const RT = { Result: [{ name: "recordId", type: "uint256" }, { name: "resultDigest", type: "bytes32" }, { name: "timestamp", type: "uint256" }] };

  const N = 5;
  const acc = { M1_log: [], M1_update: [], M5_log: [], M5_update: [] };

  for (let i = 0; i < N; i++) {
    const th = ethers.keccak256(ethers.toUtf8Bytes("st" + i + Date.now())), rk = ethers.keccak256(ethers.toUtf8Bytes("sr" + i));
    const ts = Math.floor(Date.now() / 1000);
    const sig = await wallet.signTypedData(domain, DT, { taskHash: th, rankedAgents: rk, topAgent: wallet.address, timestamp: ts });
    const dig = ethers.keccak256(ethers.toUtf8Bytes("sres" + i));

    // M1 log + update
    let r = await withRetry(async () => (await opt.logScheduleEventOnly(wallet.address, wallet.address, ethers.keccak256(ethers.toUtf8Bytes("s1c" + i + Date.now())), 0, wallet.address, th, rk, ts, sig)).wait(), `M1log#${i}`);
    acc.M1_log.push(Number(r.gasUsed));
    const recM1 = BigInt(r.logs.find(l => l.topics.length >= 2)?.topics[1]);
    let wsig = await wallet.signTypedData(domain, RT, { recordId: recM1, resultDigest: dig, timestamp: ts });
    r = await withRetry(async () => (await opt.updateExecutionEventOnly(recM1, 1, dig, ts, wsig)).wait(), `M1upd#${i}`);
    acc.M1_update.push(Number(r.gasUsed));

    // M5 log + update
    r = await withRetry(async () => (await opt.logScheduleEncoded(wallet.address, wallet.address, ethers.keccak256(ethers.toUtf8Bytes("s5c" + i + Date.now())), 0, wallet.address, th, rk, ts, sig)).wait(), `M5log#${i}`);
    acc.M5_log.push(Number(r.gasUsed));
    const recM5 = BigInt(r.logs.find(l => l.topics.length >= 2)?.topics[1]);
    wsig = await wallet.signTypedData(domain, RT, { recordId: recM5, resultDigest: dig, timestamp: ts });
    r = await withRetry(async () => (await opt.updateExecutionEncoded(recM5, 1, dig, ts, wsig)).wait(), `M5upd#${i}`);
    acc.M5_update.push(Number(r.gasUsed));

    console.log(`  [${i + 1}/${N}] M1=${acc.M1_log[i] + acc.M1_update[i]} | M5=${acc.M5_log[i] + acc.M5_update[i]}`);
  }

  const mean = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const s = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, mean(v)]));
  const dM1 = s.M1_log + s.M1_update, dM5 = s.M5_log + s.M5_update;
  const baseline = 405126; // E1 原版 Sepolia 实测
  const usd = (g) => +(g * GWEI * 1e-9 * ETH_USD).toFixed(4);

  const report = {
    timestamp: new Date().toISOString(), network: "sepolia", chainId: 11155111, samples: N,
    optimizedContract: optAddr,
    perOperation_gas: s,
    dispatch: {
      "原版(E1实测基线)": { gas: baseline, usd20gwei: usd(baseline) },
      "M1+M3 event-only": { gas: dM1, usd20gwei: usd(dM1), vsBaselinePct: +(100 * (1 - dM1 / baseline)).toFixed(1) },
      "M5 编码(零锚点)": { gas: dM5, usd20gwei: usd(dM5), vsBaselinePct: +(100 * (1 - dM5 / baseline)).toFixed(1) },
    },
    note: "Sepolia 真实测试网实测优化合约 gas,坐实本地确定性测量。原版基线取 E1 实测 405,126。",
  };

  const outDir = path.join(__dirname, "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "optimized-sepolia.json"), JSON.stringify(report, null, 2));

  console.log(`\n===== 优化合约 Sepolia 实测 =====`);
  console.log(`  原版基线(E1):      ${baseline.toLocaleString()} gas  $${usd(baseline)}@20gwei`);
  console.log(`  M1+M3 event-only:  ${dM1.toLocaleString()} gas  $${usd(dM1)}  (省 ${report.dispatch["M1+M3 event-only"].vsBaselinePct}%)`);
  console.log(`  M5 编码(零锚点):   ${dM5.toLocaleString()} gas  $${usd(dM5)}  (省 ${report.dispatch["M5 编码(零锚点)"].vsBaselinePct}%)`);
  console.log(`\n📊 → experiments/data/optimized-sepolia.json`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
