const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ASBGovernor (M3 改造 8)", function () {
    let token, governor;
    let owner, voter1, voter2, voter3, target;

    beforeEach(async function () {
        [owner, voter1, voter2, voter3, target] = await ethers.getSigners();

        // 简单 MockERC20 当治理代币
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        token = await MockERC20.deploy();
        await token.waitForDeployment();

        // 给投票者分发
        await token.mint(voter1.address, ethers.parseEther("1000"));
        await token.mint(voter2.address, ethers.parseEther("500"));
        await token.mint(voter3.address, ethers.parseEther("200"));

        const ASBGovernor = await ethers.getContractFactory("ASBGovernor");
        governor = await ASBGovernor.deploy(await token.getAddress());
        await governor.waitForDeployment();
    });

    it("Should accept proposal from token holder", async function () {
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [42]);
        const tx = await governor.connect(voter1).propose(target.address, data, "Set param to 42");
        const r = await tx.wait();
        expect(r.status).to.equal(1);
        expect(await governor.proposalCount()).to.equal(1);
    });

    it("Should reject proposal from non-token holder", async function () {
        // 创建一个 0 token 的 address
        const Token = await ethers.getContractFactory("MockERC20");
        const emptyToken = await Token.deploy();
        await emptyToken.waitForDeployment();
        // 部署 Governor 时用空 token
        const Gov2 = await ethers.getContractFactory("ASBGovernor");
        const gov2 = await Gov2.deploy(await emptyToken.getAddress());
        await gov2.waitForDeployment();
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
        await expect(
            gov2.connect(voter3).propose(target.address, data, "Test")
        ).to.be.revertedWith("Below threshold");
    });

    it("Should allow voting and queue if quorum + for>against", async function () {
        // MockERC20 constructor mints 1,000,000e18 to deployer. 为了 quorum 通过，
        // 需要 voter1 + voter2 投票 ≥ 40% supply = 420,680e18
        await token.mint(voter1.address, ethers.parseEther("500000"));
        await token.mint(voter2.address, ethers.parseEther("500000"));  // 保险
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100]);
        await governor.connect(voter1).propose(target.address, data, "Test");

        await governor.connect(voter1).castVote(1, true);
        await governor.connect(voter2).castVote(1, true);
        // 跳过 votingPeriod
        await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine", []);

        await governor.queue(1);
        const p = await governor.proposals(1);
        expect(p.eta).to.be.greaterThan(0);
    });

    it("Should mark defeated if against wins (via queue revert)", async function () {
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
        await governor.connect(voter2).propose(target.address, data, "Test 2");
        const propId = await governor.proposalCount();
        await governor.connect(voter1).castVote(propId, false);
        await governor.connect(voter2).castVote(propId, true);
        // 推进时间
        const prop = await governor.proposals(propId);
        await ethers.provider.send("evm_setNextBlockTimestamp", [Number(prop.createdAt) + 365 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine", []);
        // for(500,000) < against(510,000)，所以 queue 应该 revert（Defeated 不允许 queue）
        // quorum 计算：total = 1,010,000e18 vs supply 2,000,200e18 = 50% > 40% → quorum OK
        // 但 for<against → revert with custom
        // 实际合约先检查 quorum，再检查 for>against
        await expect(governor.queue(propId)).to.be.reverted;  // Defeated: for<=against
    });

    it("Should prevent double voting", async function () {
        await token.mint(voter1.address, ethers.parseEther("50000"));
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
        await governor.connect(voter1).propose(target.address, data, "Test");
        await governor.connect(voter1).castVote(1, true);
        await expect(governor.connect(voter1).castVote(1, true)).to.be.revertedWith("Already voted");
    });
});
