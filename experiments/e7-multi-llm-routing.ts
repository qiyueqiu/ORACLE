/**
 * 实验 E7：路由打分器的多 LLM 泛化（回应 ICCC 审稿意见 R1-2）
 *
 * 【问题】审稿人问:路由算法只在 Qwen2.5 / DeepSeek 上验证,换 Llama / GPT 等
 * 开源、闭源模型是否仍然普适?
 *
 * 【澄清】路由的“学习/收敛”性质(E4)是确定性 bandit 模拟,与具体 LLM 无关。
 * LLM 真正介入的是 RouterAgent 的【候选打分路径】(evaluateCandidates):模型读
 * 候选 agent 的资质与信誉,按论文公式 (3) score = 0.6·q + 0.4·rNorm 给出排序。
 * E7 测的正是这一路径在不同模型上的【保真度】——评分规则已写进 prompt,故一个
 * 合格的打分器应当复现规则排序;能复现即说明路由逻辑不依赖特定模型。
 *
 * 【方法】(model-agnostic 的可证据化)
 *   - 复用【生产】RouterAgent.evaluateCandidates,不另写打分逻辑;
 *   - 用【确定性纯函数】ruleScore 对同一候选集排序作为 ground-truth(论文公式 (3));
 *   - 每个模型跑全部固定场景,测三项:
 *       (1) Top-1 一致率:模型选出的最优 agent == 规则最优;
 *       (2) 排序保真度:Kendall τ-b(模型排序 vs 规则排序);
 *       (3) 兜底率:模型 JSON 解析失败触发确定性 ruleScore 兜底的比例
 *           —— 兜底命中不计入 LLM 命中,避免虚高(从 executionLog 判定)。
 *   - 场景含“信誉逆转陷阱”(不匹配但高信誉 vs 匹配但零信誉,规则让前者胜),
 *     考验模型是否严格执行公式而非凭直觉。
 *
 * 【模型池】默认走 SiliconFlow(SILICONFLOW_API_KEY)开源池;每个候选模型先
 * preflight 探活,不可用则跳过并记录(不静默截断)。GPT 等 OpenAI 兼容闭源模型
 * 经 OPENAI_API_KEY + OPENAI_BASE_URL 注入(复用可配置 baseURL 的 SiliconFlowClient)。
 *
 * 【运行】(cwd = 项目根;用 agents 包内的 tsx)
 *   ./agents/node_modules/.bin/tsx experiments/e7-multi-llm-routing.ts            # 真跑
 *   ./agents/node_modules/.bin/tsx experiments/e7-multi-llm-routing.ts --dry-run  # 校验指标管道(不调 API)
 *   REPEAT=3 ...                                                                  # 每场景重复取多数(默认 1)
 * 输出:experiments/data/e7-results.json
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RouterAgent, ruleScore } from '../agents/src/router-agent.js';
import { SiliconFlowClient } from '../agents/src/siliconflow-client.js';
import type { Candidate, Intent, Qualification } from '../agents/src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ────────────────────────────────────────────────────────────────────────────
// 模型池:每项 { label(表格用短名), model(API id), provider }
// SiliconFlow 上的确切 id 会随目录变动,故列一个较大候选集,preflight 过滤不可用者。
// ────────────────────────────────────────────────────────────────────────────
// 模型矩阵(覆盖审稿人 R1-2 点名的四大家族:Qwen / DeepSeek / Llama / GPT)
//
// 【设计原则(2026-07-19 确认)】
// 只测"能可靠完成 JSON 打分任务"的模型。fallback 到 ruleScore 的正确语义是
// "LLM 服务不可用(超时/网络/API error)",不是"能力不足"。7B 已确认因输出损坏
// (所有温度下括号错配/字段拼写错乱)不符合标准,已移除。
//
//   scale 轴:Qwen2.5 稠密规模阶梯(控架构,只变参数量,7→14→32→72B)
//   family 轴:DeepSeek-V3 / Llama-3.3-70B / GPT-4o 与 Qwen2.5-72B 同档对比
//
// 【代际对齐原则(2026-07-19 用户确认)】所有模型必须同一代际(late-2024),
// 否则 family 轴差异无法区分"架构差异"与"新模型更强"。
// Qwen2.5-72B 是两轴交点。下架/超时/缺 key 的模型由 preflight 记入 skipped。
// keyEnv/baseEnv:该模型从哪个环境变量读 key 与 endpoint。缺省走 SiliconFlow。
// GPT 与 Llama 用【各自独立】的 key/base(可来自不同供应商),故不再共用单一 openai 池。
// sizeLabel:如实显示的规模标签(MoE 或未公开参数不能强塞成一个数字)。
interface ModelSpec {
  label: string; model: string; provider: 'siliconflow' | 'openai';
  axis: 'scale' | 'family'; params: number; sizeLabel?: string;
  keyEnv?: string; baseEnv?: string; defaultBase?: string;
}

const SILICONFLOW_POOL: ModelSpec[] = [
  // Qwen 规模阶梯(SiliconFlow 稳定可用,late-2024 代)
  // 7B 为鲁棒性下界:小参数模型 JSON 打分能力不足时,确定性 ruleScore fallback 接管,
  // 路由仍正确 —— 高 fallback 率是"优雅降级"的证据,非缺陷(2026-07-19 用户确认保留)。
  { label: 'Qwen2.5-7B',  model: 'Qwen/Qwen2.5-7B-Instruct',  provider: 'siliconflow', axis: 'scale',  params: 7  },
  { label: 'Qwen2.5-14B', model: 'Qwen/Qwen2.5-14B-Instruct', provider: 'siliconflow', axis: 'scale',  params: 14 },
  { label: 'Qwen2.5-32B', model: 'Qwen/Qwen2.5-32B-Instruct', provider: 'siliconflow', axis: 'scale',  params: 32 },
  { label: 'Qwen2.5-72B', model: 'Qwen/Qwen2.5-72B-Instruct', provider: 'siliconflow', axis: 'scale',  params: 72 }, // 两轴交点
  // DeepSeek 家族(V3: late-2024,与 Qwen2.5 同代际;prompt 修复后 13s 内完成,不超时)
  // 671B 总参 / 37B 激活的 MoE —— params 字段仅供排序,规模如实记于 sizeLabel。
  { label: 'DeepSeek-V3', model: 'deepseek-ai/DeepSeek-V3', provider: 'siliconflow', axis: 'family', params: 671, sizeLabel: '671B MoE (37B active)' },
];

// 闭源/外部池:GPT 与 Llama 各自独立的 key + endpoint(可来自不同供应商),互不依赖。
// 每个模型只在其 keyEnv 环境变量存在时启用;preflight 探活失败则记 skipped,不阻塞他者。
//
// GPT-4o(锁定 2024-11-20 快照,保证复现,不用漂移的 gpt-4o 别名):
//   OPENAI_API_KEY=<OpenAI key>  [OPENAI_BASE_URL 默认 https://api.openai.com/v1]
// Llama-3.3-70B(2024-12,与 DeepSeek-V3 同月;SiliconFlow 已下架,需第三方兼容端点):
//   LLAMA_API_KEY=<Together/Groq/Fireworks key>  LLAMA_BASE_URL=<对应 /v1 端点>
//   型号 ID 随端点而定(Together: meta-llama/Llama-3.3-70B-Instruct-Turbo;
//   Groq: llama-3.3-70b-versatile;Fireworks: accounts/fireworks/models/llama-v3p3-70b-instruct)——
//   端点确定后改本条 model 字段即可。此处占位 Together 型号(用户确认端点后更新)。
// 端点:云雾(yunwu.ai)OpenAI 兼容聚合站,GPT 与 Llama 共用同一 key+base(经 env 注入)。
// 型号 ID 经 2026-07-19 连通性+打分负载实测确定(见会话记录):
//   GPT   = gpt-4o-2024-11-20(锁定快照,稳定返回完整 rankings)
//   Llama = llama-3.3-70b(云雾目录 ID;-instruct 后缀偶发 503,不用)
// 注:两者经云雾偶发只返回 1 条 ranking(prompt 示例只给单元素→GPT/Llama 照字面),
//     最终跑前需把 prompt 示例改为显式"为所有候选各返回一条"并重验 Qwen/DeepSeek。
const EXTERNAL_POOL: ModelSpec[] = [
  { label: 'GPT-4o', model: 'gpt-4o-2024-11-20', provider: 'openai', axis: 'family', params: 0, sizeLabel: 'undisclosed',
    keyEnv: 'OPENAI_API_KEY', baseEnv: 'OPENAI_BASE_URL', defaultBase: 'https://yunwu.ai/v1' },
  { label: 'Llama-3.3-70B', model: 'llama-3.3-70b', provider: 'openai', axis: 'family', params: 70, sizeLabel: '70B',
    keyEnv: 'LLAMA_API_KEY', baseEnv: 'LLAMA_BASE_URL', defaultBase: 'https://yunwu.ai/v1' },
];

// ────────────────────────────────────────────────────────────────────────────
// 路由场景:每个 = 一个任务 + 一组候选(资质/信誉不同)。ground-truth 由 ruleScore 定。
// 覆盖:匹配主导(易)、多匹配比信誉(中)、信誉逆转陷阱(难,规则让不匹配高信誉者胜)。
// ────────────────────────────────────────────────────────────────────────────
interface CandSpec { did: string; qualification: Qualification; avgRating: number; }
interface Scenario { id: string; task: string; requiredQualification: Qualification; candidates: CandSpec[]; kind: string; }

const SCENARIOS: Scenario[] = [
  {
    id: 'S01', kind: 'match-dominant', task: '审查这段 Solidity 合约的重入漏洞', requiredQualification: 'code_review',
    candidates: [
      { did: 'did:agent:reviewer-hi', qualification: 'code_review', avgRating: 90 },
      { did: 'did:agent:writer',      qualification: 'creative',    avgRating: 70 },
      { did: 'did:agent:translator',  qualification: 'translation', avgRating: 50 },
    ],
  },
  {
    id: 'S02', kind: 'multi-match-by-rep', task: '把季度销售数据做趋势分析', requiredQualification: 'data_analysis',
    candidates: [
      { did: 'did:agent:analyst-hi',  qualification: 'data_analysis', avgRating: 92 },
      { did: 'did:agent:analyst-mid', qualification: 'data_analysis', avgRating: 60 },
      { did: 'did:agent:analyst-lo',  qualification: 'data_analysis', avgRating: 30 },
    ],
  },
  {
    id: 'S03', kind: 'reputation-inversion', task: '把这份技术文档翻译成英文', requiredQualification: 'translation',
    // 陷阱:匹配但零信誉 translator(36) vs 不匹配但满信誉 researcher(40)。规则让 researcher 胜。
    candidates: [
      { did: 'did:agent:translator-new', qualification: 'translation', avgRating: 0 },
      { did: 'did:agent:researcher-top', qualification: 'research',    avgRating: 100 },
      { did: 'did:agent:writer-mid',     qualification: 'creative',    avgRating: 55 },
    ],
  },
  {
    id: 'S04', kind: 'match-dominant', task: '写一首关于深圳的现代诗', requiredQualification: 'creative',
    candidates: [
      { did: 'did:agent:poet',       qualification: 'creative',      avgRating: 80 },
      { did: 'did:agent:analyst',    qualification: 'data_analysis', avgRating: 88 },
      { did: 'did:agent:coder',      qualification: 'code_review',   avgRating: 65 },
    ],
  },
  {
    id: 'S05', kind: 'boundary', task: '调研 2026 年 L2 rollup 的最新进展', requiredQualification: 'research',
    // 边界:匹配 researcher avgRating=67 → 36+0.4*26.8=46.72 vs 不匹配 analyst 100 → 40。匹配者胜。
    candidates: [
      { did: 'did:agent:researcher-ok', qualification: 'research',      avgRating: 67 },
      { did: 'did:agent:analyst-top',   qualification: 'data_analysis', avgRating: 100 },
      { did: 'did:agent:writer-lo',     qualification: 'creative',      avgRating: 20 },
    ],
  },
  {
    id: 'S06', kind: 'multi-match-by-rep', task: '审查后端 API 的鉴权逻辑是否安全', requiredQualification: 'code_review',
    candidates: [
      { did: 'did:agent:sec-a', qualification: 'code_review', avgRating: 75 },
      { did: 'did:agent:sec-b', qualification: 'code_review', avgRating: 85 },
      { did: 'did:agent:sec-c', qualification: 'code_review', avgRating: 55 },
      { did: 'did:agent:doc',   qualification: 'content',     avgRating: 95 },
    ],
  },
  {
    id: 'S07', kind: 'reputation-inversion', task: '计算这批订单的加权平均交付时长', requiredQualification: 'calc',
    // 陷阱:匹配 calc 零信誉(36) vs 不匹配 data_analysis 满信誉(40)。规则让 analyst 胜。
    candidates: [
      { did: 'did:agent:calc-new',   qualification: 'calc',          avgRating: 5 },
      { did: 'did:agent:analyst-hi', qualification: 'data_analysis', avgRating: 98 },
    ],
  },
  {
    id: 'S08', kind: 'match-dominant', task: '明天深圳适合户外跑步吗', requiredQualification: 'weather',
    candidates: [
      { did: 'did:agent:weather',  qualification: 'weather',    avgRating: 70 },
      { did: 'did:agent:coder',    qualification: 'code_review', avgRating: 60 },
      { did: 'did:agent:creative', qualification: 'creative',   avgRating: 40 },
    ],
  },
  {
    id: 'S09', kind: 'multi-match-by-rep', task: '为新产品写一段发布文案', requiredQualification: 'content',
    candidates: [
      { did: 'did:agent:content-hi',  qualification: 'content', avgRating: 88 },
      { did: 'did:agent:content-mid', qualification: 'content', avgRating: 66 },
      { did: 'did:agent:content-lo',  qualification: 'content', avgRating: 44 },
    ],
  },
  {
    id: 'S10', kind: 'boundary', task: '分析用户流失数据并给出建议', requiredQualification: 'data_analysis',
    // 匹配 analyst 50 → 36+8=44 vs 不匹配 research 90 → 24+14.4=38.4。匹配者胜。
    candidates: [
      { did: 'did:agent:analyst-ok', qualification: 'data_analysis', avgRating: 50 },
      { did: 'did:agent:research-hi', qualification: 'research',     avgRating: 90 },
      { did: 'did:agent:calc-mid',   qualification: 'calc',          avgRating: 60 },
    ],
  },
  {
    id: 'S11', kind: 'reputation-inversion', task: '把这篇英文论文摘要翻成中文', requiredQualification: 'translation',
    // 匹配 translator 40 → 36+6.4=42.4 vs 不匹配 research 100 → 40。匹配者(低信誉)仍险胜 → 考验精细算术。
    candidates: [
      { did: 'did:agent:translator-lo', qualification: 'translation', avgRating: 40 },
      { did: 'did:agent:research-top',  qualification: 'research',    avgRating: 100 },
    ],
  },
  {
    id: 'S12', kind: 'multi-match-by-rep', task: '审查这个 React 组件的性能问题', requiredQualification: 'code_review',
    candidates: [
      { did: 'did:agent:fe-a', qualification: 'code_review', avgRating: 40 },
      { did: 'did:agent:fe-b', qualification: 'code_review', avgRating: 95 },
      { did: 'did:agent:fe-c', qualification: 'code_review', avgRating: 70 },
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────────────────────

/** 由场景规格构造生产 Candidate[](确定性地址,便于复现)。 */
function buildCandidates(s: Scenario): Candidate[] {
  return s.candidates.map((c, i) => ({
    address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    did: c.did,
    qualification: c.qualification,
    avgRating: c.avgRating,
    ratingCount: 5, // 固定,非评分变量
    isActive: true,
    score: 0,
  }));
}

