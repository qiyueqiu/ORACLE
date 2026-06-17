/**
 * Sepolia 部署前只读连通性检查（零 gas）。
 * 运行：npx hardhat run scripts/preflight.js --network sepolia
 */
const hre = require("hardhat");
async function main() {
  const ethers = hre.ethers;
  const net = await ethers.provider.getNetwork();
  console.log("网络:", hre.network.name, "| chainId:", net.chainId.toString());
  const signers = await ethers.getSigners();
  console.log("可用签名账户数:", signers.length);
  if (signers.length === 0) { console.log("❌ 无签名账户 — 私钥未接入 hardhat.config"); return; }
  const addr = signers[0].address;
  const bal = await ethers.provider.getBalance(addr);
  console.log("部署账户:", addr);
  console.log("余额:", ethers.formatEther(bal), "ETH");
  const fee = await ethers.provider.getFeeData();
  console.log("当前 gasPrice:", ethers.formatUnits(fee.gasPrice || 0n, "gwei"), "gwei");
  const ok = Number(net.chainId) === 11155111 && bal > ethers.parseEther("0.05");
  console.log(ok ? "✅ 链连通 + 余额充足，可部署" : "⚠️ 检查 chainId/余额");
}
main().then(() => process.exit(0)).catch((e) => { console.error("❌", e.message); process.exit(1); });
