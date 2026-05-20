const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Reputation Contract", function () {
    let reputation;
    let owner, addr1, addr2;

    beforeEach(async function () {
        [owner, addr1, addr2] = await ethers.getSigners();

        const Reputation = await ethers.getContractFactory("Reputation");
        reputation = await Reputation.deploy();
        await reputation.waitForDeployment();
    });

    describe("Rating System", function () {
        it("Should add first rating and create reputation entry", async function () {
            await expect(reputation.addRating(addr1.address, 5))
                .to.emit(reputation, "ReputationUpdated")
                .withArgs(addr1.address, 5, 1);

            const rep = await reputation.getReputation(addr1.address);
            expect(rep.averageRating).to.equal(5);
            expect(rep.ratingCount).to.equal(1);
        });

        it("Should calculate average correctly for multiple ratings", async function () {
            await reputation.addRating(addr1.address, 4);
            await reputation.addRating(addr1.address, 5);
            await reputation.addRating(addr1.address, 3);

            const rep = await reputation.getReputation(addr1.address);
            expect(rep.totalScore).to.equal(12); // 4+5+3
            expect(rep.ratingCount).to.equal(3);
            expect(rep.averageRating).to.equal(4); // 12/3 = 4
        });

        it("Should reject invalid ratings", async function () {
            await expect(
                reputation.addRating(addr1.address, 0)
            ).to.be.revertedWith("Invalid rating");

            await expect(
                reputation.addRating(addr1.address, 6)
            ).to.be.revertedWith("Invalid rating");
        });

        it("Should reject zero address", async function () {
            await expect(
                reputation.addRating(ethers.ZeroAddress, 5)
            ).to.be.revertedWith("Invalid address");
        });
    });

    describe("Reliability Checks", function () {
        beforeEach(async function () {
            // Create a reliable agent
            await reputation.addRating(addr1.address, 4);
            await reputation.addRating(addr1.address, 5);
            await reputation.addRating(addr1.address, 4);

            // Create an unreliable agent
            await reputation.addRating(addr2.address, 2);
            await reputation.addRating(addr2.address, 1);
        });

        it("Should identify reliable agents", async function () {
            expect(await reputation.isReliable(addr1.address)).to.be.true;
            expect(await reputation.isReliable(addr2.address)).to.be.false;
        });

        it("Should check threshold correctly", async function () {
            expect(await reputation.meetsThreshold(addr1.address, 4)).to.be.true;
            expect(await reputation.meetsThreshold(addr1.address, 5)).to.be.false;
        });
    });

    describe("Penalty System", function () {
        beforeEach(async function () {
            await reputation.addRating(addr1.address, 5);
            await reputation.addRating(addr1.address, 5);
        });

        it("Should apply penalty to reputation", async function () {
            await expect(
                reputation.applyPenalty(addr1.address, 2, "Task failed")
            )
                .to.emit(reputation, "ReputationPenalty")
                .withArgs(addr1.address, 2, "Task failed");

            const rep = await reputation.getReputation(addr1.address);
            expect(rep.averageRating).to.equal(4); // (5+5-2)/2 = 4
        });

        it("Should prevent penalty on non-existent agent", async function () {
            await expect(
                reputation.applyPenalty(addr2.address, 2, "Test")
            ).to.be.revertedWith("Agent not found");
        });

        it("Should prevent invalid penalty amount", async function () {
            await expect(
                reputation.applyPenalty(addr1.address, 0, "Test")
            ).to.be.revertedWith("Invalid penalty");
        });
    });

    describe("Query Functions", function () {
        beforeEach(async function () {
            await reputation.addRating(addr1.address, 5);
            await reputation.addRating(addr2.address, 3);
            await reputation.addRating(owner.address, 4);
        });

        it("Should get all reputations", async function () {
            const [addresses, averages] = await reputation.getAllReputations();

            expect(addresses.length).to.equal(3);
            expect(addresses).to.include(addr1.address);
            expect(addresses).to.include(addr2.address);
            expect(addresses).to.include(owner.address);
        });

        it("Should get top agents", async function () {
            const [topAddresses, topAverages] = await reputation.getTopAgents(2);

            expect(topAddresses.length).to.equal(2);
            expect(topAddresses[0]).to.equal(addr1.address); // Highest rating (5)
            expect(topAverages[0]).to.equal(5);
        });

        it("Should return correct agent count", async function () {
            expect(await reputation.getAgentCount()).to.equal(3);
        });

        it("Should check if reputation exists", async function () {
            expect(await reputation.hasReputation(addr1.address)).to.be.true;
            expect(await reputation.hasReputation(ethers.Wallet.createRandom().address)).to.be.false;
        });
    });

    describe("Average Rating Query", function () {
        it("Should return 0 for non-existent agent", async function () {
            expect(await reputation.getAverageRating(addr1.address)).to.equal(0);
        });

        it("Should return correct average for existing agent", async function () {
            await reputation.addRating(addr1.address, 3);
            await reputation.addRating(addr1.address, 4);
            expect(await reputation.getAverageRating(addr1.address)).to.equal(3);
        });
    });
});
