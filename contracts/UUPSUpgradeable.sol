// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title UUPSUpgradeable（⚠ 非功能性占位 STUB）
 * @notice 非功能性占位实现 —— 本合约**不写** ERC1967 实现槽。
 *   upgradeTo 仅 emit Upgraded 事件，代理存储从不更新；
 *   upgradeToAndCall 对 newImplementation 直接做裸 delegatecall，并非经代理槽。
 *   这**不是**可用的 UUPS 代理。本仓库中**没有任何生产合约**继承本合约
 *   （仅测试 mock contracts/mocks/MockUUPSContract.sol 使用）。
 * @dev 实现真实可升级性的方法：安装 @openzeppelin/contracts-upgradeable，
 *   将 solc 提升到 >=0.8.22，使用 OZ 的 deployProxy/upgradeProxy。
 *   在任何将部署到真实网络的合约中**禁止**继承本占位。
 * @custom:security DO NOT USE IN PRODUCTION — non-functional upgrade stub.
 */
abstract contract UUPSUpgradeable {
    address private immutable __self = address(this);

    event Upgraded(address indexed implementation);

    /**
     * @notice 升级到新实现（仅 owner）
     * @dev ⚠ 非功能性：emit Upgraded 但**不更新** ERC1967 槽。
     * @param newImplementation 新实现合约地址
     */
    function upgradeTo(address newImplementation) external virtual {
        _authorizeUpgrade(newImplementation);
        // 实际 ERC1967 slot 写入由子类实现（或切换到完整 OZ 实现）
        emit Upgraded(newImplementation);
    }

    /**
     * @dev ⚠ 非功能性：裸 delegatecall，不经 ERC1967 代理槽。
     */
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable virtual {
        _authorizeUpgrade(newImplementation);
        (bool ok, ) = newImplementation.delegatecall(data);
        require(ok, "Delegatecall failed");
        emit Upgraded(newImplementation);
    }

    function _authorizeUpgrade(address newImplementation) internal virtual;
}
