const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * ORACLE 合约部署脚本（M2 N8：多网络）
 *
 * 部署：AgentDID / AuditLog / Reputation / AgentStake / PaymentEscrow / MockERC20
 * 关联：AuditLog.setAgentDID；AgentStake & PaymentEscrow.setAuditLog
 * 持久化：写入 frontend/src/contracts/addresses.json + deployments/<network>.json
 */
async function main() {
    const network = hre.network.name;
    console.log(`🚀 Deploying ORACLE contracts to network: ${network}`);

    const [deployer] = await hre.ethers.getSigners();
    console.log(`Deployer: ${await deployer.getAddress()}`);

    // 1. MockERC20（仅在非生产网络部署）
    let tokenAddress = hre.ethers.ZeroAddress;
    if (network === "hardhat" || network === "localhost" || network === "baseSepolia" || network === "sepolia" || network === "polygonAmoy") {
        const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
        const token = await MockERC20.deploy();
        await token.waitForDeployment();
        tokenAddress = await token.getAddress();
        console.log(`1. MockERC20: ${tokenAddress}`);
    }

    // 2. AgentDID
    const AgentDID = await hre.ethers.getContractFactory("AgentDID");
    const agentDID = await AgentDID.deploy();
    await agentDID.waitForDeployment();
    const agentDIDAddress = await agentDID.getAddress();
    console.log(`2. AgentDID: ${agentDIDAddress}`);

    // 3. AuditLog
    const AuditLog = await hre.ethers.getContractFactory("AuditLog");
    const auditLog = await AuditLog.deploy();
    await auditLog.waitForDeployment();
    const auditLogAddress = await auditLog.getAddress();
    console.log(`3. AuditLog: ${auditLogAddress}`);

    // 3b. AuditLogOptimized（成本优化版：event-only + M5 编码归属，~85k gas/dispatch，省 ~79%）
    //     api-server 设 AUDIT_MODE=optimized 时写入此合约。代表成本--可验证性帕累托前沿
    //     上「低成本审计」一端，供部署者按需选点。
    const AuditLogOptimized = await hre.ethers.getContractFactory("AuditLogOptimized");
    const auditLogOptimized = await AuditLogOptimized.deploy();
    await auditLogOptimized.waitForDeployment();
    const auditLogOptimizedAddress = await auditLogOptimized.getAddress();
    console.log(`3b. AuditLogOptimized: ${auditLogOptimizedAddress}`);

    // 4. Reputation
    const Reputation = await hre.ethers.getContractFactory("Reputation");
    const reputation = await Reputation.deploy();
    await reputation.waitForDeployment();
    const reputationAddress = await reputation.getAddress();
    console.log(`4. Reputation: ${reputationAddress}`);

    // 5. AgentStake (需要 token)
    let stakeAddress = hre.ethers.ZeroAddress;
    if (tokenAddress !== hre.ethers.ZeroAddress) {
        const AgentStake = await hre.ethers.getContractFactory("AgentStake");
        const stake = await AgentStake.deploy(tokenAddress);
        await stake.waitForDeployment();
        stakeAddress = await stake.getAddress();
        console.log(`5. AgentStake: ${stakeAddress}`);
    }

    // 6. PaymentEscrow
    let escrowAddress = hre.ethers.ZeroAddress;
    if (tokenAddress !== hre.ethers.ZeroAddress) {
        const PaymentEscrow = await hre.ethers.getContractFactory("PaymentEscrow");
        const escrow = await PaymentEscrow.deploy(tokenAddress);
        await escrow.waitForDeployment();
        escrowAddress = await escrow.getAddress();
        console.log(`6. PaymentEscrow: ${escrowAddress}`);
    }

    // 7. 关联：AuditLog <-> AgentDID
    console.log("\n🔗 Linking contracts...");
    let tx = await auditLog.setAgentDID(agentDIDAddress);
    await tx.wait();
    console.log("   AuditLog.setAgentDID ✓");

    // 7b. 关联：AuditLogOptimized <-> AgentDID（M5 执行阶段验 worker pubKey 需要）
    tx = await auditLogOptimized.setAgentDID(agentDIDAddress);
    await tx.wait();
    console.log("   AuditLogOptimized.setAgentDID ✓");

    // 8. 关联：AgentStake & PaymentEscrow <-> AuditLog
    if (stakeAddress !== hre.ethers.ZeroAddress) {
        const AgentStake = await hre.ethers.getContractFactory("AgentStake");
        const stake = AgentStake.attach(stakeAddress);
        tx = await stake.setAuditLog(auditLogAddress);
        await tx.wait();
        console.log("   AgentStake.setAuditLog ✓");
    }
    if (escrowAddress !== hre.ethers.ZeroAddress) {
        const PaymentEscrow = await hre.ethers.getContractFactory("PaymentEscrow");
        const escrow = PaymentEscrow.attach(escrowAddress);
        tx = await escrow.setAuditLog(auditLogAddress);
        await tx.wait();
        console.log("   PaymentEscrow.setAuditLog ✓");
    }

    // 9. 持久化
    const chainId = (await hre.ethers.provider.getNetwork()).chainId.toString();
    const addresses = {
        AgentDID: agentDIDAddress,
        AuditLog: auditLogAddress,
        AuditLogOptimized: auditLogOptimizedAddress,
        Reputation: reputationAddress,
        AgentStake: stakeAddress,
        PaymentEscrow: escrowAddress,
        MockERC20: tokenAddress,
    };

    // 写 frontend/src/contracts/addresses.json（前端读）
    const frontendConfig = {
        chainId,
        contracts: {
            AgentDID: agentDIDAddress,
            AuditLog: auditLogAddress,
            Reputation: reputationAddress,
        },
    };
    const configDir = path.join(__dirname, "..", "frontend", "src", "contracts");
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, "addresses.json"),
        JSON.stringify(frontendConfig, null, 2)
    );
    console.log(`\n💾 Frontend config: ${path.join(configDir, "addresses.json")}`);

    // 写 deployments/<network>.json（多网络历史）
    const deployDir = path.join(__dirname, "..", "deployments");
    if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir, { recursive: true });
    fs.writeFileSync(
        path.join(deployDir, `${network}.json`),
        JSON.stringify({ chainId, network, addresses, deployedAt: new Date().toISOString() }, null, 2)
    );
    console.log(`💾 Deployment history: ${path.join(deployDir, `${network}.json`)}`);

    console.log("\n✅ Deployment complete!\n");
    return addresses;
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
