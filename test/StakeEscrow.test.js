const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentStake + PaymentEscrow (改造 6)", function () {
    let token, stake, escrow, auditLog, agentDID;
    let owner, payer, worker, other;

    beforeEach(async function () {
        [owner, payer, worker, other] = await ethers.getSigners();

        // Deploy MockERC20
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        token = await MockERC20.deploy();
        await token.waitForDeployment();

        // Deploy AgentStake
        const AgentStake = await ethers.getContractFactory("AgentStake");
        stake = await AgentStake.deploy(await token.getAddress());
        await stake.waitForDeployment();

        // Deploy PaymentEscrow
        const PaymentEscrow = await ethers.getContractFactory("PaymentEscrow");
        escrow = await PaymentEscrow.deploy(await token.getAddress());
        await escrow.waitForDeployment();

        // Distribute tokens
        await token.mint(payer.address, ethers.parseEther("10000"));
        await token.mint(worker.address, ethers.parseEther("1000"));
    });

    describe("AgentStake", function () {
        it("Should accept stake >= minStake", async function () {
            const minStake = await stake.minStake();
            await token.connect(worker).approve(await stake.getAddress(), minStake);
            await stake.connect(worker).stake(minStake);
            expect(await stake.getStake(worker.address)).to.equal(minStake);
            expect(await stake.isStaked(worker.address)).to.be.true;
        });

        it("Should reject stake below minStake when zero", async function () {
            // 0 stake → isStaked false
            expect(await stake.isStaked(worker.address)).to.be.false;
        });

        it("Should support additional stake", async function () {
            const minStake = await stake.minStake();
            await token.connect(worker).approve(await stake.getAddress(), minStake * 3n);
            await stake.connect(worker).stake(minStake);
            await stake.connect(worker).stake(minStake);
            expect(await stake.getStake(worker.address)).to.equal(minStake * 2n);
        });

        it("Should allow unstake", async function () {
            const minStake = await stake.minStake();
            await token.connect(worker).approve(await stake.getAddress(), minStake);
            await stake.connect(worker).stake(minStake);
            await stake.connect(worker).unstake(minStake);
            expect(await stake.getStake(worker.address)).to.equal(0);
        });

        it("Should only allow auditLog to slash", async function () {
            const minStake = await minStakeOr(ethers.parseEther("100"));
            await token.connect(worker).approve(await stake.getAddress(), minStake);
            await stake.connect(worker).stake(minStake);

            await expect(
                stake.connect(other).slash(worker.address, "Test")
            ).to.be.revertedWith("Only AuditLog");
        });

        it("Should slash at slashBps rate when authorized", async function () {
            const minStake = await stake.minStake();
            await token.connect(worker).approve(await stake.getAddress(), minStake);
            await stake.connect(worker).stake(minStake);
            // 设置 auditLog
            await stake.connect(owner).setAuditLog(other.address);
            const slashBps = await stake.slashBps();
            const expected = (minStake * slashBps) / 10000n;
            await expect(stake.connect(other).slash(worker.address, "Failed task"))
                .to.emit(stake, "Slashed").withArgs(worker.address, expected, "Failed task");
            const remaining = await stake.getStake(worker.address);
            expect(remaining).to.equal(minStake - expected);
        });

        async function minStakeOr(fallback) {
            try { return await stake.minStake(); } catch { return fallback; }
        }
    });

    describe("PaymentEscrow", function () {
        beforeEach(async function () {
            await token.connect(payer).approve(await escrow.getAddress(), ethers.parseEther("1000"));
        });

        it("Should fund task", async function () {
            const deadline = Math.floor(Date.now() / 1000) + 3600;
            const amount = ethers.parseEther("100");
            await escrow.connect(payer).fundTask(1, worker.address, deadline, amount);
            const e = await escrow.getEscrow(1);
            expect(e.payer).to.equal(payer.address);
            expect(e.worker).to.equal(worker.address);
            expect(e.amount).to.equal(amount);
            expect(e.status).to.equal(1); // Funded
        });

        it("Should reject double-funding same recordId", async function () {
            const deadline = Math.floor(Date.now() / 1000) + 3600;
            await escrow.connect(payer).fundTask(1, worker.address, deadline, ethers.parseEther("100"));
            await expect(
                escrow.connect(payer).fundTask(1, worker.address, deadline, ethers.parseEther("100"))
            ).to.be.revertedWith("RecordId already used");
        });

        it("Should release on success (only auditLog)", async function () {
            const deadline = Math.floor(Date.now() / 1000) + 3600;
            const amount = ethers.parseEther("100");
            await escrow.connect(payer).fundTask(1, worker.address, deadline, amount);
            await expect(escrow.connect(other).release(1)).to.be.revertedWith("Only AuditLog");
            await escrow.connect(owner).setAuditLog(other.address);
            const feeBps = await escrow.feeBps();
            const fee = (amount * feeBps) / 10000n;
            const payout = amount - fee;
            await expect(escrow.connect(other).release(1))
                .to.emit(escrow, "TaskReleased").withArgs(1, worker.address, payout, fee);
            expect(await token.balanceOf(worker.address)).to.equal(ethers.parseEther("1000") + payout);
            const e = await escrow.getEscrow(1);
            expect(e.status).to.equal(2); // Released
        });

        it("Should refund after deadline", async function () {
            const deadline = Math.floor(Date.now() / 1000) + 60;
            const amount = ethers.parseEther("100");
            await escrow.connect(payer).fundTask(1, worker.address, deadline, amount);
            await ethers.provider.send("evm_increaseTime", [120]);
            await ethers.provider.send("evm_mine", []);
            const balanceBefore = await token.balanceOf(payer.address);
            await escrow.connect(payer).refund(1);
            const balanceAfter = await token.balanceOf(payer.address);
            expect(balanceAfter - balanceBefore).to.equal(amount);
            const e = await escrow.getEscrow(1);
            expect(e.status).to.equal(3); // Refunded
        });

        it("Should not allow refund before deadline", async function () {
            const deadline = Math.floor(Date.now() / 1000) + 3600;
            await escrow.connect(payer).fundTask(1, worker.address, deadline, ethers.parseEther("100"));
            await expect(escrow.connect(payer).refund(1)).to.be.revertedWith("Not past deadline");
        });

        it("Should not allow non-payer to refund", async function () {
            const deadline = Math.floor(Date.now() / 1000) + 60;
            await escrow.connect(payer).fundTask(1, worker.address, deadline, ethers.parseEther("100"));
            await ethers.provider.send("evm_increaseTime", [120]);
            await ethers.provider.send("evm_mine", []);
            await expect(escrow.connect(other).refund(1)).to.be.revertedWith("Not payer");
        });
    });
});
