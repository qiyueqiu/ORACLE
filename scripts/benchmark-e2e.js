#!/usr/bin/env node
/**
 * scripts/benchmark-e2e.js — E2 端到端时延分解（论文 §5.3 承诺、此前从未建的文件）
 *
 * 驱动 POST /api/dispatch/stream，按 SSE 事件到达时间戳分解各阶段耗时：
 *   T_intent   (start → intent_parsed)        : Router LLM 意图解析
 *   T_candidates (intent_parsed → candidates)  : 链上读候选 agent
 *   T_eval     (candidates → evaluated)        : Router LLM 评分（最重 LLM）
 *   T_route    (evaluated → selected)          : 决策 + EIP-712 路由签名
 *   T_exec     (selected → result)             : Worker LLM 执行（最重 LLM）
 *   T_chain    (result → logged)               : 链上写 AuditLog（Sepolia 出块主导）
 *   T_rep      (logged → reputation_analyzed)  : 信誉分析
 *   T_total    (start → complete)              : 端到端
 *
 * 输出 paper2/data/e2-e2e-latency.json（供论文表/CDF 图）。
 *
 * 前置：api-server 必须在跑（cd agents && npm start），且 .env 指向目标网络
 *       （Sepolia 时 T_chain 反映真实出块；localhost 时反映进程内节点）。
 *
 * 运行：node scripts/benchmark-e2e.js          # 默认 20 次
 *       E2E_N=50 API_BASE=http://localhost:3001 node scripts/benchmark-e2e.js
 */
const fs = require("fs");
const path = require("path");

const API_BASE = process.env.API_BASE || "http://localhost:3001";
const API_KEY = process.env.E2E_API_KEY || (process.env.API_ACCESS_KEYS || "demo-key-change-me").split(",")[0].trim();
const N = Number(process.env.E2E_N || 20);

// 多样化任务，避免 LLM 命中缓存导致延迟失真
const TASKS = [
  "帮我审查这段 Solidity 合约的重入风险",
  "把这段产品介绍翻译成英文并润色",
  "总结这篇关于区块链共识算法的论文要点",
  "为一个电商网站写一段促销文案",
  "分析这组用户行为数据的趋势",
  "检查这段 Python 代码的性能瓶颈",
  "起草一份 SaaS 产品的隐私政策大纲",
  "解释什么是零知识证明，面向非技术读者",
];

// SSE 事件 → 阶段终点锚名
const PHASE_ANCHORS = [
  ["T_intent", "intent_parsed"],
  ["T_candidates", "candidates"],
  ["T_eval", "evaluated"],
  ["T_route", "selected"],
  ["T_exec", "result"],
  ["T_chain", "logged"],
  ["T_rep", "reputation_analyzed"],
];

