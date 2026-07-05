const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * P3 形式化交叉验证：用真实 Reputation.sol 验证命题 4 的 Sybil 膨胀界。
 *
 * 证明数学模型(paper2/FORMAL-MODEL.md + paper2/sim/sybil_sim.py)与链上整数
 * 实现一致：闭式 break-even k* = ceil(W_H·(T-r0)/(100-T)) 在真实合约上成立。
 *
 * 注：rateWeighted 用评分者自身 averageRating 定权重；为构造"权重1的新Sybil"
 * 用 addRating(权重恒1)模拟廉价 Sybil，用预建信誉的账号模拟诚实老用户群。
 */
describe("Sybil Bound — formal cross-validation (P3)", function () {
  let reputation, owner, target;
  let signers;

  function isqrt(x) {
    x = BigInt(x);
    if (x === 0n) return 0n;
    let z = (x + 1n) / 2n, y = x;
    while (z < y) { y = z; z = (x / z + z) / 2n; }
    return y;
  }

  beforeEach(async function () {
    signers = await ethers.getSigners();
    [owner, target] = signers;
    const Reputation = await ethers.getContractFactory("Reputation");
    reputation = await Reputation.deploy();
    await reputation.waitForDeployment();
  });

  it("cheap-Sybil inflation matches closed-form break-even k* (T=60)", async function () {
    // 诚实基线：用 addRating(权重1)累计建立 target 的 avg=50。
    // 为对齐 sim 的 W_H=24/S_H=1200(avg=50)，这里用等价的整数加权平均不变量：
    // 简化为 owner 多次 addRating 使 avg=50, 然后用新账号 addRating(100) 模拟满分 Sybil。
    // addRating 权重恒为 1，故 W_H = 评分次数。构造 r0=50, W_H=24：
    //   24 票，加权和=1200 → 每票 50。用 24 个 50 分票。
    const honestVotes = 24;
    for (let i = 0; i < honestVotes; i++) {
      await reputation.connect(owner).addRating(target.address, 50);
    }
    let rep = await reputation.getReputation(target.address);
    expect(Number(rep.averageRating)).to.equal(50); // r0=50
    expect(Number(rep.ratingCount)).to.equal(24);   // W_H=24 (addRating 权重1)

    // 闭式 break-even 到 T=60: k* = ceil(24*(60-50)/(100-60)) = ceil(240/40) = 6
    const W_H = 24, r0 = 50, T = 60;
    const kStar = Math.ceil((W_H * (T - r0)) / (100 - T));
    expect(kStar).to.equal(6);

    // 真实合约：投 k*-1=5 个满分票，应 < 60;第 6 个达 ≥60
    for (let i = 0; i < kStar - 1; i++) {
      await reputation.connect(signers[i + 2]).addRating(target.address, 100);
    }
    rep = await reputation.getReputation(target.address);
    expect(Number(rep.averageRating)).to.be.lessThan(T); // 5 票后 <60

    await reputation.connect(signers[kStar + 1]).addRating(target.address, 100);
    rep = await reputation.getReputation(target.address);
    expect(Number(rep.averageRating)).to.be.gte(T); // 第 6 票后 ≥60，与闭式一致
  });

  it("account-splitting strictly increases total weight (counterexample 5, Bennett concave-rule neutrality)", async function () {
    // 链上验证 floor(sqrt) 的拆分有利性：1×rep100(w=10) vs 4×rep25(w=5,总20)
    // 用 rateWeighted 的权重逻辑（合约 _sqrt）。直接断言 _sqrt 行为：
    // 通过 addRating 建立不同 rep 的评分者，观察其 rateWeighted 的有效权重。
    // 这里用纯数值断言合约 _sqrt 等价（已在 sybil_sim.py 验证，链上 _sqrt 同实现）。
    expect(Number(isqrt(100))).to.equal(10);
    expect(Number(isqrt(25))).to.equal(5);
    expect(4 * Number(isqrt(25))).to.be.greaterThan(Number(isqrt(100))); // 20 > 10

    // 端到端：建一个 rep=100 评分者 vs 四个 rep=25 评分者，比较它们 rateWeighted 的累积影响
    const big = signers[2], smalls = [signers[3], signers[4], signers[5], signers[6]];
    // 建 big 到 avg=100
    await reputation.connect(owner).addRating(big.address, 100);
    // 建每个 small 到 avg=25
    for (const s of smalls) await reputation.connect(owner).addRating(s.address, 25);

    // big 用 rateWeighted 给 target 打 100：权重 floor(sqrt(100))=10
    const t2 = signers[7];
    await reputation.connect(big).rateWeighted(t2.address, 100);
    let r = await reputation.reputations(t2.address);
    expect(Number(r.weightSum)).to.equal(10); // 单账号权重 10

    // 4 个 small 各 rateWeighted 给另一 target 打 100：总权重 4×5=20
    const t3 = signers[8];
    for (const s of smalls) await reputation.connect(s).rateWeighted(t3.address, 100);
    r = await reputation.reputations(t3.address);
    expect(Number(r.weightSum)).to.equal(20); // 拆分后总权重 20 > 10 —— 链上确认拆分有利
  });
});
