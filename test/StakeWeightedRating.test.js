const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * 论文 §4.3 A 层：质押绑定评分权重（rateStakeWeighted）的安全不变量。
 *
 * 与 √ 加权（rateWeighted）对照，锁住四条使 A 层「破解 Bennett 凹函数不可能性」的性质：
 *   (I)  无质押 → 权重 0 → revert：廉价 Sybil（零成本刷分）被彻底关闭。
 *   (II) 拆分守恒：把一份质押 S 拆到 k 个账户，权重之和 Σ⌊Sᵢ/U⌋ ≤ ⌊S/U⌋，
 *        拆分零获利 —— 与 √ 加权 4×⌊√25⌋=20 > ⌊√100⌋=10 的拆分有利性正好相反。
 *   (III)线性单调：权重 = ⌊stake/unit⌋，翻倍质押≈翻倍权重（对比 √ 的次线性）。
 *   (IV) 向后兼容：addRating/rateWeighted 行为不变；未配置 stake 源时 rateStakeWeighted 拒绝。
 */
describe("Stake-Weighted Rating (paper §4.3 layer A)", function () {
  let token, stake, reputation;
  let owner, agentX, r1, r2, r3, r4;
  const UNIT = ethers.parseEther("1"); // 默认 stakeWeightUnit = 1e18

  function isqrt(x) {
    x = BigInt(x);
    if (x === 0n) return 0n;
    let z = (x + 1n) / 2n, y = x;
    while (z < y) { y = z; z = (x / z + z) / 2n; }
    return y;
  }

  beforeEach(async function () {
    [owner, agentX, r1, r2, r3, r4] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy();
    await token.waitForDeployment();

    const AgentStake = await ethers.getContractFactory("AgentStake");
    stake = await AgentStake.deploy(await token.getAddress());
    await stake.waitForDeployment();

    const Reputation = await ethers.getContractFactory("Reputation");
    reputation = await Reputation.deploy();
    await reputation.waitForDeployment();

    // 接线：Reputation 从 AgentStake 读质押
    await reputation.setAgentStake(await stake.getAddress());
  });

  // 给某账户铸币并质押 amount（ether 单位）
  async function fund(signer, amountEther) {
    const amt = ethers.parseEther(String(amountEther));
    await token.mint(signer.address, amt);
    await token.connect(signer).approve(await stake.getAddress(), amt);
    await stake.connect(signer).stake(amt);
  }

  describe("(I) cheap Sybil is closed: no stake => zero weight => revert", function () {
    it("a rater with no stake cannot rate (revert 'No stake weight')", async function () {
      await expect(
        reputation.connect(r1).rateStakeWeighted(agentX.address, 100),
      ).to.be.revertedWith("No stake weight");
    });

    it("stake below one unit yields zero weight => revert (dust cannot vote)", async function () {
      // 质押 0.5 token < 1 unit → weight = 0
      const half = ethers.parseEther("0.5");
      await token.mint(r1.address, half);
      await token.connect(r1).approve(await stake.getAddress(), half);
      await stake.connect(r1).stake(half);
      await expect(
        reputation.connect(r1).rateStakeWeighted(agentX.address, 100),
      ).to.be.revertedWith("No stake weight");
    });
  });

  describe("(II) split-conservation: splitting stake never increases total weight", function () {
    it("1x100-stake weight EQUALS 4x25-stake total weight (vs sqrt: 10 < 20)", async function () {
      // 单账户质押 100 → 给 agentX 打分，weight = 100
      await fund(r1, 100);
      await reputation.connect(r1).rateStakeWeighted(agentX.address, 100);
      let rep = await reputation.reputations(agentX.address);
      const singleWeight = Number(rep.weightSum);
      expect(singleWeight).to.equal(100);

      // 把 100 拆成 4×25：四个账户各质押 25，各打分 → 总权重应为 4×25 = 100
      await fund(r2, 25);
      await fund(r3, 25);
      await fund(r4, 25);
      await fund(owner, 25); // 第 4 个 25

      const split = [r2, r3, r4, owner];
      const fresh = ethers.Wallet.createRandom().address; // 干净的第二目标
      for (const r of split) {
        await reputation.connect(r).rateStakeWeighted(fresh, 100);
      }
      rep = await reputation.reputations(fresh);
      const splitTotalWeight = Number(rep.weightSum);
      expect(splitTotalWeight).to.equal(100); // 4×25 = 100 = 单账户 100

      // 关键对照：√ 加权下拆分严格有利（10 < 20），质押加权下拆分守恒（100 = 100）
      expect(splitTotalWeight).to.equal(singleWeight);
      expect(4 * Number(isqrt(25))).to.be.greaterThan(Number(isqrt(100))); // √: 20 > 10
    });

    it("integer-floor split can only LOSE weight, never gain (3x33 < 1x100)", async function () {
      // 100 拆成 3×33（余 1 丢失）：3×33 = 99 < 100，拆分反而亏损
      await fund(r1, 33);
      await fund(r2, 33);
      await fund(r3, 33);
      const fresh = ethers.Wallet.createRandom().address;
      for (const r of [r1, r2, r3]) {
        await reputation.connect(r).rateStakeWeighted(fresh, 100);
      }
      const rep = await reputation.reputations(fresh);
      expect(Number(rep.weightSum)).to.equal(99); // < 100：拆分严格不获利
    });
  });

  describe("(III) linear weight: doubling stake doubles weight (contrast sqrt sub-linearity)", function () {
    it("weight is exactly floor(stake/unit), linear in stake", async function () {
      await fund(r1, 40);
      const fresh1 = ethers.Wallet.createRandom().address;
      await reputation.connect(r1).rateStakeWeighted(fresh1, 100);
      let rep = await reputation.reputations(fresh1);
      expect(Number(rep.weightSum)).to.equal(40);

      await fund(r2, 80); // 翻倍质押
      const fresh2 = ethers.Wallet.createRandom().address;
      await reputation.connect(r2).rateStakeWeighted(fresh2, 100);
      rep = await reputation.reputations(fresh2);
      expect(Number(rep.weightSum)).to.equal(80); // 翻倍权重（线性）；√ 加权只会是 √2≈1.41 倍
    });
  });

  describe("(IV) backward compatibility + guards", function () {
    it("rateStakeWeighted reverts when stake source is unset", async function () {
      const Reputation = await ethers.getContractFactory("Reputation");
      const repNoStake = await Reputation.deploy();
      await repNoStake.waitForDeployment();
      await fund(r1, 100);
      await expect(
        repNoStake.connect(r1).rateStakeWeighted(agentX.address, 100),
      ).to.be.revertedWith("Stake source unset");
    });

    it("legacy addRating still weight-1 and rateWeighted still sqrt-based", async function () {
      // addRating 权重恒 1
      await reputation.connect(owner).addRating(agentX.address, 80);
      let rep = await reputation.reputations(agentX.address);
      expect(Number(rep.weightSum)).to.equal(1);

      // rateWeighted：先把 r1 的 averageRating 建到 100，则 √ 权重 = 10
      await reputation.connect(owner).addRating(r1.address, 100);
      const fresh = ethers.Wallet.createRandom().address;
      await reputation.connect(r1).rateWeighted(fresh, 100);
      rep = await reputation.reputations(fresh);
      expect(Number(rep.weightSum)).to.equal(10); // ⌊√100⌋ = 10，√ 路径不受影响
    });

    it("rateStakeWeighted respects invalid-rating and zero-address guards", async function () {
      await fund(r1, 100);
      await expect(
        reputation.connect(r1).rateStakeWeighted(agentX.address, 101),
      ).to.be.revertedWith("Invalid rating");
      await expect(
        reputation.connect(r1).rateStakeWeighted(ethers.ZeroAddress, 50),
      ).to.be.revertedWith("Invalid address");
    });
  });
});