/** 解析 SSE 文本流，返回 {eventName: relativeMs} 首次到达映射 */
async function runOne(task) {
  const t0 = process.hrtime.bigint();
  const arrivals = {}; // eventName -> ms since start
  const stamp = (name) => {
    if (arrivals[name] === undefined) {
      arrivals[name] = Number(process.hrtime.bigint() - t0) / 1e6;
    }
  };

  const resp = await fetch(`${API_BASE}/api/dispatch/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({ task }),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastEvent = null;
  let errored = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // 按 SSE 帧（\n\n）切分
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) {
          lastEvent = line.slice(6).trim();
          stamp(lastEvent);
          if (lastEvent === "error") errored = frame;
        }
      }
    }
  }
  if (errored) throw new Error(`SSE error 事件: ${errored.slice(0, 150)}`);
  if (arrivals.complete === undefined && arrivals.reputation_analyzed === undefined) {
    throw new Error("流结束但未见 complete/reputation_analyzed 事件");
  }
  return arrivals;
}

/** 从首次到达映射算各阶段耗时（差分），缺失锚点记 null */
function toPhases(a) {
  const order = ["start", "intent_parsed", "candidates", "evaluated", "selected", "result", "logged", "reputation_analyzed", "complete"];
  // start 锚点：取最早事件（通常 start 立即到）
  const startMs = a.start ?? 0;
  const phases = {};
  let prev = startMs;
  let prevName = "start";
  for (let i = 1; i < order.length; i++) {
    const cur = a[order[i]];
    if (cur === undefined) continue;
    phases[`${prevName}->${order[i]}`] = cur - prev;
    prev = cur;
    prevName = order[i];
  }
  // 命名阶段
  const named = {};
  for (const [label, anchor] of PHASE_ANCHORS) {
    named[label] = a[anchor] !== undefined ? a[anchor] : null;
  }
  const total = (a.complete ?? a.reputation_analyzed ?? prev) - startMs;
  return { total, arrivals: a };
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.floor((p / 100) * (sorted.length - 1))];
}

function summarize(arr) {
  const s = [...arr].filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    min: s[0],
    max: s[s.length - 1],
  };
}

async function main() {
  console.log(`🚀 E2 端到端时延：N=${N} | API=${API_BASE}`);
  // 健康检查
  try {
    const h = await fetch(`${API_BASE}/api/health`);
    if (!h.ok) throw new Error(`health HTTP ${h.status}`);
    console.log("   ✓ api-server 健康");
  } catch (e) {
    console.error(`❌ 无法连接 api-server（${API_BASE}）：${e.message}`);
    console.error("   请先启动：cd agents && npm start");
    process.exit(1);
  }

  // 各阶段差分序列 + e2e total 序列
  const stageSeries = {}; // "a->b" -> [ms,...]
  const namedSeries = {}; // T_xxx -> [ms,...]
  for (const [label] of PHASE_ANCHORS) namedSeries[label] = [];
  const totals = [];
  const raw = [];
  let ok = 0, fail = 0;

  for (let i = 0; i < N; i++) {
    const task = TASKS[i % TASKS.length];
    try {
      const arrivals = await runOne(task);
      const { total } = toPhases(arrivals);
      totals.push(total);

      // 阶段差分
      const startMs = arrivals.start ?? 0;
      const order = ["intent_parsed", "candidates", "evaluated", "selected", "result", "logged", "reputation_analyzed"];
      let prev = startMs;
      const labelMap = { intent_parsed: "T_intent", candidates: "T_candidates", evaluated: "T_eval", selected: "T_route", result: "T_exec", logged: "T_chain", reputation_analyzed: "T_rep" };
      for (const ev of order) {
        if (arrivals[ev] === undefined) continue;
        const d = arrivals[ev] - prev;
        const lbl = labelMap[ev];
        namedSeries[lbl].push(d);
        prev = arrivals[ev];
      }
      raw.push({ i, task, total, arrivals });
      ok++;
      console.log(`  [${i + 1}/${N}] e2e=${(total / 1000).toFixed(1)}s | T_chain=${arrivals.logged && arrivals.result ? ((arrivals.logged - arrivals.result) / 1000).toFixed(1) : "?"}s`);
    } catch (e) {
      fail++;
      console.log(`  [${i + 1}/${N}] ❌ ${e.message.slice(0, 80)}`);
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    apiBase: API_BASE,
    n_requested: N,
    n_ok: ok,
    n_fail: fail,
    e2e_total_ms: summarize(totals),
    phases_ms: Object.fromEntries(Object.entries(namedSeries).map(([k, v]) => [k, summarize(v)])),
    note: "各阶段=相邻 SSE 事件到达时间差；T_eval/T_exec 为 LLM 主导，T_chain 为链上出块主导（Sepolia 反映真实出块）。",
    raw,
  };

  const outDir = path.join(__dirname, "..", "paper2", "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "e2-e2e-latency.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n📊 E2 报告 → ${outPath}`);
  console.log(`   成功 ${ok}/${N} | e2e p50=${report.e2e_total_ms ? (report.e2e_total_ms.p50 / 1000).toFixed(1) : "?"}s p95=${report.e2e_total_ms ? (report.e2e_total_ms.p95 / 1000).toFixed(1) : "?"}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
