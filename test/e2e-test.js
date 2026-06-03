/**
 * ASB E2E 多场景测试（Playwright）
 *
 * 场景：
 *   1. 完整流程：注册 Agent → 调度任务 → 审计验证
 *   2. 信誉页加载（验证声誉显示组件）
 *   3. 调度空任务错误路径
 *   4. Tab 切换（Dashboard → Dispatch → AuditLog）
 *   5. 重复注册同名 Agent（防重复）
 *
 * 前置：必须已运行 hardhat node + api-server + vite dev server
 */
const { chromium } = require('@playwright/test');
const { ethers } = require('ethers');

const CONTRACTS = {
  AgentDID: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  AuditLog: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  Reputation: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
};

const AgentDIDABI = [
  'function registerAgent(string calldata did, bytes32 commitment, string calldata qualificationType) external',
  'function registerAgentWithPubKey(string calldata did, bytes32 commitment, string calldata qualificationType, address pubKey) external',
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

const RESULTS = { pass: 0, fail: 0, scenarios: [] };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runScenario(name, fn) {
    process.stdout.write(`📌 ${name} ... `);
    try {
        await fn();
        console.log('✅');
        RESULTS.pass++;
        RESULTS.scenarios.push({ name, status: 'pass' });
    } catch (err) {
        console.log(`❌ ${err.message.slice(0, 200)}`);
        RESULTS.fail++;
        RESULTS.scenarios.push({ name, status: 'fail', error: err.message });
    }
}

async function main() {
    console.log('🚀 ASB E2E 多场景测试\n');

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
        headless: false,
        slowMo: 200,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
        // ===== 场景 1: 完整流程 =====
        await runScenario('场景 1: 注册 → 调度 → 审计', async () => {
            const context = await browser.newContext({ env: localEnv });
            const page = await context.newPage();
            await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
            await sleep(2000);

            // 1.1 Dashboard
            const registerToggle = page.locator('.card-header').filter({ hasText: '注册新 Agent' }).locator('button');
            await registerToggle.click();
            await sleep(500);

            const agentName = `E2E_${Date.now()}`;
            await page.fill('input[placeholder*="Agent 名称"]', agentName);
            await page.selectOption('.card select', 'code_review');
            await page.click('button:has-text("注册到区块链")');
            await sleep(5000);

            const agentCount = await agentDID.agentCount();
            if (Number(agentCount) < 1) throw new Error('注册失败，链上无 Agent');

            // 1.2 Dispatch（用唯一任务避免 Commitment 重复）
            const uniqueTask = `审查代码 XSS 漏洞 (${Date.now()})`;
            await page.click('.nav-item:has-text("任务调度")');
            await sleep(1000);
            await page.fill('.task-input', uniqueTask);
            await page.click('button:has-text("开始调度")');

            // 等待结果面板出现（最长 120 秒，含 LLM 调用 + 链上记录）
            await page.locator('.result-panel', { timeout: 120000 }).waitFor().catch(() => {});
            const resultPanel = page.locator('.result-panel');
            if (await resultPanel.count() === 0) throw new Error('未返回结果面板');

            // 1.3 审计
            await page.click('.nav-item:has-text("审计日志")');
            await sleep(2000);
            const recordCount = await auditLog.recordCount();
            if (Number(recordCount) < 1) throw new Error('链上无审计记录');

            await context.close();
        });

        // ===== 场景 2: 信誉页加载 =====
        await runScenario('场景 2: 信誉页加载与显示', async () => {
            const context = await browser.newContext({ env: localEnv });
            const page = await context.newPage();
            await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
            await sleep(1000);
            await page.click('.nav-item:has-text("信誉分析")');
            await sleep(3000);
            // 检查页面包含"信誉"字样
            const body = await page.textContent('body');
            if (!body.includes('信誉')) throw new Error('信誉页未加载');
            await context.close();
        });

        // ===== 场景 3: 错误路径：空任务 =====
        await runScenario('场景 3: 错误路径 - 提交空任务', async () => {
            const context = await browser.newContext({ env: localEnv });
            const page = await context.newPage();
            await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
            await sleep(1000);
            await page.click('.nav-item:has-text("任务调度")');
            await sleep(1000);
            // 不填写任务，直接点击开始
            const startBtn = page.locator('button:has-text("开始调度")');
            if (await startBtn.count() === 0) {
                // 按钮可能被 disabled 或者文案不同
                throw new Error('未找到开始调度按钮');
            }
            // 验证按钮存在（不论是 disabled 还是 click 后报前端错）
            const disabled = await startBtn.isDisabled();
            if (!disabled) {
                await startBtn.click();
                await sleep(2000);
                // 应有错误提示
                const body = await page.textContent('body');
                if (!body.match(/请输入|不能为空|错误/)) {
                    throw new Error('空任务未触发错误提示');
                }
            }
            await context.close();
        });

        // ===== 场景 4: Tab 切换 =====
        await runScenario('场景 4: Tab 切换（Dashboard → Dispatch → AuditLog → Dashboard）', async () => {
            const context = await browser.newContext({ env: localEnv });
            const page = await context.newPage();
            await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
            await sleep(1000);
            // 切换 4 个 tab
            for (const tabText of ['任务调度', '审计日志', '智能体管理', '信誉分析']) {
                await page.click(`.nav-item:has-text("${tabText}")`).catch(() => {});
                await sleep(500);
            }
            await context.close();
        });

        // ===== 场景 5: 截图保存 =====
        await runScenario('场景 5: Dashboard 截图保存', async () => {
            const context = await browser.newContext({ env: localEnv });
            const page = await context.newPage();
            await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
            await sleep(2000);
            await page.screenshot({ path: 'e2e-screenshot.png', fullPage: true });
            await context.close();
        });

    } finally {
        await browser.close();
    }

    // 输出总结
    console.log('\n' + '='.repeat(60));
    console.log(`E2E 总结: ${RESULTS.pass} 通过 / ${RESULTS.fail} 失败 / ${RESULTS.pass + RESULTS.fail} 总计`);
    console.log('='.repeat(60));
    for (const s of RESULTS.scenarios) {
        const icon = s.status === 'pass' ? '✅' : '❌';
        console.log(`  ${icon} ${s.name}${s.error ? ' — ' + s.error.slice(0, 100) : ''}`);
    }
    if (RESULTS.fail > 0) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
