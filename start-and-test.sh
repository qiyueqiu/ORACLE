#!/bin/bash
# ASB + Blockchain Demo — 一键启动 & 有头浏览器端到端演示
# 用法: bash start-and-test.sh

set -e

PROJECT_ROOT="/home/qiqi/workspace/asb-blockchain-demo"
LOG_DIR="$PROJECT_ROOT/logs"
SCREENSHOT_DIR="$PROJECT_ROOT/e2e-screenshots"
mkdir -p "$LOG_DIR" "$SCREENSHOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[启动脚本]${NC} $1"; }
ok() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

cleanup() {
  log "清理所有后台进程..."
  for pid_file in "$LOG_DIR"/*.pid; do
    if [ -f "$pid_file" ]; then
      pid=$(cat "$pid_file")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
      rm -f "$pid_file"
    fi
  done
}

trap cleanup EXIT INT TERM

# 清理旧进程
for port in 8545 3001 5173; do
  pid=$(lsof -t -i :$port 2>/dev/null || true)
  if [ -n "$pid" ]; then
    warn "端口 $port 被占用，终止旧进程..."
    kill $pid 2>/dev/null || true
    sleep 1
  fi
done

# ============ 1. 启动 Hardhat 本地节点 ============
log "启动 Hardhat 本地节点 (端口 8545)..."
cd "$PROJECT_ROOT"
npx hardhat node > "$LOG_DIR/hardhat.log" 2>&1 &
echo $! > "$LOG_DIR/hardhat.pid"
sleep 3

if ! kill -0 $(cat "$LOG_DIR/hardhat.pid") 2>/dev/null; then
  err "Hardhat 节点启动失败!"
  cat "$LOG_DIR/hardhat.log"
  exit 1
fi
ok "Hardhat 节点已启动 (PID: $(cat "$LOG_DIR/hardhat.pid"))"

# ============ 2. 部署合约 ============
log "部署智能合约..."
cd "$PROJECT_ROOT"
npx hardhat run scripts/deploy.js --network localhost > "$LOG_DIR/deploy.log" 2>&1
ok "合约部署完成"

# 从 deploy.log 提取合约地址并更新 api-server.js
AGENT_DID=$(grep "AgentDID deployed to:" "$LOG_DIR/deploy.log" | awk '{print $NF}')
AUDIT_LOG=$(grep "AuditLog deployed to:" "$LOG_DIR/deploy.log" | awk '{print $NF}')
REPUTATION=$(grep "Reputation deployed to:" "$LOG_DIR/deploy.log" | awk '{print $NF}')

if [ -n "$AGENT_DID" ]; then
  log "合约地址: AgentDID=$AGENT_DID, AuditLog=$AUDIT_LOG, Reputation=$REPUTATION"
fi

# ============ 3. 注册测试 Agent ============
log "注册测试 Agent..."
cd "$PROJECT_ROOT"
npx hardhat run test/setup-test-agents.js --network localhost >> "$LOG_DIR/deploy.log" 2>&1 || true
ok "测试 Agent 注册完成"

# ============ 4. 启动 API Server ============
log "启动 Agent API Server (端口 3001)..."
cd "$PROJECT_ROOT/agents"
node api-server.js > "$LOG_DIR/api-server.log" 2>&1 &
echo $! > "$LOG_DIR/api-server.pid"
sleep 2

if ! kill -0 $(cat "$LOG_DIR/api-server.pid") 2>/dev/null; then
  err "API Server 启动失败!"
  cat "$LOG_DIR/api-server.log"
  exit 1
fi
ok "API Server 已启动 (PID: $(cat "$LOG_DIR/api-server.pid"))"

# ============ 5. 启动 Frontend Dev Server ============
log "启动 Frontend Dev Server (端口 5173)..."
cd "$PROJECT_ROOT/frontend"
npx vite --host > "$LOG_DIR/frontend.log" 2>&1 &
echo $! > "$LOG_DIR/frontend.pid"
sleep 3

if ! kill -0 $(cat "$LOG_DIR/frontend.pid") 2>/dev/null; then
  err "Frontend 启动失败!"
  cat "$LOG_DIR/frontend.log"
  exit 1
fi
ok "Frontend 已启动 (PID: $(cat "$LOG_DIR/frontend.pid"))"

# ============ 6. 验证所有服务 ============
log "验证服务状态..."

curl -s http://localhost:8545 > /dev/null 2>&1 && ok "Hardhat 节点 (8545) - 正常" || err "Hardhat 节点 (8545) - 异常"
curl -s http://localhost:3001/api/health > /dev/null 2>&1 && ok "API Server (3001) - 正常" || err "API Server (3001) - 异常"
curl -s http://localhost:5173 > /dev/null 2>&1 && ok "Frontend (5173) - 正常" || err "Frontend (5173) - 异常"

echo ""
echo "============================================"
ok "所有服务已就绪！"
echo "============================================"
echo "  Hardhat:  http://localhost:8545"
echo "  API:      http://localhost:3001"
echo "  Frontend: http://localhost:5173"
echo "============================================"
echo ""

# ============ 7. 运行有头浏览器 E2E 演示 ============
log "启动有头浏览器端到端演示测试..."
cd "$PROJECT_ROOT"
node e2e-test.js

ok "端到端演示完成!"
echo ""
echo "截图保存在: $SCREENSHOT_DIR/"
echo "日志保存在: $LOG_DIR/"
