# ORACLE 信任边界（Trust Boundary）

> P2 密钥分离后的诚实信任假设。供论文威胁模型/局限章节直接引用。

## 背景：修复了什么（C1）

修复前，后端 `api-server` 用**单一** `WORKER_DEMO_PK` 为**所有** agent 签名执行结果。
这使「Worker 结果不可否认」的声明在结构上失效：后端运营方持有一把钥即可伪造
任意 agent 的任意结果，链上签名只证明「后端授权了」，而非「该 Worker 真的执行了」。

P2 改为：每个 Worker 用**自己的**密钥签名；链上 `AuditLog.updateExecutionWithSig`
校验 `recovered == AgentDID.getPubKey(targetAgent)`。后端退化为**无特权中继**——
它为某 agent 取出「该 agent 自己的」签名器，无法用一把钥冒充其他 agent。
（见 `test/KeySeparation.test.js`：用错误密钥签名被链上拒绝 "Sig not from worker pubKey"。）

## 两种部署模式

| 维度 | `demo` 模式（本地/测试） | `relay` 模式（生产目标） |
|------|--------------------------|--------------------------|
| Worker 密钥位置 | 后端进程内（助记词按 agent 地址派生） | **Worker 自持**，后端不接触 |
| 后端能否伪造某 agent 结果 | 理论上能（密钥在进程内）但**每个 agent 密钥独立**、链上 pubKey 绑定，错钥即被拒 | **不能**（后端无任何 worker 私钥） |
| 链上验证 | `recovered == getPubKey(agent)` | 同左 |
| 残留信任 | 后端持有派生密钥 → 须信任后端不滥用 | 仅信任后端「不丢弃/不篡改」预签名 payload（可由 agent 自查链上记录检测） |
| 实现状态 | ✅ 已实现 | 🔌 接口预留（`makeWorkerSigningProvider('relay', {relayLookup})`），生产接入 |

## 论文可诚实声称的 / 不可声称的

**可声称（已由 P1-C2 + P2 共同保证）：**
- 执行结果签名经链上 EIP-712 重建验证，绑定 `chainId` + `verifyingContract` + `recordId` + `timestamp`，**抗跨链/跨合约/跨记录重放**。
- 结果签名必须来自该 agent **链上绑定的 pubKey**，单一后端密钥无法冒充任意 agent（C1 已修）。
- `demo` 模式下每个 agent 拥有**独立**、链上可验证的签名身份。

**不可声称（须如实披露为局限）：**
- `demo` 模式下 worker 私钥仍在后端进程内派生——这是为无头 E2E 测试的工程取舍，**不是**完整的密钥托管隔离。完整的「后端零接触 worker 密钥」需 `relay` 模式（生产）或 TEE/HSM（未来工作）。
- Router 决策签名密钥（`ROUTER_SIGNER_KEY`）合法地由运营方/中继持有——这是中继的职责（为决策背书），不属于 C1 的伪造面；但运营方仍是单点，多 Router 投票（`RouterRegistry`）是其去中心化路径。
- 运营方密钥本身的保护（KMS/HSM/轮换）尚未落地，列为生产加固项（P6）。

## 相关代码

- `agents/src/worker-signing.ts` — `makeWorkerSigningProvider(mode, opts)`，demo 按助记词派生、relay 转发预签名
- `agents/src/api-server.ts` — `workerSigning.forAgent(selected.address)` 取选中 agent 的签名器
- `contracts/AuditLog.sol` — `updateExecutionWithSig` 链上校验 `recovered == getPubKey(targetAgent)`
- `contracts/AgentDID.sol` — `registerAgentWithPubKey` / `getPubKey` 绑定与读取 pubKey
- `test/KeySeparation.test.js` — 正例（自钥通过）+ 反例（他钥被拒）
