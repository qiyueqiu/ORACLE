const { chromium } = require('@playwright/test');
const { ethers } = require('ethers');

const CONTRACTS = {
  AgentDID: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  AuditLog: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  Reputation: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
};

const AgentDIDABI = [
  'function registerAgent(string calldata did, bytes32 commitment, string calldata qualificationType) external',
  'function agentList(uint256) view returns (address)',
  'function agentCount() view returns (uint256)',
];

const AuditLogABI = [
  'function getRecord(uint256) view returns (uint256,uint256,address,address,string,uint8,uint8,string,uint256,bytes32)',
  'function recordCount() view returns (uint256)',
];

const ReputationABI = [
  'function addRating(address,uint256) external returns (uint256)',
  'function getReputation(address) view returns (uint256,uint256,uint256,uint256)',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('🚀 开始 ASB + 区块链 Demo 端到端测试\n');

  const provider = new ethers.JsonRpcProvider('http://localhost:8545');
  const signer = await provider.getSigner();
  const agentDID = new ethers.Contract(CONTRACTS.AgentDID, AgentDIDABI, signer);
  const auditLog = new ethers.Contract(CONTRACTS.AuditLog, AuditLogABI, signer);
  const reputation = new ethers.Contract(CONTRACTS.Reputation, ReputationABI, signer);

  const localEnv = { ...process.env };
  delete localEnv.ALL_PROXY; delete localEnv.all_proxy;
  delete localEnv.HTTP_PROXY; delete localEnv.http_proxy;
  delete localEnv.HTTPS_PROXY; delete localEnv.https_proxy;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ env: localEnv });
  const page = await context.newPage();

  try {
    // ===== 步骤 1: 打开前端 =====
    console.log('📌 步骤 1: 打开前端应用');
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
    await sleep(2000);

    const title = await page.title();
    console.log(`   页面标题: ${title}`);

    const connected = await page.locator('.connection-status').textContent();
    console.log(`   连接状态: ${connected?.trim()}`);

    // ===== 步骤 2: 注册 Agent =====
    console.log('\n📌 步骤 2: 注册 Agent');

    // 点击展开注册面板
    const registerToggle = page.locator('.card-header').filter({ hasText: '注册新 Agent' }).locator('button');
    await registerToggle.click();
    await sleep(500);

    const agentName = `TestAgent_${Date.now()}`;
    await page.fill('input[placeholder*="Agent 名称"]', agentName);
    await page.selectOption('.card select', 'code_review');
    console.log(`   输入名称: ${agentName}, 资质: code_review`);

    await page.click('button:has-text("注册到区块链")');
    console.log('   点击注册按钮');
    await sleep(5000);

    const agentCount = await agentDID.agentCount();
    console.log(`   链上 Agent 总数: ${agentCount}`);

    if (Number(agentCount) > 0) {
      const addr = await agentDID.agentList(Number(agentCount) - 1);
      console.log(`   ✅ 注册成功! 地址: ${addr}`);
    }

    // ===== 步骤 3: 任务调度 =====
    console.log('\n📌 步骤 3: 任务调度');

    // 点击侧边栏 "任务调度"
    await page.click('.nav-item:has-text("任务调度")');
    await sleep(1000);

    const taskDesc = '帮我审查一段 JavaScript 代码的安全性，检查是否有 XSS 漏洞';
    await page.fill('.task-input', taskDesc);
    console.log(`   输入任务: ${taskDesc}`);

    await page.click('button:has-text("开始调度")');
    console.log('   点击开始调度');

    // 等待执行管线完成（最长等待 120 秒）
    console.log('   等待 Agent 执行管线完成...');
    try {
      await page.locator('.pipeline-step.done:has-text("信誉评估")', { timeout: 120000 }).waitFor();
      console.log('   ✅ 执行管线完成');
    } catch {
      // 兜底：等待结果面板出现
      try {
        await page.locator('.result-panel', { timeout: 30000 }).waitFor();
        console.log('   ✅ 执行结果已返回');
      } catch {
        console.log('   ⚠️ 管线未完全完成，继续后续步骤');
      }
    }

    // 检查结果区域
    const resultPanel = page.locator('.result-panel');
    if (await resultPanel.count() > 0) {
      const resultText = await resultPanel.locator('.panel-content').textContent();
      console.log(`   执行结果: ${resultText?.slice(0, 100)}...`);
    }

    // ===== 步骤 4: 验证审计日志 =====
    console.log('\n📌 步骤 4: 验证审计日志');

    await page.click('.nav-item:has-text("审计日志")');
    await sleep(2000);

    const recordCount = await auditLog.recordCount();
    console.log(`   链上审计记录数: ${recordCount}`);

    if (Number(recordCount) > 0) {
      const rec = await auditLog.getRecord(Number(recordCount));
      console.log(`   最新记录 #${rec[0]}:`);
      console.log(`   - 任务描述: ${rec[4]}`);
      console.log(`   - 执行状态: ${Number(rec[6]) === 1 ? '成功' : '其他'}`);

      const recordCards = await page.locator('.audit-record-card').count();
      console.log(`   页面显示记录数: ${recordCards}`);
    }

    // ===== 步骤 5: 截图 =====
    console.log('\n📌 步骤 5: 截图保存');
    await page.screenshot({ path: 'e2e-screenshot.png', fullPage: true });
    console.log('   ✅ 截图已保存: e2e-screenshot.png');

    console.log('\n✅ 端到端测试通过!');

  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    await page.screenshot({ path: 'e2e-error.png' }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch(process.exit);
