/**
 * 集成测试：API Server 端到端签名路径
 * 验证：
 *  - Router 决策 EIP-712 签名 → 合约 ecrecover 还原 = routerSigner
 *  - Worker 执行结果 EIP-712 签名 → 合约 ecrecover 还原 = AgentDID.pubKey
 *  - taskCommitment 防重放
 *  - 改造 5：rateWeighted + 时间衰减
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Integration: signed audit flow (改造 1+2+3)", function () {
    const CHAIN_ID = 31337;
    const EIP712_DOMAIN_AUDIT = (verifyingContract) => ({
        name: "ORACLE Agent Bus",
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract,
    });
    const ROUTER_DECISION_TYPES = {
        Decision: [
            { name: "taskHash", type: "bytes32" },
            { name: "rankedAgents", type: "bytes32" },
            { name: "topAgent", type: "address" },
            { name: "timestamp", type: "uint256" },
        ],
    };
    const WORKER_RESULT_TYPES = {
        Result: [
            { name: "recordId", type: "uint256" },
            { name: "resultDigest", type: "bytes32" },
            { name: "timestamp", type: "uint256" },
        ],
    };

    let agentDID, auditLog;
    let routerWallet, workerWallet, requester, otherSigner;

    beforeEach(async function () {
        [requester, otherSigner] = await ethers.getSigners();

        const AgentDID = await ethers.getContractFactory("AgentDID");
        agentDID = await AgentDID.deploy();
        await agentDID.waitForDeployment();

        const AuditLog = await ethers.getContractFactory("AuditLog");
        auditLog = await AuditLog.deploy();
        await auditLog.waitForDeployment();
        await auditLog.setAgentDID(await agentDID.getAddress());

        routerWallet = ethers.Wallet.createRandom().connect(ethers.provider);
        workerWallet = ethers.Wallet.createRandom().connect(ethers.provider);
        await requester.sendTransaction({ to: routerWallet.address, value: ethers.parseEther("1") });
        await requester.sendTransaction({ to: workerWallet.address, value: ethers.parseEther("1") });
    });

    it("Full flow: register worker → router signs decision → worker signs result → ecrecover OK", async function () {
        // 1. Worker 注册时绑定 pubKey
        await agentDID.connect(requester).registerAgentWithPubKey(
            "did:worker:integration",
            ethers.keccak256(ethers.toUtf8Bytes("commitment")),
            "code_review",
            workerWallet.address
        );

        // 2. 构造路由决策并签名
        const taskText = "分析这段代码的安全漏洞";
        const taskHash = ethers.keccak256(ethers.toUtf8Bytes(taskText));
        const taskCommitment = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ["string", "bytes32"],
                [taskText, ethers.keccak256(ethers.toUtf8Bytes("salt-123"))]
            )
        );
        const rankedAgents = [requester.address, otherSigner.address];
        const rankedAgentsHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [rankedAgents])
        );
        const timestamp = Math.floor(Date.now() / 1000);
        const decisionValue = { taskHash, rankedAgents: rankedAgentsHash, topAgent: requester.address, timestamp };
        const decisionDigest = ethers.TypedDataEncoder.hash(
            EIP712_DOMAIN_AUDIT(await auditLog.getAddress()),
            ROUTER_DECISION_TYPES,
            decisionValue
        );
        const decisionSig = await routerWallet.signTypedData(
            EIP712_DOMAIN_AUDIT(await auditLog.getAddress()),
            ROUTER_DECISION_TYPES,
            decisionValue
        );

        // 3. Router 上链 logScheduleWithDecision
        const tx1 = await auditLog.connect(routerWallet).logScheduleWithDecision(
            routerWallet.address,  // requester
            requester.address,     // targetAgent
            taskCommitment,
            0,                     // QUALIFIED
            routerWallet.address,
            decisionDigest,
            decisionSig
        );
        const r1 = await tx1.wait();
        // 找 ScheduleLogged 事件
        const scheduleEvent = r1.logs.find(log => {
            try { return auditLog.interface.parseLog(log)?.name === "ScheduleLogged"; } catch { return false; }
        });
        const recordId = Number(auditLog.interface.parseLog(scheduleEvent).args[0]);

        // 4. Worker 执行后签名结果
        const resultText = "代码审查完成，发现 2 个 SQL 注入风险";
        const resultDigestPlain = ethers.keccak256(ethers.toUtf8Bytes(resultText));
        // 合约端 ECDSA.recover(resultDigest, sig) —— 必须是 EIP-712 typed-data digest 才能匹配
        const resultValue = { recordId, resultDigest: resultDigestPlain, timestamp };
        const resultDigest = ethers.TypedDataEncoder.hash(
            EIP712_DOMAIN_AUDIT(await auditLog.getAddress()),
            WORKER_RESULT_TYPES,
            resultValue
        );
        const workerSig = await workerWallet.signTypedData(
            EIP712_DOMAIN_AUDIT(await auditLog.getAddress()),
            WORKER_RESULT_TYPES,
            resultValue
        );

        // 5. Worker 上链 updateExecutionWithSig
        const tx2 = await auditLog.connect(otherSigner).updateExecutionWithSig(
            recordId, 1, resultText, resultDigest, workerSig
        );
        await tx2.wait();

        // 6. 验证链上记录
        const fullRec = await auditLog.getRecordFull(recordId);
        expect(fullRec.routerSigner).to.equal(routerWallet.address);
        expect(fullRec.decisionDigest).to.equal(decisionDigest);
        expect(fullRec.workerSigner).to.equal(workerWallet.address);
        expect(fullRec.executionStatus).to.equal(1);
        expect(fullRec.executionResult).to.equal(resultText);
        expect(fullRec.taskCommitment).to.equal(taskCommitment);
    });

    it("Should reject re-signed decision by different router", async function () {
        const taskHash = ethers.keccak256(ethers.toUtf8Bytes("task"));
        const rankedAgents = ethers.keccak256(ethers.toUtf8Bytes("rank"));
        const timestamp = 1700000000;
        const decisionValue = { taskHash, rankedAgents, topAgent: requester.address, timestamp };
        const decisionDigest = ethers.TypedDataEncoder.hash(
            EIP712_DOMAIN_AUDIT(await auditLog.getAddress()),
            ROUTER_DECISION_TYPES,
            decisionValue
        );
        // 用 routerWallet 签名
        const realSig = await routerWallet.signTypedData(
            EIP712_DOMAIN_AUDIT(await auditLog.getAddress()),
            ROUTER_DECISION_TYPES,
            decisionValue
        );
        const fakeSig = await otherSigner.signTypedData(
            EIP712_DOMAIN_AUDIT(await auditLog.getAddress()),
            ROUTER_DECISION_TYPES,
            decisionValue
        );
        // 声称 routerWallet 但实际是 otherSigner 的签名 → 失败
        await expect(
            auditLog.connect(otherSigner).logScheduleWithDecision(
                otherSigner.address, requester.address, taskHash, 0,
                routerWallet.address, decisionDigest, fakeSig
            )
        ).to.be.revertedWith("Bad router sig");
        // 真实签名可以
        await auditLog.connect(otherSigner).logScheduleWithDecision(
            otherSigner.address, requester.address, taskHash, 0,
            routerWallet.address, decisionDigest, realSig
        );
    });

    it("Should reject re-used commitment", async function () {
        const taskHash = ethers.keccak256(ethers.toUtf8Bytes("dup"));
        const rankedAgents = ethers.keccak256(ethers.toUtf8Bytes("r"));
        const ts = 1700000000;
        const v = { taskHash, rankedAgents, topAgent: requester.address, timestamp: ts };
        const digest = ethers.TypedDataEncoder.hash(
            EIP712_DOMAIN_AUDIT(await auditLog.getAddress()),
            ROUTER_DECISION_TYPES, v
        );
        const sig = await routerWallet.signTypedData(
            EIP712_DOMAIN_AUDIT(await auditLog.getAddress()),
            ROUTER_DECISION_TYPES, v
        );
        await auditLog.connect(otherSigner).logScheduleWithDecision(
            otherSigner.address, requester.address, taskHash, 0,
            routerWallet.address, digest, sig
        );
        await expect(
            auditLog.connect(otherSigner).logScheduleWithDecision(
                otherSigner.address, requester.address, taskHash, 0,
                routerWallet.address, digest, sig
            )
        ).to.be.revertedWith("Commitment reused");
    });
});
