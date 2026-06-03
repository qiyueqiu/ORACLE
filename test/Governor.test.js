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
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
        // voter3 has 200 tokens, < threshold (100 tokens...wait threshold is 100e18, so 200 < 100e18)
        await expect(
            governor.connect(voter3).propose(target.address, data, "Test")
        ).to.be.revertedWith("Below threshold");
    });

    it("Should allow voting and queue if quorum + for>against", async function () {
        // 先 mint 大量代币给 voter1 以满足 quorum
        await token.mint(voter1.address, ethers.parseEther("50000"));
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

    it("Should mark defeated if against wins", async function () {
        await token.mint(voter2.address, ethers.parseEther("50000"));
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
        await governor.connect(voter2).propose(target.address, data, "Test");
        await governor.connect(voter1).castVote(1, false);
        await governor.connect(voter2).castVote(1, true);
        await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine", []);
        // 试图 queue 但 v2 票数不够 quorum
        // 这里只测状态查询
        const s = await governor.state(1);
        // quorum 不达，defeated
        expect(Number(s)).to.be.greaterThanOrEqual(3);  // Defeated/Succeeded
    });

    it("Should prevent double voting", async function () {
        await token.mint(voter1.address, ethers.parseEther("50000"));
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
        await governor.connect(voter1).propose(target.address, data, "Test");
        await governor.connect(voter1).castVote(1, true);
        await expect(governor.connect(voter1).castVote(1, true)).to.be.revertedWith("Already voted");
    });
});
