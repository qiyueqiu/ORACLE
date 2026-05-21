const hre = require('hardhat');
const { ethers } = hre;

function generateDID(name) {
  return `did:asb:${name}`;
}

function generateSecret() {
  return ethers.hexlify(ethers.randomBytes(32));
}

function hashSecret(secret) {
  return ethers.keccak256(secret);
}

function generateNullifier(did, secret) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['string', 'bytes32'],
    [did, secret]
  ));
}

function generateCommitment(nullifier, secretHash) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32'],
    [nullifier, secretHash]
  ));
}

const TEST_AGENTS = [
  { name: 'CodeReviewer-Pro', type: 'code_review', ratings: [92, 95, 88, 90, 94] },
  { name: 'CodeReviewer-Junior', type: 'code_review', ratings: [62, 70, 65, 58, 68] },
  { name: 'SecurityScanner', type: 'code_review', ratings: [90, 88, 93, 85, 91] },

  { name: 'DataAnalyst-Expert', type: 'data_analysis', ratings: [95, 92, 88, 90, 93] },
  { name: 'DataAnalyst-Mid', type: 'data_analysis', ratings: [72, 65, 70, 68, 60] },
  { name: 'DataViz-Specialist', type: 'data_analysis', ratings: [85, 88, 82, 86, 84] },

  { name: 'Translator-Pro', type: 'translation', ratings: [93, 90, 88, 92, 91] },
  { name: 'Translator-Multi', type: 'translation', ratings: [75, 70, 72, 68, 73] },

  { name: 'Researcher-Deep', type: 'research', ratings: [94, 91, 89, 92, 90] },
  { name: 'Researcher-General', type: 'research', ratings: [60, 65, 58, 62, 55] },

  { name: 'CreativeWriter-Pro', type: 'creative', ratings: [91, 88, 93, 90, 87] },
  { name: 'CopyWriter-Junior', type: 'creative', ratings: [55, 50, 48, 52, 45] },

  { name: 'WeatherPro-A', type: 'weather', ratings: [88, 85, 90, 87, 83] },
  { name: 'WeatherBasic-B', type: 'weather', ratings: [60, 55, 58, 52, 57] },

  { name: 'ContentExpert-X', type: 'content', ratings: [92, 89, 86, 90, 88] },
  { name: 'ContentWriter-Y', type: 'content', ratings: [70, 65, 72, 60, 68] },

  { name: 'CalcMaster-1', type: 'calc', ratings: [95, 92, 90, 93, 88] },
  { name: 'CalcHelper-3', type: 'calc', ratings: [40, 45, 38, 42, 35] },
];

async function main() {
  console.log('🚀 开始注册测试 Agents...\n');

  const signers = await ethers.getSigners();
  console.log(`可用账户数: ${signers.length}\n`);

  const agentDID = await ethers.getContractAt('AgentDID', '0x5FbDB2315678afecb367f032d93F642f64180aa3', signers[0]);
  const reputation = await ethers.getContractAt('Reputation', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', signers[0]);

  const results = [];

  for (let i = 0; i < TEST_AGENTS.length; i++) {
    const agent = TEST_AGENTS[i];
    const signerIndex = (i % (signers.length - 1)) + 1;
    const signer = signers[signerIndex];

    try {
      console.log(`📝 注册: ${agent.name} (${agent.type})`);

      const agentDIDConnected = agentDID.connect(signer);
      const reputationConnected = reputation.connect(signers[0]);

      const did = generateDID(agent.name);
      const secret = generateSecret();
      const nullifier = generateNullifier(did, secret);
      const secretHash = hashSecret(secret);
      const commitment = generateCommitment(nullifier, secretHash);

      const tx = await agentDIDConnected.registerAgent(did, commitment, agent.type);
      await tx.wait();

      const agentAddress = signer.address;
      console.log(`   ✓ 注册成功: ${agentAddress}`);

      for (const rating of agent.ratings) {
        const rateTx = await reputationConnected.addRating(agentAddress, rating);
        await rateTx.wait();
      }

      const rep = await reputation.getReputation(agentAddress);
      const avgRep = Number(rep[2]);
      console.log(`   ✓ 最终信誉: ${avgRep}/100 (${rep[1]} 次评分)\n`);

      results.push({
        name: agent.name,
        type: agent.type,
        address: agentAddress,
        did,
        avgReputation: avgRep,
        ratingCount: Number(rep[1])
      });

      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error) {
      console.error(`   ✗ 失败: ${error.message}\n`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 注册摘要 (百分制)');
  console.log('='.repeat(60));

  const byType = {};
  for (const r of results) {
    if (!byType[r.type]) byType[r.type] = [];
    byType[r.type].push(r);
  }

  for (const [type, agents] of Object.entries(byType)) {
    console.log(`\n${type.toUpperCase()}:`);
    agents.sort((a, b) => b.avgReputation - a.avgReputation);
    for (const a of agents) {
      const level = a.avgReputation >= 80 ? '🌟' : a.avgReputation >= 60 ? '✅' : '⚠️';
      console.log(`  ${a.name.padEnd(22)} 信誉: ${String(a.avgReputation).padStart(3)}/100 ${level}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`✅ 成功注册 ${results.length} 个 Agent!`);

  const fs = require('fs');
  fs.writeFileSync('./test/test-agents.json', JSON.stringify(results, null, 2));
  console.log('📄 Agent 信息已保存到 test-agents.json');
}

main()
  .then(() => process.exit(0))
  .catch(error => { console.error(error); process.exit(1); });
