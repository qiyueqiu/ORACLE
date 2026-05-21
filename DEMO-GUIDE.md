# ASB + Blockchain Demo — 演示指南

## 一键运行端到端演示

```bash
cd /home/qiqi/workspace/asb-blockchain-demo
bash start-and-test.sh
```

这会自动：启动 Hardhat → 部署合约 → 注册 18 个测试 Agent → 启动 API → 启动前端 → 打开有头浏览器执行完整测试。

## 分步手动演示

如果你想分步操作（比如手动在前端交互），可以：

### 1. 启动服务

```bash
cd /home/qiqi/workspace/asb-blockchain-demo

# 终端 1: 启动区块链节点
npx hardhat node

# 终端 2: 部署合约 + 注册 Agent
npx hardhat run scripts/deploy.js --network localhost
npx hardhat run test/setup-test-agents.js --network localhost

# 终端 3: 启动 API Server
cd agents && node api-server.js

# 终端 4: 启动前端
cd frontend && npx vite --host
```

### 2. 访问前端

浏览器打开 http://localhost:5173

### 3. 运行有头浏览器自动测试

```bash
# 确保所有服务已运行
node e2e-test.js
```

这会打开一个 Chrome 浏览器窗口，自动执行：
- Dashboard 查看 Agent 列表
- 注册新 Agent
- 两次完整任务调度（代码审查 + 数据分析）
- 查看审计日志
- 查看信誉分析排行

测试完成后截图保存在 `e2e-screenshots/` 目录。

## 服务端口

| 服务 | 端口 | 说明 |
|------|------|------|
| Hardhat 节点 | 8545 | 本地以太坊测试网 |
| API Server | 3001 | Agent 调度 + 信誉分析 |
| Frontend | 5173 | React 前端界面 |

## 常见问题

**端口被占用？**
```bash
# 清理所有服务端口
for port in 8545 3001 5173; do
  lsof -t -i :$port 2>/dev/null | xargs kill 2>/dev/null
done
```

**LLM 响应慢？** 调度流程涉及 4-5 次 LLM API 调用，单次调度可能需要 1-3 分钟。这是正常现象。

**想修改测试任务？** 编辑 `e2e-test.js` 中步骤 4 和步骤 5 的 `task` 变量。