/** ground-truth:按 ruleScore 降序的 address 列表 + top-1 并列集合(容忍 tie)。 */
function groundTruth(s: Scenario): { order: string[]; scoreByAddr: Map<string, number>; top1Set: Set<string> } {
  const cands = buildCandidates(s);
  const scoreByAddr = new Map<string, number>();
  for (const c of cands) scoreByAddr.set(c.address, ruleScore(c, s.requiredQualification));
  const order = [...cands].sort((a, b) => scoreByAddr.get(b.address)! - scoreByAddr.get(a.address)!).map((c) => c.address);
  const top = scoreByAddr.get(order[0])!;
  const top1Set = new Set(cands.filter((c) => Math.abs(scoreByAddr.get(c.address)! - top) < 1e-9).map((c) => c.address));
  return { order, scoreByAddr, top1Set };
}

/** Kendall τ-b(处理并列):比较模型排序与 ground-truth 排序的一致性,范围 [-1,1]。 */
function kendallTauB(rankA: Map<string, number>, rankB: Map<string, number>, keys: string[]): number {
  let concordant = 0, discordant = 0, tieA = 0, tieB = 0;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = rankA.get(keys[i])! - rankA.get(keys[j])!;
      const b = rankB.get(keys[i])! - rankB.get(keys[j])!;
      const sa = Math.sign(a), sb = Math.sign(b);
      if (sa === 0 && sb === 0) { tieA++; tieB++; }
      else if (sa === 0) tieA++;
      else if (sb === 0) tieB++;
      else if (sa === sb) concordant++;
      else discordant++;
    }
  }
  const n0 = concordant + discordant + tieA + tieB - (tieA && tieB ? 0 : 0);
  const denom = Math.sqrt((concordant + discordant + tieA) * (concordant + discordant + tieB));
  return denom === 0 ? 1 : (concordant - discordant) / denom;
}

