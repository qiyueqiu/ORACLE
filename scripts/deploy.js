const hre = require("hardhat");

async function main() {
  console.log("Deploying ASB Blockchain contracts...");

  // Deploy AgentDID
  console.log("\n1. Deploying AgentDID...");
  const AgentDID = await hre.ethers.getContractFactory("AgentDID");
  const agentDID = await AgentDID.deploy();
  await agentDID.waitForDeployment();
  const agentDIDAddress = await agentDID.getAddress();
  console.log("   AgentDID deployed to:", agentDIDAddress);

  // Deploy AuditLog
  console.log("\n2. Deploying AuditLog...");
  const AuditLog = await hre.ethers.getContractFactory("AuditLog");
  const auditLog = await AuditLog.deploy();
  await auditLog.waitForDeployment();
  const auditLogAddress = await auditLog.getAddress();
  console.log("   AuditLog deployed to:", auditLogAddress);

  // Deploy Reputation
  console.log("\n3. Deploying Reputation...");
  const Reputation = await hre.ethers.getContractFactory("Reputation");
  const reputation = await Reputation.deploy();
  await reputation.waitForDeployment();
  const reputationAddress = await reputation.getAddress();
  console.log("   Reputation deployed to:", reputationAddress);

  console.log("\n=== Deployment Complete ===");
  console.log("\nContract Addresses:");
  console.log("AgentDID:", agentDIDAddress);
  console.log("AuditLog:", auditLogAddress);
  console.log("Reputation:", reputationAddress);

  // Save to frontend config
  const fs = require("fs");
  const path = require("path");
  const configDir = path.join(__dirname, "..", "frontend", "src", "contracts");
  const configFile = path.join(configDir, "addresses.json");

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const config = {
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    contracts: {
      AgentDID: agentDIDAddress,
      AuditLog: auditLogAddress,
      Reputation: reputationAddress
    }
  };

  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  console.log("\nFrontend config saved to:", configFile);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
