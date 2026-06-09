// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20（测试用）
 * @notice 用于本地 Hardhat 网络的测试 token
 */
contract MockERC20 is ERC20 {
    constructor() ERC20("ORACLE Test Token", "ORC") {
        // 给部署者 mint 1,000,000 token
        _mint(msg.sender, 1_000_000 * 1e18);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