/** 把 address→分数 转成 address→名次(分数高=名次小)。 */
function toRankMap(scoreByAddr: Map<string, number>): Map<string, number> {
  const sorted = [...scoreByAddr.entries()].sort((a, b) => b[1] - a[1]);
  const rank = new Map<string, number>();
  sorted.forEach(([addr], i) => rank.set(addr, i));
  return rank;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();
/** 每模型墙钟预算(ms):防慢模型拖死全局;可经 MODEL_BUDGET_S 覆盖。 */
const MODEL_BUDGET_MS = Math.max(30, parseInt(process.env.MODEL_BUDGET_S || '150', 10)) * 1000;

/** 对一个模型跑单场景一次,返回该次的判定(是否兜底、模型 top-1、模型排序)。 */
async function runOnce(router: RouterAgent, s: Scenario): Promise<{ usedFallback: boolean; top1: string; scoreByAddr: Map<string, number>; error?: string }> {
  const cands = buildCandidates(s);
  const intent: Intent = { intent: s.task, requiredQualification: s.requiredQualification, complexity: 'medium', priority: 'quality' };
  router.executionLog = [];
  try {
    const { candidates } = await router.evaluateCandidates(cands, intent, s.requiredQualification);
    // 从 executionLog 判定是否走了确定性兜底(兜底命中不算 LLM 命中,防虚高)。
    const evalLog = router.executionLog.filter((e) => e.phase === 'candidate_evaluation').pop();
    const usedFallback = !!evalLog && evalLog.output.startsWith('Fallback to rule-based');
    const scoreByAddr = new Map<string, number>();
    for (const c of candidates) scoreByAddr.set(c.address, c.score);
    const top1 = [...candidates].sort((a, b) => b.score - a.score)[0].address;
    return { usedFallback, top1, scoreByAddr };
  } catch (e) {
    return { usedFallback: true, top1: '', scoreByAddr: new Map(), error: e instanceof Error ? e.message : String(e) };
  }
}

/** preflight:发一个最小请求探活,返回可用性。 */
async function probe(client: SiliconFlowClient, model: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    await client.chat(model, [{ role: 'user', content: 'ping' }], { max_tokens: 1, temperature: 0, timeoutMs: 20000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 120) : String(e) };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────────────────
async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');
  const REPEAT = Math.max(1, parseInt(process.env.REPEAT || '1', 10));
  const DUMMY_PROVIDER = 'http://127.0.0.1:8545'; // evaluateCandidates 不碰 provider,仅构造用
  const DUMMY_ADDRS = { AgentDID: `0x${'0'.repeat(40)}`, AuditLog: `0x${'0'.repeat(40)}`, Reputation: `0x${'0'.repeat(40)}` };

  // 密钥
  const sfKey = process.env.SILICONFLOW_API_KEY || '';

  // ── ground-truth 自检:场景设计的正确性(每个 kind 至少符合预期语义)──
  const gtSummary = SCENARIOS.map((s) => {
    const gt = groundTruth(s);
    const cands = buildCandidates(s);
    const top = cands.find((c) => c.address === gt.order[0])!;
    return { id: s.id, kind: s.kind, gtTop1Did: top.did, gtTop1Match: top.qualification === s.requiredQualification, tie: gt.top1Set.size > 1 };
  });

  // ── DRY-RUN:用 ruleScore 冒充“完美模型”验证指标管道(应得 top1=100%, τ=1)──
  if (DRY_RUN) {
    let top1Hit = 0; const taus: number[] = [];
    for (const s of SCENARIOS) {
      const gt = groundTruth(s);
      const perfect = new Map(gt.scoreByAddr); // 完美模型 = ground-truth 本身
      const modelTop1 = [...perfect.entries()].sort((a, b) => b[1] - a[1])[0][0];
      if (gt.top1Set.has(modelTop1)) top1Hit++;
      taus.push(kendallTauB(toRankMap(perfect), toRankMap(gt.scoreByAddr), gt.order));
    }
    console.log('[DRY-RUN] 指标管道自检(完美模型应 top1=100%, τ=1.000):');
    console.log(`  Top-1 一致率 = ${(100 * top1Hit / SCENARIOS.length).toFixed(1)}%`);
    console.log(`  平均 Kendall τ-b = ${(taus.reduce((a, b) => a + b, 0) / taus.length).toFixed(3)}`);
    console.log(`  场景数 = ${SCENARIOS.length}, ground-truth 摘要:`);
    for (const g of gtSummary) console.log(`    ${g.id} [${g.kind}] top1=${g.gtTop1Did} match=${g.gtTop1Match} tie=${g.tie}`);
    return;
  }

  // ── 组装模型池:每个模型按其 keyEnv 决定是否启用,各自独立 key/endpoint ──
  const keyFor = (m: ModelSpec) => (m.keyEnv ? process.env[m.keyEnv] || '' : sfKey);
  const baseFor = (m: ModelSpec) => (m.baseEnv ? process.env[m.baseEnv] || m.defaultBase : undefined);

  const pool: ModelSpec[] = [];
  if (sfKey) pool.push(...SILICONFLOW_POOL);
  else console.log('⚠ SILICONFLOW_API_KEY 未设置,跳过开源池(Qwen/DeepSeek)');
  for (const m of EXTERNAL_POOL) {
    if (keyFor(m)) pool.push(m);
    else console.log(`ℹ ${m.keyEnv} 未设置,跳过 ${m.label}(待补 key 后重跑并入表)`);
  }

  // MODELS=Qwen2.5-7B,Llama-3.3-70B → 仅跑指定 label(诊断/局部重跑用,逗号分隔)。
  const only = (process.env.MODELS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const filtered = only.length ? pool.filter((m) => only.includes(m.label)) : pool;
  if (only.length) console.log(`ℹ MODELS 过滤 → 仅跑: ${filtered.map((m) => m.label).join(', ') || '(无匹配)'}`);

  if (filtered.length === 0) { console.error('无可用模型池(缺 key 或 MODELS 无匹配)。'); process.exit(1); }

  // 每个「key+base」组合缓存一个 client(GPT 与 Llama 可指向不同供应商)。
  // SiliconFlow 池关闭推理(enable_thinking=false),使 DeepSeek-V3 等混合推理模型
  // 与非推理模型在同一条件下单次打分(更快、可比);OpenAI/Together 端点不认此字段,不开。
  const clientCache = new Map<string, SiliconFlowClient>();
  const clientFor = (m: ModelSpec) => {
    const key = keyFor(m), base = baseFor(m);
    const cacheKey = `${key}@@${base ?? 'default'}`;
    let c = clientCache.get(cacheKey);
    if (!c) {
      c = new SiliconFlowClient(key, undefined, base, { disableThinking: m.provider === 'siliconflow' });
      clientCache.set(cacheKey, c);
    }
    return c;
  };

  // ── preflight 探活,过滤不可用模型(不静默截断:记录 skipped)──
  console.log(`\n=== E7 preflight（探活 ${filtered.length} 个候选模型）===`);
  const available: ModelSpec[] = []; const skipped: Array<{ label: string; model: string; reason: string }> = [];
  for (const m of filtered) {
    const { ok, reason } = await probe(clientFor(m), m.model);
    if (ok) { available.push(m); console.log(`  ✓ ${m.label} (${m.model})`); }
    else { skipped.push({ label: m.label, model: m.model, reason: reason || 'unknown' }); console.log(`  ✗ ${m.label} (${m.model}) — ${reason}`); }
    await sleep(200);
  }
  if (available.length === 0) { console.error('preflight 后无可用模型。'); process.exit(1); }

  // 增量写盘 + 断点续跑:每个模型跑完立即落盘;重跑时已完成(相同 model+repeat)的
  // 模型直接复用,避免大模型慢导致的超时前功尽弃。FRESH=1 强制重算。
  const outDir = join(__dirname, 'data');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, process.env.OUT || 'e7-results.json');
  const FRESH = process.env.FRESH === '1';
  const externalIncluded = available.some((m) => m.provider === 'openai');

  interface ModelSummary { label: string; model: string; provider: string; axis?: string; params?: number; sizeLabel?: string; top1Accuracy: number; avgKendallTau: number | null; fallbackRate: number; scenarios: number; repeat: number; partial?: boolean; perScenario: unknown[]; }
  let perModel: ModelSummary[] = [];
  if (!FRESH && existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8'));
      perModel = (prev.models || []).filter((mm: ModelSummary) => mm.repeat === REPEAT);
      if (perModel.length) console.log(`↻ 复用 ${perModel.length} 个已完成模型(repeat=${REPEAT}):${perModel.map((x) => x.label).join(', ')}`);
    } catch { /* 损坏则忽略,重算 */ }
  }

  function persist() {
    const results = {
      generatedNote: 'E7 multi-LLM routing generalization; reuses production RouterAgent.evaluateCandidates; ground-truth = deterministic ruleScore (paper Eq.3); stamp time externally',
      method: {
        groundTruth: 'ruleScore(candidate, requiredQualification) = 0.6*q + 0.4*(avgRating*0.4), q∈{60,40}',
        metrics: ['top1Accuracy (LLM-selected best == rule best; fallback runs counted as miss)', 'avgKendallTau (rank fidelity vs rule ordering)', 'fallbackRate (JSON-parse failure → deterministic fallback)'],
        reuseNote: 'production evaluateCandidates path exercised verbatim; only the scoring model id is swapped (RouterAgent scoringModel param) — model-agnostic by construction',
        design: 'four-family coverage (Qwen/DeepSeek/Llama/GPT per reviewer R1-2), all late-2024 generation for fair cross-family comparison (avoids conflating architecture differences with newer-model effects): scale axis = Qwen2.5 dense 7/14/32/72B (architecture fixed, params varied); family axis = DeepSeek-V3 (671B MoE) / Llama-3.3-70B / GPT-4o-2024-11-20 vs Qwen2.5-72B pivot. 7B is the robustness lower bound: when a small model cannot emit valid JSON, the deterministic ruleScore fallback takes over and routing stays correct.',
        scenarioKinds: ['match-dominant', 'multi-match-by-rep', 'reputation-inversion (trap)', 'boundary'],
        externalIncluded: externalIncluded,
        externalNote: externalIncluded ? 'GPT-4o / Llama-3.3-70B included via independent OpenAI-compatible endpoints (both late-2024, same generation as Qwen2.5/DeepSeek-V3)' : 'GPT-4o (OPENAI_API_KEY) / Llama-3.3-70B (LLAMA_API_KEY + LLAMA_BASE_URL) pending key; DeepSeek-V3 represents the non-Qwen family in the interim (same late-2024 generation)',
      },
      groundTruthSelfCheck: gtSummary,
      skippedModels: skipped,
      models: perModel,
    };
    writeFileSync(outPath, JSON.stringify(results, null, 2));
  }

  // ── 逐模型跑全部场景 ──
  console.log(`\n=== E7 评估（${available.length} 个模型 × ${SCENARIOS.length} 场景 × repeat=${REPEAT}）===`);
  const done = new Set(perModel.map((x) => x.model));
  for (const m of available) {
    if (done.has(m.model)) { const p = perModel.find((x) => x.model === m.model)!; console.log(`  ${m.label.padEnd(16)} (cached) top1=${(100 * p.top1Accuracy).toFixed(1)}%  τ=${p.avgKendallTau ?? 'n/a'}  fallback=${(100 * p.fallbackRate).toFixed(1)}%`); continue; }
    // apiKey 参数仅在未注入 client 时用于内部兜底构造;这里始终注入 clientFor(m),故仅占位。
    const router = new RouterAgent(keyFor(m), DUMMY_PROVIDER, DUMMY_ADDRS, clientFor(m), m.model);
    let top1Hit = 0, fallbackCount = 0, total = 0; const taus: number[] = []; const perScenario = [];
    // 每模型墙钟预算:慢模型(如 7B 反复生成满 token 的坏 JSON)不拖死全局;
    // 超时则停止该模型剩余场景,用已跑场景算指标并标 partial(诚实披露,不静默截断)。
    const modelStart = nowMs(); let partial = false; let scenariosRun = 0;
    for (const s of SCENARIOS) {
      if (nowMs() - modelStart > MODEL_BUDGET_MS) { partial = true; console.log(`  ⚠ ${m.label} 超每模型预算 ${MODEL_BUDGET_MS / 1000}s,已跑 ${scenariosRun}/${SCENARIOS.length} 场景,停止剩余`); break; }
      const gt = groundTruth(s);
      // repeat 次取多数 top-1 + 平均 τ;任一次兜底则该次不计入 LLM 命中。
      const top1Votes: Record<string, number> = {}; let sceneFallback = 0; const sceneTaus: number[] = []; let lastErr: string | undefined;
      for (let r = 0; r < REPEAT; r++) {
        const res = await runOnce(router, s);
        total++;
        if (res.usedFallback) { sceneFallback++; fallbackCount++; if (res.error) lastErr = res.error; }
        else {
          top1Votes[res.top1] = (top1Votes[res.top1] || 0) + 1;
          sceneTaus.push(kendallTauB(toRankMap(res.scoreByAddr), toRankMap(gt.scoreByAddr), gt.order));
        }
        await sleep(80);
      }
      scenariosRun++;
      const llmRuns = REPEAT - sceneFallback;
      const majTop1 = Object.entries(top1Votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      const hit = llmRuns > 0 && gt.top1Set.has(majTop1);
      if (hit) top1Hit++;
      const sceneTau = sceneTaus.length ? sceneTaus.reduce((a, b) => a + b, 0) / sceneTaus.length : null;
      if (sceneTau !== null) taus.push(sceneTau);
      perScenario.push({ id: s.id, kind: s.kind, gtTop1: gt.order[0], modelTop1: majTop1, hit, fallbackRuns: sceneFallback, tau: sceneTau, error: lastErr });
    }

    const scored = scenariosRun; // top-1 分母 = 实际跑的场景数(兜底场景计为未命中,因无 LLM 判定)
    const summary = {
      label: m.label, model: m.model, provider: m.provider, axis: m.axis, params: m.params, sizeLabel: m.sizeLabel,
      top1Accuracy: scored ? +(top1Hit / scored).toFixed(4) : 0,
      avgKendallTau: taus.length ? +(taus.reduce((a, b) => a + b, 0) / taus.length).toFixed(4) : null,
      fallbackRate: total ? +(fallbackCount / total).toFixed(4) : 0,
      scenarios: scored, repeat: REPEAT, partial, perScenario,
    };
    perModel.push(summary);
    persist(); // 增量落盘:该模型跑完即保存,超时也不丢已完成结果
    console.log(`  ${m.label.padEnd(16)} top1=${(100 * summary.top1Accuracy).toFixed(1)}%  τ=${summary.avgKendallTau ?? 'n/a'}  fallback=${(100 * summary.fallbackRate).toFixed(1)}%${partial ? ` (partial ${scored}/${SCENARIOS.length})` : ''}`);
  }

  persist();
  console.log(`\nE7 done → ${outPath}  (${perModel.length} 模型)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
