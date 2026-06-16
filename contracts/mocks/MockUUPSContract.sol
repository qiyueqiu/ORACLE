// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../UUPSUpgradeable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockUUPSContract - 用于测试 UUPSUpgradeable 的最小实现
 * @dev ⚠ 测试专用 mock，继承非功能性 UUPSUpgradeable 占位。**禁止部署到真实网络**。
 * 注：极简版 UUPSUpgradeable 不含 Initializable，本合约直接部署即可使用
 */
contract MockUUPSContract is UUPSUpgradeable, Ownable {
    uint256 public value;
    mapping(address => uint256) public balances;

    constructor() Ownable(msg.sender) {}

    function setValue(uint256 v) external {
        value = v;
    }

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
