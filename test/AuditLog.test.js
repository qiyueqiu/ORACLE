const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AuditLog Contract", function () {
    let auditLog;
    let owner, requester, agent;
    const EIP712_DOMAIN = (verifyingContract) => ({
        name: "ASB AuditLog",
        version: "1",
        chainId: 31337,
        verifyingContract
    });
    const ROUTER_TYPES = {
        Decision: [
            { name: "taskHash", type: "bytes32" },
            { name: "rankedAgents", type: "bytes32" },
            { name: "topAgent", type: "address" },
            { name: "timestamp", type: "uint256" }
        ]
    };

    beforeEach(async function () {
        [owner, requester, agent] = await ethers.getSigners();

        const AuditLog = await ethers.getContractFactory("AuditLog");
        auditLog = await AuditLog.deploy();
        await auditLog.waitForDeployment();
    });

    describe("Schedule Logging (legacy)", function () {
        it("Should log a schedule decision", async function () {
            const taskDescription = "Process data batch #123";
            const tx = await auditLog.logSchedule(
                requester.address, agent.address, taskDescription, 0
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
            const r1 = await tx1.wait();
            const id1 = auditLog.interface.parseLog(r1.logs[0]).args[0];
            const tx2 = await auditLog.logSchedule(requester.address, agent.address, "Task2", 0);
            const r2 = await tx2.wait();
            const id2 = auditLog.interface.parseLog(r2.logs[0]).args[0];
            expect(id2).to.equal(id1 + 1n);
        });
    });

    describe("Schedule Logging with Router signature (改造 1)", function () {
        let routerWallet;
        let decisionDigest;
        let decisionSig;

        beforeEach(async function () {
            routerWallet = ethers.Wallet.createRandom().connect(ethers.provider);
            await owner.sendTransaction({ to: routerWallet.address, value: ethers.parseEther("1") });
            const value = {
                taskHash: ethers.keccak256(ethers.toUtf8Bytes("task1")),
                rankedAgents: ethers.keccak256(ethers.toUtf8Bytes("rank1")),
                topAgent: agent.address,
                timestamp: 1700000000
            };
            // 关键：digest = EIP-712 typed-data hash（合约端 ECDSA.recover 也是用这个 hash）
            decisionDigest = ethers.TypedDataEncoder.hash(
                EIP712_DOMAIN(await auditLog.getAddress()),
                ROUTER_TYPES,
                value
            );
            decisionSig = await routerWallet.signTypedData(
                EIP712_DOMAIN(await auditLog.getAddress()),
                ROUTER_TYPES,
                value
            );
        });

        it("Should accept valid router signature", async function () {
            const taskCommitment = ethers.keccak256(ethers.toUtf8Bytes("task1:salt"));
            const tx = await auditLog.logScheduleWithDecision(
                requester.address, agent.address, taskCommitment, 0,
                routerWallet.address, decisionDigest, decisionSig
            );
            const r = await tx.wait();
            expect(r.status).to.equal(1);
            // 读取完整记录验证 routerSigner
            const rec = await auditLog.getRecordFull(1);
            expect(rec.routerSigner).to.equal(routerWallet.address);
            expect(rec.decisionDigest).to.equal(decisionDigest);
        });

        it("Should reject invalid router signature", async function () {
            const fakeWallet = ethers.Wallet.createRandom();
            const taskCommitment = ethers.keccak256(ethers.toUtf8Bytes("task2:salt"));
            await expect(
                auditLog.logScheduleWithDecision(
                    requester.address, agent.address, taskCommitment, 0,
                    fakeWallet.address, decisionDigest, decisionSig
                )
            ).to.be.revertedWith("Bad router sig");
        });

        it("Should reject commitment reuse", async function () {
            const taskCommitment = ethers.keccak256(ethers.toUtf8Bytes("task3:salt"));
            await auditLog.logScheduleWithDecision(
                requester.address, agent.address, taskCommitment, 0,
                routerWallet.address, decisionDigest, decisionSig
            );
            await expect(
                auditLog.logScheduleWithDecision(
                    requester.address, agent.address, taskCommitment, 0,
                    routerWallet.address, decisionDigest, decisionSig
                )
            ).to.be.revertedWith("Commitment reused");
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
                .withArgs(recordId, 1, "Task completed successfully", ethers.ZeroAddress);

            const record = await auditLog.getRecord(recordId);
            expect(record.executionStatus).to.equal(1);
            expect(record.executionResult).to.equal("Task completed successfully");
        });

        it("Should update execution status to failed", async function () {
            await auditLog.updateExecution(recordId, 2, "Task failed: timeout");
            const record = await auditLog.getRecord(recordId);
            expect(record.executionStatus).to.equal(2);
        });
    });

    describe("Execution Updates with Worker signature (改造 2)", function () {
        let recordId, workerWallet, did;

        beforeEach(async function () {
            const AgentDID = await ethers.getContractFactory("AgentDID");
            did = await AgentDID.deploy();
            await did.waitForDeployment();
            await auditLog.setAgentDID(await did.getAddress());

            // 让 agent.address 作为 targetAgent 在 AgentDID 上注册
            workerWallet = ethers.Wallet.createRandom();
            // 给 agent 一些 ETH 以发送 tx（agent 是 hardhat 内置 signer 本来就有）
            await did.connect(agent).registerAgentWithPubKey(
                "did:worker:1",
                ethers.keccak256(ethers.toUtf8Bytes("commitment")),
                "code_review",
                workerWallet.address
            );

            const tx = await auditLog.logSchedule(requester.address, agent.address, "Test task", 0);
            const receipt = await tx.wait();
            recordId = auditLog.interface.parseLog(receipt.logs[0]).args[0];
        });

        it("Should reject signature from non-pubKey", async function () {
            const wrong = ethers.Wallet.createRandom();
            const result = "ok";
            const ts = 1700000000;
            const value = { recordId, result, timestamp: ts };
            const resultDigest = ethers.TypedDataEncoder.hash(
                { name: "ASB AuditLog", version: "1", chainId: 31337, verifyingContract: await auditLog.getAddress() },
                { Result: [
                    { name: "recordId", type: "uint256" },
                    { name: "result", type: "string" },
                    { name: "timestamp", type: "uint256" }
                ]},
                value
            );
            const sig = await wrong.signTypedData(
                { name: "ASB AuditLog", version: "1", chainId: 31337, verifyingContract: await auditLog.getAddress() },
                { Result: [
                    { name: "recordId", type: "uint256" },
                    { name: "result", type: "string" },
                    { name: "timestamp", type: "uint256" }
                ]},
                value
            );
            await expect(
                auditLog.updateExecutionWithSig(recordId, 1, result, resultDigest, sig)
            ).to.be.revertedWith("Sig not from worker pubKey");
        });

        it("Should accept signature from correct worker pubKey", async function () {
            const result = "completed";
            const ts = 1700000000;
            const value = { recordId, result, timestamp: ts };
            const domain = { name: "ASB AuditLog", version: "1", chainId: 31337, verifyingContract: await auditLog.getAddress() };
            const types = { Result: [
                { name: "recordId", type: "uint256" },
                { name: "result", type: "string" },
                { name: "timestamp", type: "uint256" }
            ]};
            const resultDigest = ethers.TypedDataEncoder.hash(domain, types, value);
            const sig = await workerWallet.signTypedData(domain, types, value);
            await expect(
                auditLog.updateExecutionWithSig(recordId, 1, result, resultDigest, sig)
            ).to.emit(auditLog, "ExecutionUpdated").withArgs(recordId, 1, result, workerWallet.address);
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
            const records = await auditLog.getRecordsByTimeRange(currentTime.timestamp - 1000, currentTime.timestamp + 1000);
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

    // 论文 4.2 节 commit-reveal 双阶段（D 类提升：补充专门测试覆盖 reveal 路径）
    describe("Commit-Reveal Two-Phase (改造 A4)", function () {
        const TASK = "审查供应商 X 合同第 5 条违约责任";
        const SALT = ethers.hexlify(ethers.randomBytes(32));
        let taskCommitment, recordId, decisionDigest, decisionSig;

        beforeEach(async function () {
            taskCommitment = ethers.keccak256(
                ethers.solidityPacked(["string", "bytes32"], [TASK, SALT])
            );
            // 通过 logScheduleWithDecision 提交一个自定义 commitment
            const taskHash = ethers.keccak256(ethers.toUtf8Bytes(TASK));
            const ts = Math.floor(Date.now() / 1000);
            const ranked = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [[agent.address]])
            );
            const domain = EIP712_DOMAIN(await auditLog.getAddress());
            decisionDigest = ethers.TypedDataEncoder.hash(
                domain, ROUTER_TYPES,
                { taskHash, rankedAgents: ranked, topAgent: agent.address, timestamp: ts }
            );
            // 父作用域无 router signer，使用 owner 充当 router
            decisionSig = await owner.signTypedData(
                domain, ROUTER_TYPES,
                { taskHash, rankedAgents: ranked, topAgent: agent.address, timestamp: ts }
            );
            const tx = await auditLog.logScheduleWithDecision(
                requester.address, agent.address, taskCommitment,
                0, // QUALIFIED
                owner.address, decisionDigest, decisionSig
            );
            const r = await tx.wait();
            recordId = Number(r.logs[0].topics[1]);
        });

        it("Should keep taskDescription secret before reveal (no plaintext on chain)", async function () {
            const revealed = await auditLog.getRevealedTask(recordId);
            expect(revealed.revealed).to.equal(false);
            expect(revealed.taskDescription).to.equal("");
            // 合约中只持有 32 字节 commitment
            const rec = await auditLog.records(recordId);
            expect(rec.taskCommitment).to.equal(taskCommitment);
        });

        it("Should accept valid reveal: keccak256(task || salt) == commitment", async function () {
            await expect(auditLog.revealTask(recordId, TASK, SALT))
                .to.emit(auditLog, "TaskRevealed");
            const revealed = await auditLog.getRevealedTask(recordId);
            expect(revealed.revealed).to.equal(true);
            expect(revealed.taskDescription).to.equal(TASK);
        });

        it("Should reject reveal with wrong task description", async function () {
            await expect(
                auditLog.revealTask(recordId, "篡改后的内容", SALT)
            ).to.be.revertedWith("Commitment mismatch");
        });

        it("Should reject reveal with wrong salt", async function () {
            const wrongSalt = ethers.hexlify(ethers.randomBytes(32));
            await expect(
                auditLog.revealTask(recordId, TASK, wrongSalt)
            ).to.be.revertedWith("Commitment mismatch");
        });

        it("Should reject double reveal", async function () {
            await auditLog.revealTask(recordId, TASK, SALT);
            await expect(
                auditLog.revealTask(recordId, TASK, SALT)
            ).to.be.revertedWith("Already revealed");
        });

        it("computeCommitment() should be consistent off-chain and on-chain", async function () {
            const onchain = await auditLog.computeCommitment(TASK, SALT);
            const offchain = ethers.keccak256(
                ethers.solidityPacked(["string", "bytes32"], [TASK, SALT])
            );
            expect(onchain).to.equal(offchain);
        });
    });
});
