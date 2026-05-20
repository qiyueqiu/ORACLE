# ASB + Blockchain Demo

ASB（Agent Service Bus）与区块链结合的 demo，聚焦**信任机制**和**审计追溯**。

## 技术栈

- **前端**：TypeScript + React + Vite + ethers.js v6
- **区块链**：Hardhat + Solidity（本地网络 localhost:8545）
- **架构**：信任机制（ZKP 模拟）+ 审计追溯（链上日志）+ 信誉系统

## 项目结构

```
asb-blockchain-demo/
├── contracts/           # Solidity 智能合约
│   ├── AgentDID.sol     # Agent 去中心化身份 + 资质验证
│   ├── AuditLog.sol     # 调度决策审计追溯
│   └── Reputation.sol  # 链上信誉分管理
├── frontend/           # React 前端
│   └── src/
│       ├── contracts/abis.ts   # 合约 ABI 绑定
│       ├── utils/did.ts        # DID / 资质承诺工具
│       ├── pages/
│       │   ├── Dashboard.tsx  # Agent 注册 + 状态展示
│       │   ├── Dispatch.tsx    # 任务调度追踪
│       │   └── AuditLog.tsx   # 审计日志查询
│       └── App.tsx            # Tab 路由
├── scripts/deploy.js   # 合约部署脚本
└── test/              # Hardhat 测试用例
```

## 快速开始

### 1. 启动 Hardhat 本地网络

```bash
cd asb-blockchain-demo
npm install
npx hardhat node
```

### 2. 部署合约

新开终端：

```bash
cd asb-blockchain-demo
npx hardhat run scripts/deploy.js --network localhost
```

### 3. 启动前端

```bash
cd asb-blockchain-demo/frontend
npm install
npm run dev
```

打开 http://localhost:5173

## 端到端流程

1. **Dashboard** → 注册 3 个 Agent（DID + 资质承诺）
2. **Task Dispatch** → 发起任务，Router Agent 链上验证资质 + 信誉
3. **Audit Log** → 查看完整调度链路（transactionHash 可复制）

## 核心机制

### 信任机制（AgentDID）

- 注册时：生成 DID + 资质承诺 `commitment = keccak256(abi.encodePacked(nullifier, secretHash))`
- 验证时：提交 nullifier + secretHash，合约验证 `keccak256(abi.encodePacked(nullifier, secretHash)) == commitment`
- 模拟 ZKP：资质"承诺-证明"模式，nullifier 防止重复使用，不上链真实零知识证明

### 审计追溯（AuditLog）

- 所有调度决策上链：`timestamp、requester、targetAgent、decisionReason、executionResult`
- 支持时间范围查询
- transactionHash 可验证完整链路

### 信誉系统（Reputation）

- 任务完成后调用方评分（1-5）
- Router 调度决策查询链上信誉分作为参考
- 信誉低于阈值降权或拒绝

## 测试

```bash
npx hardhat test
```

覆盖：注册、验证、调度、评分 四个核心路径。
