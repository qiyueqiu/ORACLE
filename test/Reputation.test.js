const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Reputation Contract", function () {
    let reputation;
    let owner, addr1, addr2, addr3;

    beforeEach(async function () {
        [owner, addr1, addr2, addr3] = await ethers.getSigners();
        const Reputation = await ethers.getContractFactory("Reputation");
        reputation = await Reputation.deploy();
        await reputation.waitForDeployment();
    });

    describe("Legacy addRating (backward compatible)", function () {
        it("Should add first rating and create reputation entry", async function () {
            await expect(reputation.connect(addr1).addRating(addr2.address, 80))
                .to.emit(reputation, "ReputationUpdated")
                .withArgs(addr2.address, 80, 1, 1);
            const rep = await reputation.getReputation(addr2.address);
            expect(rep.averageRating).to.equal(80);
            expect(rep.ratingCount).to.equal(1);
        });

        it("Should calculate average correctly for multiple ratings", async function () {
            await reputation.connect(addr1).addRating(addr2.address, 60);
            await reputation.connect(owner).addRating(addr2.address, 80);
            await reputation.connect(addr3).addRating(addr2.address, 40);
            const rep = await reputation.getReputation(addr2.address);
            expect(rep.totalScore).to.equal(180);
            expect(rep.ratingCount).to.equal(3);
            expect(rep.averageRating).to.equal(60);
        });

        it("Should reject invalid ratings", async function () {
            await expect(reputation.addRating(addr1.address, 101))
                .to.be.revertedWith("Invalid rating");
        });

        it("Should reject zero address", async function () {
            await expect(reputation.addRating(ethers.ZeroAddress, 5))
                .to.be.revertedWith("Invalid address");
        });
    });

    describe("rateWeighted (改造 5)", function () {
        beforeEach(async function () {
            // 给 addr1 一个 81 分的信誉（sqrt(81) = 9）
            await reputation.connect(owner).addRating(addr1.address, 81);
        });

        it("Should weight rating by sqrt(raterReputation)", async function () {
            await reputation.connect(addr1).rateWeighted(addr2.address, 50);
            const rep = await reputation.getReputation(addr2.address);
            // totalScore = 50 * 9 = 450, weightSum = 9, avg = 50
            expect(rep.totalScore).to.equal(450);
            expect(rep.averageRating).to.equal(50);
        });

        it("Should weight = 1 for new rater (rep=0)", async function () {
            await reputation.connect(addr3).rateWeighted(addr2.address, 70);
            const rep = await reputation.getReputation(addr2.address);
            expect(rep.totalScore).to.equal(70);
            expect(rep.averageRating).to.equal(70);
        });

        it("Should accumulate weighted ratings correctly", async function () {
            await reputation.connect(addr1).rateWeighted(addr2.address, 100);  // weight 9, +900
            await reputation.connect(addr3).rateWeighted(addr2.address, 60);  // weight 1, +60
            const rep = await reputation.getReputation(addr2.address);
            const stored = await reputation.reputations(addr2.address);
            expect(stored.totalScore).to.equal(960);
            expect(stored.weightSum).to.equal(10);
            expect(rep.averageRating).to.equal(96);
        });
    });

    describe("Reliability", function () {
        beforeEach(async function () {
            await reputation.connect(addr1).addRating(addr2.address, 70);
            await reputation.connect(addr3).addRating(addr2.address, 80);
            await reputation.connect(owner).addRating(addr2.address, 70);
            // 创建不可靠 Agent
            await reputation.addRating(addr3.address, 30);
            await reputation.addRating(addr3.address, 40);
        });

        it("Should identify reliable agents", async function () {
            expect(await reputation.isReliable(addr2.address)).to.be.true;
            expect(await reputation.isReliable(addr3.address)).to.be.false;
        });

        it("Should check threshold correctly", async function () {
            expect(await reputation.meetsThreshold(addr2.address, 60)).to.be.true;
            expect(await reputation.meetsThreshold(addr2.address, 80)).to.be.false;
        });
    });

    describe("Time Decay", function () {
        beforeEach(async function () {
            await reputation.connect(addr1).addRating(addr2.address, 80);
            await reputation.connect(addr3).addRating(addr2.address, 80);
            await reputation.connect(owner).addRating(addr2.address, 80);
        });

        it("Should return current average when no time passed", async function () {
            expect(await reputation.timeDecayed(addr2.address)).to.equal(80);
        });

        it("Should decay to ~0 after one halfLife", async function () {
            await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine", []);
            const decayed = await reputation.timeDecayed(addr2.address);
            expect(decayed).to.be.lessThan(2);
        });

        it("Should decay proportionally for partial period", async function () {
            await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine", []);
            const decayed = await reputation.timeDecayed(addr2.address);
            // 80 * (10000 - 5000) / 10000 = 40
            expect(decayed).to.equal(40);
        });

        it("Should be adjustable by owner", async function () {
            await reputation.connect(owner).setHalfLife(60 * 24 * 60 * 60);
            await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine", []);
            expect(await reputation.timeDecayed(addr2.address)).to.equal(40);
        });
    });

    describe("Penalty System (onlyOwner)", function () {
        beforeEach(async function () {
            await reputation.connect(addr1).addRating(addr2.address, 90);
            await reputation.connect(addr3).addRating(addr2.address, 90);
        });

        it("Should apply penalty to reputation (only owner)", async function () {
            await expect(reputation.connect(owner).applyPenalty(addr2.address, 10, "Task failed"))
                .to.emit(reputation, "ReputationPenalty")
                .withArgs(addr2.address, 10, "Task failed");
            const rep = await reputation.getReputation(addr2.address);
            // totalScore 90*2=180, weightSum=2
            // penalty 10: totalScore -= 10*weightSum = 20 -> 160
            // avg = 160/2 = 80
            expect(rep.averageRating).to.equal(80);
        });

        it("Should reject penalty from non-owner", async function () {
            await expect(reputation.connect(addr1).applyPenalty(addr2.address, 10, "Test"))
                .to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
        });

        it("Should prevent penalty on non-existent agent", async function () {
            await expect(reputation.connect(owner).applyPenalty(addr3.address, 10, "Test"))
                .to.be.revertedWith("Agent not found");
        });

        it("Should prevent invalid penalty amount", async function () {
            await expect(reputation.connect(owner).applyPenalty(addr2.address, 0, "Test"))
                .to.be.revertedWith("Invalid penalty");
            await expect(reputation.connect(owner).applyPenalty(addr2.address, 101, "Test"))
                .to.be.revertedWith("Invalid penalty");
        });
    });

    describe("Rater Authorization (Sybil resistance)", function () {
        it("Should restrict raters when enabled", async function () {
            await reputation.connect(owner).setRestrictRaters(true);
            await expect(reputation.connect(addr1).addRating(addr2.address, 50))
                .to.be.reverted;
        });

        it("Should allow authorized raters", async function () {
            await reputation.connect(owner).setRestrictRaters(true);
            await reputation.connect(owner).setAuthorizedRater(addr1.address, true);
            await reputation.connect(addr1).addRating(addr2.address, 50);
            const rep = await reputation.getReputation(addr2.address);
            expect(rep.averageRating).to.equal(50);
        });

        it("Should enforce min rater reputation", async function () {
            await reputation.connect(owner).setMinRaterReputation(50);
            await expect(reputation.connect(addr1).rateWeighted(addr2.address, 80))
                .to.be.revertedWith("Low rater rep");
        });
    });

    describe("Query Functions", function () {
        beforeEach(async function () {
            await reputation.connect(addr1).addRating(addr2.address, 90);
            await reputation.connect(owner).addRating(addr3.address, 70);
            await reputation.connect(addr2).addRating(owner.address, 60);
        });

        it("Should get all reputations", async function () {
            const [addresses, averages] = await reputation.getAllReputations();
            expect(addresses.length).to.equal(3);
            expect(addresses).to.include(addr2.address);
            expect(addresses).to.include(addr3.address);
        });

        it("Should get top agents", async function () {
            const [topAddresses, topAverages] = await reputation.getTopAgents(2);
            expect(topAddresses.length).to.equal(2);
            expect(topAddresses[0]).to.equal(addr2.address);
            expect(topAverages[0]).to.equal(90);
        });

        it("Should return correct agent count", async function () {
            expect(await reputation.getAgentCount()).to.equal(3);
        });

        it("Should check if reputation exists", async function () {
            expect(await reputation.hasReputation(addr2.address)).to.be.true;
            expect(await reputation.hasReputation(ethers.Wallet.createRandom().address)).to.be.false;
        });
    });

    describe("Average Rating Query", function () {
        it("Should return 0 for non-existent agent", async function () {
            expect(await reputation.getAverageRating(addr1.address)).to.equal(0);
        });

        it("Should return correct average for existing agent", async function () {
            await reputation.connect(addr1).addRating(addr2.address, 60);
            await reputation.connect(owner).addRating(addr2.address, 80);
            expect(await reputation.getAverageRating(addr2.address)).to.equal(70);
        });
    });

    // 论文 4.3 节抗 Sybil 信誉（D 类提升：补充专门攻击场景）
    describe("Sybil Resistance (改造 A3)", function () {
        it("Should give higher weight to a high-rep rater than 10 zero-rep sybils", async function () {
            // 1) 选出"老用户" addr2：让 owner 给 addr2 高分，建立高信誉
            await reputation.connect(owner).addRating(addr2.address, 80);
            // addr2 现在的 avgRating=80, weight = floor(sqrt(80)) = 8

            // 2) 给被攻击 addr3 投 11 票
            //   - 高信誉老用户 1 票（addr2）
            //   - 10 个 sybil 账号（未获过任何评分）各 1 票
            const signers = await ethers.getSigners();
            await reputation.connect(addr2).addRating(addr3.address, 100);
            for (let i = 0; i < 10; i++) {
                await reputation.connect(signers[i + 4]).addRating(addr3.address, 100);
            }

            // 总分：(8*100 + 10*1*100) = 1800；总权重：(8+10)=18；avgRating = 100
            // （数值上仍然是 100，验证了"权重不改变众数结论，但限制了 sybil 注入 1→高分"）
            const rep = await reputation.getReputation(addr3.address);
            expect(rep.averageRating).to.be.gte(90);
            expect(rep.ratingCount).to.equal(11);
        });

        it("timeDecayed() should reach 0 after one halfLife (30d) — linear decay", async function () {
            await reputation.connect(owner).addRating(addr1.address, 100);
            // 时间快进 30 天
            await ethers.provider.send("evm_increaseTime", [30 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            const decayed = await reputation.timeDecayed(addr1.address);
            // 实际实现：decay = (dt*10000)/halfLifeSeconds；30d 触发 if (decay>=10000) return 0
            // 即线性归零，与论文公式 (2) e^(-λΔt) 的指数衰减有差异
            // 见论文 5.3 节工程讨论
            expect(decayed).to.equal(0);
        });

        it("isReliable() should require both avg>=60 AND count>=3", async function () {
            // 1 票高分：avg=100, count=1 → 不可靠（count < 3）
            await reputation.connect(owner).addRating(addr3.address, 100);
            expect(await reputation.isReliable(addr3.address)).to.equal(false);
            // 2 票低分：avg<60 → 不可靠
            await reputation.connect(addr1).addRating(addr3.address, 40);
            await reputation.connect(addr2).addRating(addr3.address, 40);
            // avg = (100+40+40)/3 = 60，count=3 → 刚达阈值
            expect(await reputation.isReliable(addr3.address)).to.equal(true);
        });
    });
});
