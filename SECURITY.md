# Security Policy

## Supported Versions

The `main` branch is actively maintained. Earlier versions are not guaranteed to receive security fixes.

## Reporting a Vulnerability

**Please do NOT open a public GitHub Issue for security vulnerabilities.**

Report by email to **aisc@szu.edu.cn** with:

- A description of the vulnerability and its impact
- Reproduction steps (a minimal PoC is ideal)
- Affected component (which contract, agent module, or frontend code)
- Your name and affiliation (optional; anonymous reports are also accepted)

We will acknowledge receipt within a few business days and work with you on coordinated disclosure.

## Scope

This policy applies to the code in this repository. For vulnerabilities in the underlying dependencies (Hardhat, OpenZeppelin contracts, SiliconFlow API, etc.), report to the respective maintainers.

## Known Limitations (Not Vulnerabilities)

These are by-design constraints and not security issues:

- **Not a zero-knowledge proof**: AgentDID uses hash commit-reveal, not ZK. The dispatcher's choice is revealed, not hidden.
- **Not Sybil/collusion resistant**: Reputation weighting raises the cost of naive Sybil attacks but does not prevent coordinated collusion among reputation holders.
- **LLM correctness out of scope**: The signature attests authorship of the LLM output, not the output's correctness.
- **Test private keys in CI**: The CI workflow contains Hardhat's default local test private keys (account[0/1/2]). These are public knowledge from Hardhat documentation and are used only for `localhost` E2E tests; they do not correspond to real assets.