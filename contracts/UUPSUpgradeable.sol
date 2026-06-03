// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title UUPSUpgradeable（极简接口 - M2 阶段）
 * @notice 仅提供 upgrade 入口与接口签名；生产部署需在 OZ v5 + contracts-upgradeable 基础上完整实现
 *
 * 当前状态（M2 阶段）：
 *   - 已实现：抽象类定义、upgradeTo / upgradeToAndCall 接口签名
 *   - 待 M2 收尾或后续：在依赖冲突解决后切换到完整 UUPS（含 storage slot、Initializable 集成）
 *
 * 用法：
 *   - 继承：`contract MyContract is Ownable, UUPSUpgradeable { ... }`
 *   - 实现 `_authorizeUpgrade`（默认仅 owner 可升级）
 *   - 部署时 `initialize()` 一次
 *
 * 真实部署前需替换为完整 OZ UUPSUpgradeable（含 ERC1967 storage slot）。
 */
abstract contract UUPSUpgradeable {
    address private immutable __self = address(this);

    event Upgraded(address indexed implementation);

    /**
     * @notice 升级到新实现（仅 owner）
     * @param newImplementation 新实现合约地址
     */
    function upgradeTo(address newImplementation) external virtual {
        _authorizeUpgrade(newImplementation);
        // 实际 ERC1967 slot 写入由子类实现（或切换到完整 OZ 实现）
        emit Upgraded(newImplementation);
    }

    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable virtual {
        _authorizeUpgrade(newImplementation);
        (bool ok, ) = newImplementation.delegatecall(data);
        require(ok, "Delegatecall failed");
        emit Upgraded(newImplementation);
    }

    function _authorizeUpgrade(address newImplementation) internal virtual;
}
