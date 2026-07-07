/**
 * 实验 E6：质押绑定评分权重（论文 §4.3 A 层）的端到端抗合谋提升
 *
 * 问题：把评分权重从 √ 信誉（rateWeighted，凹、可拆分、新账户白送权重 1）改为
 *       质押线性（rateStakeWeighted，weight=⌊stake/unit⌋，守恒、无质押零权重），
 *       在【同等攻击预算】下能否阻止合谋刷分污染路由？
 *
 * 真实系统语义：坏 agent 执行质量差，一个诚实 requester 给真实低分（20）；攻击者用 K 个
 * Sybil 刷满分（100）覆盖。路由按各 agent 的【加权平均信誉】选择，故防御实质是——诚实
 * 评分者的权重能否主导坏 agent 的平均分：
 *   - √ 加权：诚实者自身信誉 100 → 权重 ⌊√100⌋=10；每个 Sybil 白送权重 1。K 增大到 ~10
 *     以上，Sybil 合计权重压过诚实的 10，坏 agent 平均分越过 reliable 阈值 → 污染。
 *   - 质押加权：诚实者质押 100 → 权重 100；Sybil 须真锁质押，零质押被直接拒绝。攻击预算
 *     B（token）拆成多账户，权重守恒 Σ⌊stakeᵢ/U⌋ ≤ ⌊B/U⌋，须 B≥100 才追平诚实权重，
 *     且这笔质押可被 slash —— 廉价刷分变为「须真金白银且注定亏损」。
 *
 * 做攻击预算扫描 K ∈ {2,5,10,15,20,30,40}，对每个 K 用真实合约测两种机制下坏 agent 的
 * 加权平均信誉、是否越过 reliable 阈值、是否翻转路由。找出 √ 加权的崩溃点与质押加权的稳固区。
 *
 * 全部用真实 Reputation.sol / AgentStake.sol 合约测量（非纯数值模拟）。
 * 输出 experiments/data/e6-results.json。
 * 运行：npx hardhat run experiments/e6-stake-weighted.js
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const ethers = hre.ethers;
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const honestAgent = signers[1];
  const badAgent = signers[2];
  const honestRater = signers[3];

  const E = ethers.parseEther.bind(ethers);

  // 路由打分（与合约 §3.6 一致）：score = 0.6·q + 0.4·(0.4·r̄)。两 agent 同资质 60，
  // 故路由差异完全由信誉 r̄ 决定；reliable 阈值 = 60。
  const QMATCH = 60;
  const RELIABLE = 60;
  function routeScore(repAvg) { return 0.6 * QMATCH + 0.4 * (0.4 * repAvg); }

  const HONEST_QUALITY = 85;  // 好 agent 真实质量
  const BAD_QUALITY = 20;     // 坏 agent 真实质量
  const HONEST_STAKE = 100;   // 诚实评分者质押（权重 100）
  const HONEST_REP = 100;     // 诚实评分者自身信誉（√ 权重 = 10）

  const BUDGETS = [2, 5, 10, 15, 20, 30, 40];

  // 为扫描创建足够的 Sybil 钱包（由 owner 注资 gas），复用于两种机制
  const maxK = Math.max(...BUDGETS);
  const sybilWallets = [];
  for (let i = 0; i < maxK; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    sybilWallets.push(w);
  }
  // 注资 gas（每个 0.05 ETH 足够多次评分交易）
  for (const w of sybilWallets) {
    await owner.sendTransaction({ to: w.address, value: E("0.05") });
  }

  async function deployStack() {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy();
    const AgentStake = await ethers.getContractFactory("AgentStake");
    const stake = await AgentStake.deploy(await token.getAddress());
    const Reputation = await ethers.getContractFactory("Reputation");
    const rep = await Reputation.deploy();
    await rep.setAgentStake(await stake.getAddress());
    return { token, stake, rep };
  }

  async function fundStake(token, stake, signer, amountEther) {
    const amt = E(String(amountEther));
    await token.mint(signer.address, amt);
    await token.connect(signer).approve(await stake.getAddress(), amt);
    await stake.connect(signer).stake(amt);
  }

  // ---- 世界 1：√ 加权，攻击预算 = K 个廉价 Sybil（addRating 权重恒 1）----
  async function sqrtWorld(K) {
    const { rep } = await deployStack();
    // 诚实评分者自身信誉 100（→ √ 权重 10），给好 agent 打 85、坏 agent 打真实低分 20
    await rep.connect(owner).addRating(honestRater.address, HONEST_REP);
    await rep.connect(honestRater).rateWeighted(honestAgent.address, HONEST_QUALITY);
    await rep.connect(honestRater).rateWeighted(badAgent.address, BAD_QUALITY);
    // K 个廉价 Sybil：addRating 权重恒 1，给坏 agent 刷满分
    for (let i = 0; i < K; i++) {
      await rep.connect(sybilWallets[i]).addRating(badAgent.address, 100);
    }
    const goodRep = Number((await rep.getReputation(honestAgent.address)).averageRating);
    const badRep = Number((await rep.getReputation(badAgent.address)).averageRating);
    return {
      K, honestWeight: 10, attackerWeight: K,
      goodRep, badRep,
      badPassesReliable: badRep >= RELIABLE,
      routedToBad: routeScore(badRep) >= routeScore(goodRep),
    };
  }

  // ---- 世界 2：质押加权，攻击预算 = K token（拆成 K 个账户各质押 1）----
  async function stakeWorld(K) {
    const { token, stake, rep } = await deployStack();
    // 诚实评分者质押 100（→ 权重 100），给好 agent 打 85、坏 agent 打真实低分 20
    await fundStake(token, stake, honestRater, HONEST_STAKE);
    await rep.connect(honestRater).rateStakeWeighted(honestAgent.address, HONEST_QUALITY);
    await rep.connect(honestRater).rateStakeWeighted(badAgent.address, BAD_QUALITY);
    // K 个 Sybil 各质押 1 token（拆分攻击），给坏 agent 刷满分；零质押会被 revert
    for (let i = 0; i < K; i++) {
      await fundStake(token, stake, sybilWallets[i], 1);
      await rep.connect(sybilWallets[i]).rateStakeWeighted(badAgent.address, 100);
    }
    const goodRep = Number((await rep.getReputation(honestAgent.address)).averageRating);
    const badRep = Number((await rep.getReputation(badAgent.address)).averageRating);
    return {
      K, honestWeight: HONEST_STAKE, attackerWeight: K,
      goodRep, badRep,
      badPassesReliable: badRep >= RELIABLE,
      routedToBad: routeScore(badRep) >= routeScore(goodRep),
    };
  }

  const sqrtScan = [];
  const stakeScan = [];
  for (const K of BUDGETS) {
    sqrtScan.push(await sqrtWorld(K));
    stakeScan.push(await stakeWorld(K));
  }

  // 找 √ 加权下坏 agent 首次越过 reliable 阈值的攻击预算（崩溃点）
  const sqrtBreakK = (sqrtScan.find(r => r.badPassesReliable) || {}).K ?? null;
  const stakeBreakK = (stakeScan.find(r => r.badPassesReliable) || {}).K ?? null;

  // 零质押廉价 Sybil 在质押加权下被直接拒绝（合约级证据）
  let cheapSybilRejected = false;
  {
    const { rep } = await deployStack();
    try {
      await rep.connect(sybilWallets[0]).rateStakeWeighted.staticCall(badAgent.address, 100);
    } catch (e) { cheapSybilRejected = /No stake weight/.test(e.message); }
  }

  const results = {
    generatedNote: "E6 local Hardhat; real Reputation.sol + AgentStake.sol; deterministic; stamp time externally",
    scenario: {
      honestQuality: HONEST_QUALITY, badQuality: BAD_QUALITY, qMatch: QMATCH,
      reliableThreshold: RELIABLE, honestStake: HONEST_STAKE, honestSelfRep: HONEST_REP,
      budgets: BUDGETS,
      note: "one honest rater (sqrt-weight 10 / stake-weight 100) rates bad agent its true low score 20; attacker floods with K max-score voters; measure bad agent's weighted avg under each mechanism",
    },
    sqrtWeightedScan: sqrtScan,
    stakeWeightedScan: stakeScan,
    breakdown: {
      sqrtReliableBreachAtBudget: sqrtBreakK,   // √ 加权：坏 agent 越过阈值的最小攻击预算
      stakeReliableBreachAtBudget: stakeBreakK, // 质押加权：同上（应更大或 null=从不）
      cheapSybilRejectedUnderStake: cheapSybilRejected,
      note: "sqrt-weighting collapses once cheap Sybil count exceeds honest sqrt-weight (~10); stake-weighting requires the attacker to match honest STAKE (100), an order of magnitude more, and only with real slashable capital",
    },
    keyInsight: "under matched attacker budgets, sqrt-weighting is breached by ~10-15 free accounts, while stake-weighting demands ~100 units of real locked (slashable) capital and rejects zero-stake voters outright — layer A turns cheap collusion into an economically self-defeating attack",
  };

  const outDir = path.join(__dirname, "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "e6-results.json"), JSON.stringify(results, null, 2));
  console.log("E6 done →", path.join(outDir, "e6-results.json"));
  console.log(JSON.stringify(results, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
