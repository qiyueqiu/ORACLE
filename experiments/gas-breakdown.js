/**
 * experiments/gas-breakdown.js — M6 logScheduleCompact 的 gas 成分精确拆解
 *
 * 用增量法逐项测量:部署一组「探针合约」,每个只做 M6 的一部分操作,
 * 通过差分隔离出 calldata / ecrecover / keccak / SSTORE / event 各自的真实 gas。
 * 目标:精确定位 39,432 gas 里 24k(base+ecrecover) 之外的 15k 还能榨多少。
 *
 * 运行：npx hardhat run experiments/gas-breakdown.js
 */
const hre = require("hardhat");

async function main() {
  const ethers = hre.ethers;
  const [signer] = await ethers.getSigners();

  // 用 estimateGas 对各探针函数测量,差分隔离成分
  const Probe = await ethers.getContractFactory("GasProbe");
  const probe = await Probe.deploy(); await probe.waitForDeployment();

  const sampleSig = "0x" + "ab".repeat(65);
  const th = ethers.id("th"), rk = ethers.id("rk"), tc = ethers.id("tc");
  const ts = 1700000000;
  // 真实签名(让 ecrecover 成功)
  const domain = { name: "ORACLE AuditLog", version: "1", chainId: 31337n, verifyingContract: await probe.getAddress() };
  const DT = { Decision: [{ name: "taskHash", type: "bytes32" }, { name: "rankedAgents", type: "bytes32" }, { name: "topAgent", type: "address" }, { name: "timestamp", type: "uint256" }] };
  const realSig = await signer.signTypedData(domain, DT, { taskHash: th, rankedAgents: rk, topAgent: signer.address, timestamp: ts });

  const measure = async (name, fn) => {
    const g = await fn();
    console.log(`  ${name.padEnd(38)} ${Number(g).toLocaleString().padStart(8)} gas`);
    return Number(g);
  };

  console.log("\n===== M6 gas 成分增量拆解(estimateGas 差分)=====\n");
  const empty = await measure("p0_empty (仅 tx base + 空函数)", () => probe.p0_empty.estimateGas());
  const cd = await measure("p1_calldata (+读全部 calldata 参数)", () => probe.p1_calldata.estimateGas(signer.address, signer.address, tc, 0, th, rk, ts, realSig));
  const kc = await measure("p2_keccak (+_hashDecision 2x keccak)", () => probe.p2_keccak.estimateGas(signer.address, th, rk, ts));
  const ec = await measure("p3_ecrecover (+ecrecover)", () => probe.p3_ecrecover.estimateGas(th, rk, signer.address, ts, realSig));
  const ss = await measure("p4_sstore (+seqCounter++)", () => probe.p4_sstore.estimateGas());
  const evt = await measure("p5_event (+emit 7 字段)", () => probe.p5_event.estimateGas(signer.address, signer.address, tc, 0, th));

  console.log("\n  --- 差分隔离(近似)---");
  console.log(`  tx base:          ~${empty.toLocaleString()}`);
  console.log(`  calldata(全参数):  ~${(cd - empty).toLocaleString()}`);
  console.log(`  keccak x2:        ~${Math.max(0, kc - empty).toLocaleString()}`);
  console.log(`  ecrecover:        ~${Math.max(0, ec - empty).toLocaleString()}`);
  console.log(`  SSTORE seq:       ~${Math.max(0, ss - empty).toLocaleString()}`);
  console.log(`  event(7字段):      ~${Math.max(0, evt - empty).toLocaleString()}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
