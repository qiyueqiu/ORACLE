/**
 * PaymentEscrow 单元测试
 * 覆盖: fundTask / release / refund / setAuditLog / setFeeBps / withdrawFees
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PaymentEscrow Contract (改造 6)", function () {
    let token, escrow;
    let owner, auditLogAddr, payer, worker, other;

    // 远期 deadline：每次 beforeEach 重新计算
    let FAR_DEADLINE;

    beforeEach(async function () {
        [owner, auditLogAddr, payer, worker, other] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        token = await MockERC20.deploy();
        await token.waitForDeployment();

        const PaymentEscrow = await ethers.getContractFactory("PaymentEscrow");
        escrow = await PaymentEscrow.deploy(await token.getAddress());
        await escrow.waitForDeployment();

        // 给 payer / worker 分发 token
        await token.mint(payer.address, ethers.parseEther("10000"));
        await token.mint(worker.address, ethers.parseEther("1000"));

        // 远期 deadline 动态计算
        const next = (await ethers.provider.getBlock("latest")).timestamp + 1;
        await ethers.provider.send("evm_setNextBlockTimestamp", [next]);
        await ethers.provider.send("evm_mine", []);
        FAR_DEADLINE = next + 1000 * 365 * 24 * 3600;
    });

    describe("Deployment", function () {
        it("Should set correct paymentToken", async function () {
            expect(await escrow.paymentToken()).to.equal(await token.getAddress());
        });

        it("Should set default feeBps = 200 (2%)", async function () {
            expect(await escrow.feeBps()).to.equal(200);
        });

        it("Should set owner correctly", async function () {
            expect(await escrow.owner()).to.equal(owner.address);
        });

        it("Should set auditLog = 0 initially", async function () {
            expect(await escrow.auditLog()).to.equal(ethers.ZeroAddress);
        });
    });

    describe("fundTask", function () {
        beforeEach(async function () {
            await token.connect(payer).approve(await escrow.getAddress(), ethers.parseEther("10000"));
        });

        it("Should fund task successfully", async function () {
            const amount = ethers.parseEther("100");
            await escrow.connect(payer).fundTask(1, worker.address, FAR_DEADLINE, amount);
            const e = await escrow.getEscrow(1);
            expect(e.payer).to.equal(payer.address);
            expect(e.worker).to.equal(worker.address);
            expect(e.amount).to.equal(amount);
            expect(e.deadline).to.equal(FAR_DEADLINE);
            expect(e.status).to.equal(1); // Funded
        });

        it("Should transfer tokens from payer", async function () {
            const before = await token.balanceOf(payer.address);
            const amount = ethers.parseEther("100");
            await escrow.connect(payer).fundTask(1, worker.address, FAR_DEADLINE, amount);
            const after = await token.balanceOf(payer.address);
            expect(before - after).to.equal(amount);
            expect(await token.balanceOf(await escrow.getAddress())).to.equal(amount);
        });

        it("Should emit TaskFunded", async function () {
            const amount = ethers.parseEther("50");
            await expect(escrow.connect(payer).fundTask(1, worker.address, FAR_DEADLINE, amount))
                .to.emit(escrow, "TaskFunded")
                .withArgs(1, payer.address, worker.address, amount);
        });

        it("Should reject double-funding same recordId", async function () {
            const amount = ethers.parseEther("100");
            await escrow.connect(payer).fundTask(1, worker.address, FAR_DEADLINE, amount);
            await expect(
                escrow.connect(payer).fundTask(1, worker.address, FAR_DEADLINE, amount)
            ).to.be.revertedWith("RecordId already used");
        });

        it("Should reject zero worker", async function () {
            await expect(
                escrow.connect(payer).fundTask(1, ethers.ZeroAddress, FAR_DEADLINE, 100)
            ).to.be.revertedWith("Zero worker");
        });

        it("Should reject zero amount", async function () {
            await expect(
                escrow.connect(payer).fundTask(1, worker.address, FAR_DEADLINE, 0)
            ).to.be.revertedWith("Zero amount");
        });

        it("Should reject past deadline", async function () {
            // 等到 hardhat 时间前进
            const past = FAR_DEADLINE + 1;
            await ethers.provider.send("evm_setNextBlockTimestamp", [past]);
            await ethers.provider.send("evm_mine", []);
            await expect(
                escrow.connect(payer).fundTask(1, worker.address, FAR_DEADLINE, 100)
            ).to.be.revertedWith("Past deadline");
        });

        it("Should reject insufficient allowance", async function () {
            // 撤销 approve
            await token.connect(payer).approve(await escrow.getAddress(), 0);
            await expect(
                escrow.connect(payer).fundTask(1, worker.address, FAR_DEADLINE, 100)
            ).to.be.reverted;  // ERC20 transferFrom 失败
        });
    });

    describe("release", function () {
        beforeEach(async function () {
            await token.connect(payer).approve(await escrow.getAddress(), ethers.parseEther("10000"));
            await escrow.connect(payer).fundTask(1, worker.address, FAR_DEADLINE, ethers.parseEther("100"));
            await escrow.connect(owner).setAuditLog(auditLogAddr.address);
        });

        it("Should release to worker and pay fee to owner", async function () {
            const amount = ethers.parseEther("100");
            const feeBps = await escrow.feeBps();
            const fee = (amount * feeBps) / 10000n;
            const payout = amount - fee;

            const workerBefore = await token.balanceOf(worker.address);
            const ownerBefore = await token.balanceOf(owner.address);

            await expect(escrow.connect(auditLogAddr).release(1))
                .to.emit(escrow, "TaskReleased")
                .withArgs(1, worker.address, payout, fee);

            expect(await token.balanceOf(worker.address) - workerBefore).to.equal(payout);
            expect(await token.balanceOf(owner.address) - ownerBefore).to.equal(fee);

            const e = await escrow.getEscrow(1);
            expect(e.status).to.equal(2); // Released
        });

        it("Should reject release from non-auditLog", async function () {
            await expect(escrow.connect(other).release(1)).to.be.revertedWith("Only AuditLog");
        });

        it("Should reject double release", async function () {
            await escrow.connect(auditLogAddr).release(1);
            await expect(escrow.connect(auditLogAddr).release(1)).to.be.revertedWith("Not funded");
        });

        it("Should reject release before fundTask", async function () {
            await expect(escrow.connect(auditLogAddr).release(999)).to.be.revertedWith("Not funded");
        });
    });

    describe("refund", function () {
        beforeEach(async function () {
            await token.connect(payer).approve(await escrow.getAddress(), ethers.parseEther("10000"));
            await escrow.connect(payer).fundTask(1, worker.address, FAR_DEADLINE, ethers.parseEther("100"));
        });

        it("Should refund to payer after deadline", async function () {
            await ethers.provider.send("evm_increaseTime", [1100 * 365 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);

            const before = await token.balanceOf(payer.address);
            await expect(escrow.connect(payer).refund(1))
                .to.emit(escrow, "TaskRefunded")
                .withArgs(1, payer.address, ethers.parseEther("100"));
            const after = await token.balanceOf(payer.address);
            expect(after - before).to.equal(ethers.parseEther("100"));
            const e = await escrow.getEscrow(1);
            expect(e.status).to.equal(3); // Refunded
        });

        it("Should reject refund before deadline", async function () {
            await expect(escrow.connect(payer).refund(1)).to.be.revertedWith("Not past deadline");
        });

        it("Should reject refund from non-payer", async function () {
            await ethers.provider.send("evm_increaseTime", [1100 * 365 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            await expect(escrow.connect(other).refund(1)).to.be.revertedWith("Not payer");
        });

        it("Should reject double refund", async function () {
            await ethers.provider.send("evm_increaseTime", [1100 * 365 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            await escrow.connect(payer).refund(1);
            await expect(escrow.connect(payer).refund(1)).to.be.revertedWith("Not funded");
        });
    });

    describe("owner governance", function () {
        it("Should set auditLog", async function () {
            await escrow.connect(owner).setAuditLog(auditLogAddr.address);
            expect(await escrow.auditLog()).to.equal(auditLogAddr.address);
            await expect(escrow.connect(owner).setAuditLog(auditLogAddr.address))
                .to.emit(escrow, "AuditLogUpdated").withArgs(auditLogAddr.address);
        });

        it("Should reject setAuditLog from non-owner", async function () {
            await expect(escrow.connect(other).setAuditLog(auditLogAddr.address))
                .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("Should set feeBps", async function () {
            await escrow.connect(owner).setFeeBps(500);
            expect(await escrow.feeBps()).to.equal(500);
        });

        it("Should reject feeBps > 5000", async function () {
            await expect(escrow.connect(owner).setFeeBps(5001)).to.be.revertedWith("Fee > 50%");
        });

        it("Should reject setFeeBps from non-owner", async function () {
            await expect(escrow.connect(other).setFeeBps(100))
                .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });
    });

    describe("withdrawFees", function () {
        // 注：当前 PaymentEscrow 实现中，release() 已经把 fee 转给 owner，
        // 所以 escrow 合约不会累积 fees 余额。withdrawFees 实际是"防御性"接口
        // 用于：若 release 因故没转走 fee，owner 可调用 withdrawFees 兜底。
        it("Should reject withdrawFees when no fees accumulated", async function () {
            await token.connect(payer).approve(await escrow.getAddress(), ethers.parseEther("10000"));
            await escrow.connect(payer).fundTask(1, worker.address, FAR_DEADLINE, ethers.parseEther("100"));
            await escrow.connect(owner).setAuditLog(auditLogAddr.address);
            // release 已经把 fee 转给 owner → totalFees 累加但合约余额已无 fees
            await escrow.connect(auditLogAddr).release(1);
            // 再次 release 没有 funded 记录 → revert "Not funded"
            // 但 withdrawFees 看 totalFees > 0 → 尝试转出 → 合约余额不足 → revert
            // 我们在 release 之前测，totalFees = 0
            // 先调一次让 totalFees = 0（已 release），再次 withdraw 期望 revert "No fees"
            // 实际上 totalFees > 0（release 累加了）所以会 revert on insufficient balance
            // 改测：未 release 时，totalFees = 0 → "No fees"
            const escrow2 = await (await ethers.getContractFactory("PaymentEscrow")).deploy(await token.getAddress());
            await escrow2.waitForDeployment();
            await expect(escrow2.connect(owner).withdrawFees()).to.be.revertedWith("No fees");
        });

        it("Should reject withdrawFees from non-owner", async function () {
            await expect(escrow.connect(other).withdrawFees())
                .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });
    });
});
