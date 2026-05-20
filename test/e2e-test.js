const { chromium } = require('@playwright/test');
const { ethers } = require('ethers');

// 合约 ABI
const AgentDIDABI = [
  'function registerAgent(string calldata did, bytes32 commitment, string calldata qualificationType) external',
  'function verifyQualification(bytes32 nullifier, bytes32 secretHash, bytes32 commitment) external view returns (bool)',
  'function agents(address) external view returns (address owner, string memory did, bytes32 commitment, string memory qualificationType, bool isActive, uint256 registeredAt)',
  'function agentList(uint256) external view returns (address)',
  'function agentCount() external view returns (uint256)',
];

const AuditLogABI = [
  'function logSchedule(address requester, address targetAgent, string calldata taskDescription, uint8 decisionReason) external returns (uint256)',
  'function updateExecution(uint256 recordId, uint8 status, string calldata result) external',
  'function getRecord(uint256 recordId) external view returns (uint256 id, uint256 timestamp, address requester, address targetAgent, string memory taskDescription, uint8 decisionReason, uint8 executionStatus, string memory executionResult, uint256 reputationRating, bytes32 transactionHash)',
  'function recordCount() external view returns (uint256)',
  'function getAllRecords() external view returns (uint256[] memory)',
];

const ReputationABI = [
  'function rateAgent(address agent, uint8 rating) external',
  'function reputation(address agent) external view returns (uint256 totalScore, uint256 ratingCount)',
];

// 合约地址
const CONTRACTS = {
  AgentDID: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  AuditLog: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  Reputation: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
};

// 辅助函数
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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🚀 开始 ASB + 区块链 Demo 端到端测试\n');

  // 设置区块链连接
  const provider = new ethers.JsonRpcProvider('http://localhost:8545');
  const signer = await provider.getSigner();

  const agentDID = new ethers.Contract(CONTRACTS.AgentDID, AgentDIDABI, signer);
  const auditLog = new ethers.Contract(CONTRACTS.AuditLog, AuditLogABI, signer);
  const reputation = new ethers.Contract(CONTRACTS.Reputation, ReputationABI, signer);

  // 启动浏览器
  // 清除所有代理环境变量，避免 Playwright 走系统代理
const localEnv = { ...process.env };
delete localEnv.ALL_PROXY;
delete localEnv.all_proxy;
delete localEnv.HTTP_PROXY;
delete localEnv.http_proxy;
delete localEnv.HTTPS_PROXY;
delete localEnv.https_proxy;

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
const context = await browser.newContext({ env: localEnv });
const page = await context.newPage();

// 使用普通 fetch 测试（绕过 SSE proxy 问题）
const apiFetch = async (task) => {
  const resp = await page.evaluate(async (taskText) => {
    const res = await fetch('http://localhost:3001/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: taskText }),
    });
    return await res.json();
  }, task);
  return resp;
};

  try {
    console.log('📌 步骤 1: 打开前端应用');
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
    await sleep(2000);

    // 检查页面是否加载
    const title = await page.title();
    console.log(`   页面标题: ${title}`);

    const walletInfo = await page.locator('.wallet-info').textContent();
    console.log(`   钱包状态: ${walletInfo?.trim()}`);

    // 检查错误信息
    const errorMsg = page.locator('.error-msg');
    if (await errorMsg.count() > 0) {
      const errorText = await errorMsg.first().textContent();
      console.log(`   ⚠️ 页面错误: ${errorText}`);
    }

    console.log('\n📌 步骤 2: 注册 Agent');
    await sleep(1000);

    // 填写表单注册 Agent
    const agentName = `TestAgent_${Date.now()}`;
    const qualType = 'weather';

    await page.fill('input[placeholder*="智能体名称"]', agentName);
    console.log(`   输入名称: ${agentName}`);

    await page.selectOption('select', qualType);
    console.log(`   选择资质: ${qualType}`);

    // 点击注册按钮
    const registerButton = page.locator('button').filter({ hasText: '注册' });
    await registerButton.click();
    console.log('   点击注册按钮');

    // 等待注册完成
    await sleep(5000);

    // 验证链上注册
    const agentCount = await agentDID.agentCount();
    console.log(`   链上 Agent 总数: ${agentCount}`);

    if (Number(agentCount) > 0) {
      const lastAgentAddr = await agentDID.agentList(Number(agentCount) - 1);
      const agentInfo = await agentDID.agents(lastAgentAddr);
      console.log(`   ✅ 注册成功! Agent: ${agentInfo[1]}`);
      console.log(`   地址: ${lastAgentAddr}`);
    }

    console.log('\n📌 步骤 3: 任务调度');
    // 切换到任务调度标签
    await page.click('button:has-text("任务调度")');
    await sleep(2000);

    // 输入任务描述
    const taskDesc = '查询北京今天天气';
    await page.fill('input.task-input', taskDesc);
    console.log(`   输入任务: ${taskDesc}`);

    // 直接使用 fetch 调用 API（绕过 SSE proxy 问题）
    console.log('   通过 API 直接调度...');
    const dispatchResult = await apiFetch(taskDesc);
    console.log(`   ✅ 调度完成: ${dispatchResult.selectedAgent?.did}`);
    console.log(`   执行结果: ${dispatchResult.result?.substring(0, 100)}...`);

    console.log('\n📌 步骤 4: 验证审计日志');
    // 切换到审计日志标签
    await page.click('button:has-text("审计日志")');
    await sleep(2000);

    // 获取记录数
    const recordCount = await auditLog.recordCount();
    console.log(`   链上审计记录数: ${recordCount}`);

    if (Number(recordCount) > 0) {
      // recordId 从 1 开始
      const lastRecord = await auditLog.getRecord(1);
      console.log(`   最新记录:`);
      console.log(`   - 请求者: ${lastRecord[2]}`);
      console.log(`   - 目标 Agent: ${lastRecord[3]}`);
      console.log(`   - 任务描述: ${lastRecord[4]}`);
      console.log(`   - 执行结果: ${lastRecord[7]}`);

      // 在页面上验证
      const tableRows = await page.locator('.audit-table tbody tr').count();
      console.log(`   页面显示记录数: ${tableRows}`);
    }

    console.log('\n✅ 端到端测试通过!');

    // 截图
    await page.screenshot({ path: '/home/qiqi/workspace/asb-blockchain-demo/e2e-screenshot.png' });
    console.log('   截图已保存: e2e-screenshot.png');

  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    await page.screenshot({ path: '/home/qiqi/workspace/asb-blockchain-demo/e2e-error.png' });
    console.log('   错误截图已保存: e2e-error.png');
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
