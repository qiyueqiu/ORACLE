# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ORACLE (On-chain Reputation & Audit for Coordinated LLM-Agent Execution) — a demo combining LLM-driven agent routing with on-chain trust and audit mechanisms. Three Solidity contracts provide DID identity, audit logging, and reputation scoring. A Node.js API server hosts Router/Worker agents that use SiliconFlow LLMs. A React frontend provides the UI.

## Commands

```bash
# Blockchain
npx hardhat compile                  # Compile Solidity contracts
npx hardhat test                     # Run all contract tests
npx hardhat test test/AgentDID.test.js   # Run single test file
npx hardhat node                     # Start local Hardhat node on :8545
npx hardhat run scripts/deploy.js --network localhost  # Deploy contracts

# Frontend (from frontend/)
npm run dev                          # Vite dev server on :5173
npm run build                        # TypeScript check + production build

# Agent API server (from agents/)
node api-server.js                   # Express API on :3001

# E2E test (requires all services running)
node test/e2e-test.js                   # Playwright-driven full flow test (from project root)
```

## Architecture

### Smart Contracts (Solidity 0.8.20, Hardhat)

- **AgentDID** — Agent identity with ZKP-simulated credential verification. Registration creates a `commitment = keccak256(nullifier, secretHash)`. Verification opens the commitment with nullifier+secretHash; nullifier prevents reuse.
- **AuditLog** — Immutable dispatch records with `ScheduleRecord` struct tracking requester, target agent, decision reason, execution status, and ratings. Supports queries by agent, requester, and time range.
- **Reputation** — 0–100 (percentile) rating system per agent. Ratings are weight-averaged (`weight = sqrt(raterAvg)`). `isReliable()` requires weighted avg ≥ 60 (`RELIABLE_THRESHOLD`) with ≥ 3 ratings (`MIN_RATINGS_FOR_RELIABLE`). Also exposes `timeDecayed()` and `isReliableWeighted()`. Includes penalty mechanism.

Deploy writes contract addresses to `frontend/src/contracts/addresses.json`. Frontend ABI bindings are hand-maintained in `frontend/src/contracts/abis.ts`.

### Agent Backend (Node.js, Express)

- **api-server.js** — Express server exposing dispatch (`POST /api/dispatch` blocking, `POST /api/dispatch/stream` SSE), rating, reputation, and health endpoints. Dispatch/rating routes are guarded by `x-api-key` auth + rate limiting (via `API_ACCESS_KEYS`). Orchestrates the full flow: route → execute → log to chain.
- **RouterAgent** — LLM-driven 4-step pipeline: parse intent → fetch candidate agents from chain → evaluate via LLM scoring (`score = 0.6·q + 0.4·rNorm`, q∈{60,40} qualification match, rNorm normalized reputation) → select best. Falls back to same-weight rule-based matching if LLM fails.
- **WorkerAgent** — Executes tasks via LLM with chain-of-thought prompting. Selects model by task complexity (Qwen2.5-7B for simple, DeepSeek-V3 for complex).
- **SiliconFlowClient** — Wrapper for SiliconFlow API (`api.siliconflow.cn/v1`). Supports plain chat and structured JSON output.

### Frontend (React, TypeScript, Vite, Tailwind CSS)

Tab-based SPA (no router library used for navigation despite react-router-dom being installed). Three pages:
- **Dashboard** — Agent registration + status display
- **Dispatch** — Task input + execution tracking
- **AuditLog** — On-chain audit record query

Connects to Hardhat local node via ethers.js v6. Uses MetaMask (`window.ethereum` + `BrowserProvider`) when available, **and falls back to Hardhat's default signer (chainId 31337)** when no injected provider is detected — enabling headless E2E tests without a wallet extension.

## Key Data Flow

1. User registers agents on Dashboard → `AgentDID.registerAgent()` on chain
2. User submits task on Dispatch → frontend calls `/api/dispatch`
3. RouterAgent reads agent list + reputations from chain, LLM evaluates, picks best
4. WorkerAgent executes task via LLM, returns result with chain-of-thought
5. API server logs dispatch + result to `AuditLog` contract on chain
6. AuditLog page reads records directly from chain

## Environment

- Local development uses Hardhat local network (localhost:8545, chainId 31337)
- SiliconFlow API key is needed for LLM features (set `SILICONFLOW_API_KEY` env var or fallback in api-server.js)
- Contract addresses are hardcoded in multiple places after first deploy: `api-server.js`, `test/e2e-test.js`, and `frontend/src/contracts/addresses.json`
