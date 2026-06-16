const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RouterRegistry (M3 multi-router consensus)", function () {
    let registry;
    let owner, r1, r2, r3, r4;

    beforeEach(async function () {
        [owner, r1, r2, r3, r4] = await ethers.getSigners();
        const RouterRegistry = await ethers.getContractFactory("RouterRegistry");
        registry = await RouterRegistry.deploy();
        await registry.waitForDeployment();
    });

    it("Should register routers with stake", async function () {
        await registry.connect(owner).registerRouter(r1.address, ethers.parseEther("100"));
        await registry.connect(owner).registerRouter(r2.address, ethers.parseEther("100"));
        await registry.connect(owner).registerRouter(r3.address, ethers.parseEther("100"));
        expect(await registry.activeRouterCount()).to.equal(3);
    });

    it("Should reject non-owner registering", async function () {
        await expect(
            registry.connect(r1).registerRouter(r2.address, 0)
        ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("Should vote and reach consensus at 2/3", async function () {
        await registry.connect(owner).registerRouter(r1.address, 0);
        await registry.connect(owner).registerRouter(r2.address, 0);
        await registry.connect(owner).registerRouter(r3.address, 0);

        const decisionDigest = ethers.keccak256(ethers.toUtf8Bytes("decision-1"));

        await expect(registry.connect(r1).submitVote(1, decisionDigest))
            .to.emit(registry, "VoteSubmitted");
        await expect(registry.connect(r2).submitVote(1, decisionDigest))
            .to.emit(registry, "ConsensusReached");
    });

    it("Should not reach consensus with 1/3 vote", async function () {
        await registry.connect(owner).registerRouter(r1.address, 0);
        await registry.connect(owner).registerRouter(r2.address, 0);
        await registry.connect(owner).registerRouter(r3.address, 0);

        const decisionDigest = ethers.keccak256(ethers.toUtf8Bytes("d"));
        await registry.connect(r1).submitVote(1, decisionDigest);
        // 1/3 < 2/3, no consensus
        // 查询 votes
        const votes = await registry.getVotes(1, decisionDigest);
        expect(votes).to.equal(1);
    });

    it("Should prevent double voting", async function () {
        await registry.connect(owner).registerRouter(r1.address, 0);
        await registry.connect(owner).registerRouter(r2.address, 0);

        const decisionDigest = ethers.keccak256(ethers.toUtf8Bytes("d"));
        await registry.connect(r1).submitVote(1, decisionDigest);
        await expect(
            registry.connect(r1).submitVote(1, decisionDigest)
        ).to.be.revertedWith("Already voted");
    });

    it("Should deactivate and re-activate router", async function () {
        await registry.connect(owner).registerRouter(r1.address, 0);
        expect(await registry.activeRouterCount()).to.equal(1);
        await registry.connect(owner).deactivateRouter(r1.address);
        expect(await registry.activeRouterCount()).to.equal(0);
        await expect(
            registry.connect(r1).submitVote(1, ethers.ZeroHash)
        ).to.be.revertedWith("Not active router");
        await registry.connect(owner).reactivateRouter(r1.address);
        expect(await registry.activeRouterCount()).to.equal(1);
    });

    it("Should allow custom quorum", async function () {
        await registry.connect(owner).setQuorumBps(5000);  // 50%
        expect(await registry.quorumBps()).to.equal(5000);
    });

    it("Should reject invalid quorum", async function () {
        await expect(registry.connect(owner).setQuorumBps(0))
            .to.be.revertedWith("Invalid quorum");
        await expect(registry.connect(owner).setQuorumBps(10001))
            .to.be.revertedWith("Invalid quorum");
    });

    // P6：quorum 地板修复 —— MIN_ROUTERS + ceil 取整，杜绝少数 Router 伪共识
    describe("Quorum floor (P6 hardening)", function () {
        it("Should NOT reach consensus with fewer than MIN_ROUTERS (3)", async function () {
            await registry.connect(owner).registerRouter(r1.address, 0);
            await registry.connect(owner).registerRouter(r2.address, 0);
            const digest = ethers.keccak256(ethers.toUtf8Bytes("d"));
            await registry.connect(r1).submitVote(1, digest);
            // 2 个 Router 全投，但 activeRouterCount < MIN_ROUTERS → 不共识
            await expect(registry.connect(r2).submitVote(1, digest)).to.not.emit(
                registry,
                "ConsensusReached",
            );
        });

        it("Should require ceil(quorum) votes — 1 of 3 is not consensus, 2 of 3 is", async function () {
            await registry.connect(owner).registerRouter(r1.address, 0);
            await registry.connect(owner).registerRouter(r2.address, 0);
            await registry.connect(owner).registerRouter(r3.address, 0);
            const digest = ethers.keccak256(ethers.toUtf8Bytes("d2"));
            // ceil(3*6666/10000)=2；1 票不够
            await expect(registry.connect(r1).submitVote(2, digest)).to.not.emit(
                registry,
                "ConsensusReached",
            );
            await expect(registry.connect(r2).submitVote(2, digest)).to.emit(
                registry,
                "ConsensusReached",
            );
        });
    });
});
