const hre = require('hardhat');
const { ethers } = hre;

// 生成 DID
function generateDID(name) {
  return `did:asb:${name}`;
}

// 生成随机密钥
function generateSecret() {
  return ethers.hexlify(ethers.randomBytes(32));
}

// 哈希密钥
function hashSecret(secret) {
  return ethers.keccak256(secret);
}

// 生成 nullifier
function generateNullifier(did, secret) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['string', 'bytes32'],
    [did, secret]
  ));
}

// 生成 commitment
function generateCommitment(nullifier, secretHash) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32'],
    [nullifier, secretHash]
  ));
}

// 测试 Agent 配置
const TEST_AGENTS = [
  // Weather 类型 - 高信誉
  { name: 'WeatherPro-A', type: 'weather', ratings: [5, 5, 5, 5, 4] },
  { name: 'WeatherPro-B', type: 'weather', ratings: [5, 5, 4, 4, 4] },
  { name: 'WeatherBasic-C', type: 'weather', ratings: [3, 3, 4, 3, 3] },

  // Content 类型 - 混合信誉
  { name: 'ContentExpert-X', type: 'content', ratings: [5, 5, 5, 5, 5] },
  { name: 'ContentWriter-Y', type: 'content', ratings: [4, 4, 3, 4, 4] },
  { name: 'ContentNew-Z', type: 'content', ratings: [2, 3, 3, 2, 3] },

  // Calc 类型 - 不同信誉档次
  { name: 'CalcMaster-1', type: 'calc', ratings: [5, 5, 5, 5, 5] },
  { name: 'CalcSolver-2', type: 'calc', ratings: [4, 4, 4, 4, 5] },
  { name: 'CalcHelper-3', type: 'calc', ratings: [3, 3, 3, 3, 3] },
  { name: 'CalcBasic-4', type: 'calc', ratings: [2, 2, 2, 3, 2] },
];

async function main() {
  console.log('🚀 开始注册测试 Agents...\n');

  // 获取所有测试账户
  const signers = await ethers.getSigners();
  console.log(`可用账户数: ${signers.length}\n`);

  // 获取合约（使用第一个账户作为部署者）
  const agentDID = await ethers.getContractAt('AgentDID', '0x5FbDB2315678afecb367f032d93F642f64180aa3', signers[0]);
  const reputation = await ethers.getContractAt('Reputation', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', signers[0]);

  const results = [];

  for (let i = 0; i < TEST_AGENTS.length; i++) {
    const agent = TEST_AGENTS[i];

    // 使用不同的账户注册每个 Agent（跳过第0个账户，它是部署者）
    const signerIndex = (i % (signers.length - 1)) + 1;
    const signer = signers[signerIndex];

    try {
      console.log(`📝 注册: ${agent.name} (${agent.type})`);
      console.log(`   使用账户: ${signer.address}`);

      // 用对应 signer 连接合约
      const agentDIDConnected = agentDID.connect(signer);
      const reputationConnected = reputation.connect(signers[0]); // 用部署者评分

      // 生成 DID 和 commitment
      const did = generateDID(agent.name);
      const secret = generateSecret();
      const nullifier = generateNullifier(did, secret);
      const secretHash = hashSecret(secret);
      const commitment = generateCommitment(nullifier, secretHash);

      // 注册 Agent
      const tx = await agentDIDConnected.registerAgent(did, commitment, agent.type);
      const receipt = await tx.wait();

      // Agent 地址就是注册者的地址
      const agentAddress = signer.address;
      console.log(`   ✓ 注册成功: ${agentAddress}`);

      // 添加评分
      console.log(`   添加 ${agent.ratings.length} 个评分...`);
      for (const rating of agent.ratings) {
        const rateTx = await reputationConnected.addRating(agentAddress, rating);
        await rateTx.wait();
      }

      // 获取最终信誉
      const rep = await reputation.getReputation(agentAddress);
      const avgRep = Number(rep[2]);
      console.log(`   ✓ 最终信誉: ${avgRep.toFixed(1)} / 5.0 (${rep[1]} 个评分)\n`);

      results.push({
        name: agent.name,
        type: agent.type,
        address: agentAddress,
        did,
        avgReputation: avgRep,
        ratingCount: Number(rep[1])
      });

      // 延迟避免 nonce 问题
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      console.error(`   ✗ 失败: ${error.message}\n`);
    }
  }

  // 打印摘要
  console.log('\n' + '='.repeat(60));
  console.log('📊 注册摘要');
  console.log('='.repeat(60));

  const byType = {};
  for (const r of results) {
    if (!byType[r.type]) byType[r.type] = [];
    byType[r.type].push(r);
  }

  for (const [type, agents] of Object.entries(byType)) {
    console.log(`\n${type.toUpperCase()} 类型:`);
    agents.sort((a, b) => b.avgReputation - a.avgReputation);
    for (const a of agents) {
      console.log(`  ${a.name.padEnd(20)} 信誉: ${String(a.avgReputation.toFixed(1)).padStart(4)} ⭐`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`✅ 成功注册 ${results.length} 个 Agent!`);

  // 保存到文件供后续使用
  const fs = require('fs');
  fs.writeFileSync(
    './test/test-agents.json',
    JSON.stringify(results, null, 2)
  );
  console.log('📄 Agent 信息已保存到 test-agents.json');
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
