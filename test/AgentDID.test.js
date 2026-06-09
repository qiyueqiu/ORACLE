const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentDID Contract", function () {
    let agentDID;
    let owner, addr1, addr2;

    beforeEach(async function () {
        [owner, addr1, addr2] = await ethers.getSigners();

        const AgentDID = await ethers.getContractFactory("AgentDID");
        agentDID = await AgentDID.deploy();
        await agentDID.waitForDeployment();
    });

    describe("Agent Registration", function () {
        it("Should register a new agent successfully", async function () {
            const did = "did:agent:123456";
            const commitment = ethers.keccak256(ethers.toUtf8Bytes("secret+qualification"));
            const qualificationType = "DataProcessing";

            await expect(
                agentDID.connect(addr1).registerAgent(did, commitment, qualificationType)
            )
                .to.emit(agentDID, "AgentRegistered")
                .withArgs(addr1.address, did, commitment, qualificationType, ethers.ZeroAddress);

            const agent = await agentDID.getAgent(addr1.address);
            expect(agent.did).to.equal(did);
            expect(agent.qualificationType).to.equal(qualificationType);
            expect(agent.isActive).to.be.true;
        });

        it("Should prevent duplicate registration", async function () {
            const did = "did:agent:123456";
            const commitment = ethers.keccak256(ethers.toUtf8Bytes("secret"));

            await agentDID.connect(addr1).registerAgent(did, commitment, "Type1");

            await expect(
                agentDID.connect(addr1).registerAgent(did, commitment, "Type2")
            ).to.be.revertedWith("Already registered");
        });

        it("Should increment agent count", async function () {
            expect(await agentDID.agentCount()).to.equal(0);

            await agentDID.connect(addr1).registerAgent(
                "did:agent:1",
                ethers.keccak256(ethers.toUtf8Bytes("secret1")),
                "Type1"
            );
            expect(await agentDID.agentCount()).to.equal(1);

            await agentDID.connect(addr2).registerAgent(
                "did:agent:2",
                ethers.keccak256(ethers.toUtf8Bytes("secret2")),
                "Type2"
            );
            expect(await agentDID.agentCount()).to.equal(2);
        });
    });

    describe("Qualification Verification", function () {
        let commitment;
        let secret;
        let nullifier;

        beforeEach(async function () {
            secret = "mySecretValue";
            nullifier = ethers.keccak256(ethers.toUtf8Bytes("uniqueNullifier"));
            const secretHash = ethers.keccak256(ethers.toUtf8Bytes(secret));

            // Commitment = keccak256(abi.encodePacked(nullifier, secretHash))
            commitment = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["bytes32", "bytes32"],
                    [nullifier, secretHash]
                )
            );

            await agentDID.connect(addr1).registerAgent(
                "did:agent:123",
                commitment,
                "DataProcessing"
            );
        });

        it("Should verify qualification proof correctly", async function () {
            const secretHash = ethers.keccak256(ethers.toUtf8Bytes(secret));

            const isValid = await agentDID.verifyQualification(
                nullifier,
                secretHash,
                commitment
            );
            expect(isValid).to.be.true;
        });

        it("Should reject invalid proof", async function () {
            const wrongNullifier = ethers.keccak256(ethers.toUtf8Bytes("wrongNullifier"));
            const secretHash = ethers.keccak256(ethers.toUtf8Bytes(secret));

            const isValid = await agentDID.verifyQualification(
                wrongNullifier,
                secretHash,
                commitment
            );
            expect(isValid).to.be.false;
        });

        it("Should use nullifier and prevent reuse", async function () {
            const secretHash = ethers.keccak256(ethers.toUtf8Bytes(secret));

            await expect(
                agentDID.verifyAndUseQualification(addr1.address, nullifier, secretHash)
            )
                .to.emit(agentDID, "QualificationVerified")
                .withArgs(addr1.address, nullifier, true);

            // Try to reuse the same nullifier
            await expect(
                agentDID.verifyAndUseQualification(addr1.address, nullifier, secretHash)
            ).to.be.revertedWith("Nullifier already used");
        });
    });

    describe("EIP-712 Qualification Verification (改造 4A)", function () {
        const TYPES = {
            Qualification: [
                { name: "agent", type: "address" },
                { name: "nullifier", type: "bytes32" },
                { name: "secretHash", type: "bytes32" },
                { name: "deadline", type: "uint256" }
            ]
        };

        async function domainFor(contract) {
            return {
                name: "ORACLE AgentDID",
                version: "1",
                chainId: 31337,
                verifyingContract: await contract.getAddress()
            };
        }

        let agent, workerWallet;
        beforeEach(async function () {
            workerWallet = ethers.Wallet.createRandom();
            await agentDID.connect(addr1).registerAgentWithPubKey(
                "did:agent:eip712",
                ethers.keccak256(ethers.toUtf8Bytes("commit")),
                "code_review",
                workerWallet.address
            );
        });

        it("Should accept valid EIP-712 signature from agent pubKey", async function () {
            const nullifier = ethers.keccak256(ethers.toUtf8Bytes("n1"));
            const secretHash = ethers.keccak256(ethers.toUtf8Bytes("secret"));
            const deadline = Math.floor(Date.now() / 1000) + 3600;
            const value = { agent: addr1.address, nullifier, secretHash, deadline };
            const sig = await workerWallet.signTypedData(await domainFor(agentDID), TYPES, value);

            await expect(
                agentDID.verifyQualificationEIP712(addr1.address, nullifier, secretHash, deadline, sig)
            ).to.emit(agentDID, "QualificationVerified").withArgs(addr1.address, nullifier, true);
        });

        it("Should reject signature from non-pubKey", async function () {
            const nullifier = ethers.keccak256(ethers.toUtf8Bytes("n2"));
            const secretHash = ethers.keccak256(ethers.toUtf8Bytes("s2"));
            const deadline = Math.floor(Date.now() / 1000) + 3600;
            const wrong = ethers.Wallet.createRandom();
            const sig = await wrong.signTypedData(await domainFor(agentDID), TYPES, { agent: addr1.address, nullifier, secretHash, deadline });

            await expect(
                agentDID.verifyQualificationEIP712(addr1.address, nullifier, secretHash, deadline, sig)
            ).to.be.revertedWith("Sig not from agent pubKey");
        });

        it("Should reject expired signature", async function () {
            const nullifier = ethers.keccak256(ethers.toUtf8Bytes("n3"));
            const secretHash = ethers.keccak256(ethers.toUtf8Bytes("s3"));
            const deadline = 1;  // past
            const value = { agent: addr1.address, nullifier, secretHash, deadline };
            const sig = await workerWallet.signTypedData(await domainFor(agentDID), TYPES, value);

            await expect(
                agentDID.verifyQualificationEIP712(addr1.address, nullifier, secretHash, deadline, sig)
            ).to.be.revertedWith("Signature expired");
        });

        it("Should prevent nullifier reuse", async function () {
            const nullifier = ethers.keccak256(ethers.toUtf8Bytes("n4"));
            const secretHash = ethers.keccak256(ethers.toUtf8Bytes("s4"));
            const deadline = Math.floor(Date.now() / 1000) + 3600;
            const value = { agent: addr1.address, nullifier, secretHash, deadline };
            const sig = await workerWallet.signTypedData(await domainFor(agentDID), TYPES, value);
            await agentDID.verifyQualificationEIP712(addr1.address, nullifier, secretHash, deadline, sig);
            await expect(
                agentDID.verifyQualificationEIP712(addr1.address, nullifier, secretHash, deadline, sig)
            ).to.be.revertedWith("Nullifier already used");
        });
    });

    describe("PubKey binding (改造 2)", function () {
        it("Should register with pubKey", async function () {
            const pubKey = ethers.Wallet.createRandom().address;
            await agentDID.connect(addr1).registerAgentWithPubKey(
                "did:agent:pk1",
                ethers.keccak256(ethers.toUtf8Bytes("commit")),
                "code_review",
                pubKey
            );
            expect(await agentDID.getPubKey(addr1.address)).to.equal(pubKey);
        });

        it("Should reject registerAgentWithPubKey with zero pubKey", async function () {
            await expect(
                agentDID.connect(addr1).registerAgentWithPubKey(
                    "did:agent:bad",
                    ethers.keccak256(ethers.toUtf8Bytes("commit")),
                    "code_review",
                    ethers.ZeroAddress
                )
            ).to.be.revertedWith("pubKey cannot be zero");
        });

        it("Should setPubKey after registration", async function () {
            await agentDID.connect(addr1).registerAgent(
                "did:agent:nopk",
                ethers.keccak256(ethers.toUtf8Bytes("commit")),
                "code_review"
            );
            const newPk = ethers.Wallet.createRandom().address;
            await agentDID.connect(addr1).setPubKey(newPk);
            expect(await agentDID.getPubKey(addr1.address)).to.equal(newPk);
        });

        it("Should reject setPubKey from non-registered agent", async function () {
            await expect(
                agentDID.connect(addr1).setPubKey(ethers.Wallet.createRandom().address)
            ).to.be.revertedWith("Not registered");
        });
    });

    describe("Agent Queries", function () {
        beforeEach(async function () {
            await agentDID.connect(addr1).registerAgent(
                "did:agent:1",
                ethers.keccak256(ethers.toUtf8Bytes("secret1")),
                "Type1"
            );
            await agentDID.connect(addr2).registerAgent(
                "did:agent:2",
                ethers.keccak256(ethers.toUtf8Bytes("secret2")),
                "Type2"
            );
        });

        it("Should return all registered agents", async function () {
            const agents = await agentDID.getAllAgents();
            expect(agents.length).to.equal(2);
            expect(agents[0]).to.equal(addr1.address);
            expect(agents[1]).to.equal(addr2.address);
        });

        it("Should check if agent is registered", async function () {
            expect(await agentDID.isRegistered(addr1.address)).to.be.true;
            expect(await agentDID.isRegistered(owner.address)).to.be.false;
        });
    });

    describe("Agent Management", function () {
        it("Should allow owner to deactivate agent", async function () {
            await agentDID.connect(addr1).registerAgent(
                "did:agent:1",
                ethers.keccak256(ethers.toUtf8Bytes("secret")),
                "Type1"
            );

            await agentDID.connect(addr1).setAgentActive(addr1.address, false);

            const agent = await agentDID.getAgent(addr1.address);
            expect(agent.isActive).to.be.false;
        });

        it("Should prevent non-owner from deactivating", async function () {
            await agentDID.connect(addr1).registerAgent(
                "did:agent:1",
                ethers.keccak256(ethers.toUtf8Bytes("secret")),
                "Type1"
            );

            await expect(
                agentDID.connect(addr2).setAgentActive(addr1.address, false)
            ).to.be.revertedWith("Not owner");
        });
    });
});
