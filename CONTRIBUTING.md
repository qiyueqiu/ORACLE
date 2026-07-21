# Contributing to ORACLE

Thanks for your interest in ORACLE. This is a research prototype released
alongside an academic paper, so contributions are welcome but reviewed with an
eye toward keeping the system faithful to what the paper describes and measures.

感谢你对 ORACLE 的关注。本仓库是配合学术论文发布的研究原型，欢迎贡献；
为保证系统与论文所述、所测内容一致，所有改动都会经过审阅。

## Ways to contribute · 贡献方式

- **Bug reports** — open an issue with steps to reproduce, expected vs. actual
  behavior, and your environment (Node version, OS, network).
- **Fixes and improvements** — open a pull request (see the flow below).
- **Questions and ideas** — open a discussion or an issue tagged `question`.

- **缺陷报告** — 提 issue，附复现步骤、预期与实际行为、运行环境（Node 版本、
  操作系统、网络）。
- **修复与改进** — 提 pull request（见下面的流程）。
- **提问与想法** — 开 discussion，或提带 `question` 标签的 issue。

## Development setup · 开发环境

```bash
# Contracts (project root)
npx hardhat compile
npx hardhat test

# Agent backend (from agents/)
npm install
npm run typecheck   # tsc -p tsconfig.json
npm run lint        # eslint
npm test            # mocha + tsx

# Frontend (from frontend/)
npm install
npm run build       # tsc + vite build
```

See [README.md](README.md) and [CLAUDE.md](CLAUDE.md) for the full architecture
and command reference.

## Pull request checklist · 合并请求清单

Before opening a PR, please make sure:

1. **It builds and the checks pass.** Run the type-check, lint, and test gates
   for any package you touched (`npm run typecheck && npm run lint && npm test`
   in `agents/`; `npx hardhat test` for contracts; `npm run build` for the
   frontend).
2. **New behavior is tested.** Add or update tests for bug fixes and features.
   Security-relevant contract logic (attribution, slashing, reputation) must be
   covered by a test over the deployed contracts.
3. **The scope is focused.** One logical change per PR. Avoid mixing unrelated
   refactors with a fix.
4. **Commits are descriptive.** We loosely follow
   [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`) — see the git
   history for examples.
5. **You match the surrounding style.** No new dependencies or patterns unless
   they are necessary and explained in the PR description.

提交 PR 前请确认：能编译且检查通过；新行为有测试覆盖（涉及归属 / 罚没 / 信誉
的合约逻辑必须有针对已部署合约的测试）；改动聚焦单一目的；提交信息清晰
（遵循 Conventional Commits）；风格与既有代码一致，非必要不引入新依赖。

## Research reproducibility · 研究可复现性

Numbers in the paper come from scripts in this repository. If you change code
that affects a reported result (gas costs, routing accuracy, latency), please
say so in the PR and, where feasible, include the regenerated data or figure so
reviewers can confirm the paper stays consistent with the code.

论文中的数据来自本仓库的脚本。若改动会影响已报告的结果（gas 成本、路由准确率、
延迟等），请在 PR 中说明，并尽量附上重新生成的数据或图表，便于确认论文与代码
保持一致。

## Reporting security issues · 安全问题上报

ORACLE is a research prototype and is **not** audited for production use. If you
find a security-relevant issue, please **do not** open a public issue; instead
email the maintainer at **[qiyueqiu777@qq.com](mailto:qiyueqiu777@qq.com)** with
details, and allow reasonable time to respond before any public disclosure.

ORACLE 是研究原型，**未经生产级安全审计**。若发现安全相关问题，请**不要**公开提
issue，而是邮件联系维护者 **[qiyueqiu777@qq.com](mailto:qiyueqiu777@qq.com)** 并附
细节，在公开披露前留出合理的响应时间。

## License · 许可证

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.

提交贡献即表示你同意你的贡献在本项目的 [MIT 许可证](LICENSE)下授权。
