const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AuditLog Contract", function () {
    let auditLog;
    let owner, requester, agent;

    beforeEach(async function () {
        [owner, requester, agent] = await ethers.getSigners();

        const AuditLog = await ethers.getContractFactory("AuditLog");
        auditLog = await AuditLog.deploy();
        await auditLog.waitForDeployment();
    });

    describe("Schedule Logging", function () {
        it("Should log a schedule decision", async function () {
            const taskDescription = "Process data batch #123";

            const tx = await auditLog.logSchedule(
                requester.address,
                agent.address,
                taskDescription,
                0 // QUALIFIED
            );

            const receipt = await tx.wait();
            const logEvent = receipt.logs.find(
                log => auditLog.interface.parseLog(log)?.name === "ScheduleLogged"
            );

            expect(logEvent).to.exist;
            const parsed = auditLog.interface.parseLog(logEvent);
            expect(parsed.args.requester).to.equal(requester.address);
            expect(parsed.args.targetAgent).to.equal(agent.address);
        });

        it("Should increment record count", async function () {
            expect(await auditLog.recordCount()).to.equal(0);

            await auditLog.logSchedule(requester.address, agent.address, "Task1", 0);
            expect(await auditLog.recordCount()).to.equal(1);

            await auditLog.logSchedule(requester.address, agent.address, "Task2", 0);
            expect(await auditLog.recordCount()).to.equal(2);
        });

        it("Should generate sequential record IDs", async function () {
            const tx1 = await auditLog.logSchedule(requester.address, agent.address, "Task1", 0);
            const receipt1 = await tx1.wait();
            const event1 = auditLog.interface.parseLog(receipt1.logs[0]);
            const recordId1 = event1.args[0];

            const tx2 = await auditLog.logSchedule(requester.address, agent.address, "Task2", 0);
            const receipt2 = await tx2.wait();
            const event2 = auditLog.interface.parseLog(receipt2.logs[0]);
            const recordId2 = event2.args[0];

            expect(recordId2).to.equal(recordId1 + 1n);
        });
    });

    describe("Execution Updates", function () {
        let recordId;

        beforeEach(async function () {
            const tx = await auditLog.logSchedule(requester.address, agent.address, "Test task", 0);
            const receipt = await tx.wait();
            const event = auditLog.interface.parseLog(receipt.logs[0]);
            recordId = event.args[0];
        });

        it("Should update execution status to success", async function () {
            await expect(
                auditLog.updateExecution(recordId, 1, "Task completed successfully")
            )
                .to.emit(auditLog, "ExecutionUpdated")
                .withArgs(recordId, 1, "Task completed successfully");

            const record = await auditLog.getRecord(recordId);
            expect(record.executionStatus).to.equal(1); // SUCCESS
            expect(record.executionResult).to.equal("Task completed successfully");
        });

        it("Should update execution status to failed", async function () {
            await auditLog.updateExecution(recordId, 2, "Task failed: timeout");

            const record = await auditLog.getRecord(recordId);
            expect(record.executionStatus).to.equal(2); // FAILED
        });
    });

    describe("Rating System", function () {
        let recordId;

        beforeEach(async function () {
            const tx = await auditLog.logSchedule(requester.address, agent.address, "Test task", 0);
            const receipt = await tx.wait();
            const event = auditLog.interface.parseLog(receipt.logs[0]);
            recordId = event.args[0];
        });

        it("Should allow requester to submit rating", async function () {
            await expect(auditLog.connect(requester).submitRating(recordId, 5))
                .to.emit(auditLog, "RatingSubmitted")
                .withArgs(recordId, 5);

            const record = await auditLog.getRecord(recordId);
            expect(record.reputationRating).to.equal(5);
        });

        it("Should reject invalid ratings", async function () {
            await expect(
                auditLog.connect(requester).submitRating(recordId, 0)
            ).to.be.revertedWith("Rating must be 1-5");

            await expect(
                auditLog.connect(requester).submitRating(recordId, 6)
            ).to.be.revertedWith("Rating must be 1-5");
        });

        it("Should prevent non-requester from rating", async function () {
            await expect(
                auditLog.connect(agent).submitRating(recordId, 5)
            ).to.be.revertedWith("Not requester");
        });

        it("Should prevent duplicate ratings", async function () {
            await auditLog.connect(requester).submitRating(recordId, 4);

            await expect(
                auditLog.connect(requester).submitRating(recordId, 5)
            ).to.be.revertedWith("Already rated");
        });
    });

    describe("Query Functions", function () {
        beforeEach(async function () {
            await auditLog.logSchedule(requester.address, agent.address, "Task1", 0);
            await auditLog.logSchedule(requester.address, agent.address, "Task2", 0);
            await auditLog.logSchedule(owner.address, agent.address, "Task3", 0);
        });

        it("Should get records by agent", async function () {
            const records = await auditLog.getRecordsByAgent(agent.address);
            expect(records.length).to.equal(3);
        });

        it("Should get records by requester", async function () {
            const records = await auditLog.getRecordsByRequester(requester.address);
            expect(records.length).to.equal(2);
        });

        it("Should get all records", async function () {
            const records = await auditLog.getAllRecords();
            expect(records.length).to.equal(3);
        });

        it("Should query by time range", async function () {
            const currentTime = await ethers.provider.getBlock("latest");
            const startTime = currentTime.timestamp - 1000;
            const endTime = currentTime.timestamp + 1000;

            const records = await auditLog.getRecordsByTimeRange(startTime, endTime);
            expect(records.length).to.be.greaterThan(0);
        });
    });

    describe("Utility Functions", function () {
        it("Should return correct decision reason string", async function () {
            expect(await auditLog.getDecisionReasonString(0)).to.equal("Qualified");
            expect(await auditLog.getDecisionReasonString(1)).to.equal("Insufficient Reputation");
            expect(await auditLog.getDecisionReasonString(2)).to.equal("Not Registered");
        });

        it("Should return correct execution status string", async function () {
            expect(await auditLog.getExecutionStatusString(0)).to.equal("Pending");
            expect(await auditLog.getExecutionStatusString(1)).to.equal("Success");
            expect(await auditLog.getExecutionStatusString(2)).to.equal("Failed");
        });
    });
});
