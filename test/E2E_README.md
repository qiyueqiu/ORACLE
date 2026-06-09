# E2E 测试运行说明

E2E 测试需要**三个本地服务**同时运行。由于启动开销大，**不在 CI 中自动跑**；需要手动：

## 前置

1. Hardhat 节点（:8545）
2. API Server（:3001）
3. Vite 前端（:5173）

## 启动方式

### 方式 1：使用项目自带的 `start-and-test.sh`

```bash
cd /home/qiqi/workspace/oracle
./start-and-test.sh
```

### 方式 2：手动启动 3 个 terminal

**Terminal 1**:
```bash
npx hardhat node
```

**Terminal 2**:
```bash
node agents/api-server.js
```

**Terminal 3**:
```bash
cd frontend && npm run dev
```

**Terminal 4**（运行测试）:
```bash
cd /home/qiqi/workspace/oracle
node test/e2e-test.js
```

## 场景覆盖

E2E 共 5 个场景：

| # | 场景 | 说明 |
|---|---|---|
| 1 | 注册 → 调度 → 审计 | 完整主流程 |
| 2 | 信誉页加载 | 验证 UI 渲染 |
| 3 | 空任务错误路径 | 验证前端校验 |
| 4 | Tab 切换 | 验证导航 |
| 5 | Dashboard 截图 | 视觉回归 |

## 输出

- 控制台：每个场景 ✅/❌
- `e2e-screenshot.png`：Dashboard 截图
- `e2e-error.png`：失败时自动保存

## 注意

- 跑前需要 `npx hardhat run scripts/deploy.js --network localhost` 部署合约
- 需要 `agents/.env` 配置文件含 `SILICONFLOW_API_KEY`（否则场景 1 失败）
- 总耗时约 1-2 分钟
