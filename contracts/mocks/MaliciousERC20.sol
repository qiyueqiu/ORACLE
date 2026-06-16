// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IReentrantTarget {
    function refund(uint256 recordId) external;
    function release(uint256 recordId) external;
}

/**
 * @title MaliciousERC20（测试用，P6 重入回归）
 * @notice 在 transfer 内回调目标合约的 refund/release，用于证明 PaymentEscrow
 *   的 nonReentrant + CEI 能挡住重入。单次开关防无限递归；用 try/catch 吞掉
 *   内层 revert，使外层 transfer 仍返回 true，从而测试可断言"外层成功 + 状态只变一次"。
 */
contract MaliciousERC20 is ERC20 {
    address public attackTarget;
    uint256 public attackRecordId;
    bool public attackRefund; // true=重入 refund, false=重入 release
    bool private attacking;
    bool public reentered; // 记录是否真的发生过重入调用（用于断言）

    constructor() ERC20("Malicious Token", "EVIL") {
        _mint(msg.sender, 1_000_000 * 1e18);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address _target, uint256 _recordId, bool _attackRefund) external {
        attackTarget = _target;
        attackRecordId = _recordId;
        attackRefund = _attackRefund;
        attacking = true;
    }

    // 在每次 transfer 时尝试重入一次目标合约
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (attacking && attackTarget != address(0)) {
            attacking = false; // 单次：防止无限递归
            reentered = true;
            // 内层重入：若 ReentrancyGuard 生效会 revert，被 try/catch 吞掉，
            // 外层 transfer 照常完成，状态机仅推进一次。
            try IReentrantTarget(attackTarget).refund(attackRecordId) {
                // 不应到达（refund 被 nonReentrant 挡住）
            } catch {
                // 预期路径：重入被拒
            }
        }
    }
}
