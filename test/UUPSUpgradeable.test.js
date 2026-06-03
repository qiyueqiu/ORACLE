/**
 * UUPSUpgradeable 升级接口测试
 *
 * 注意：本项目 UUPSUpgradeable.sol 是"极简接口"版本（无 ERC1967 storage slot、
 * 无 Initializable），仅提供 upgradeTo / upgradeToAndCall 入口 + _authorizeUpgrade 钩子。
 * 生产部署需替换为完整 OZ 实现（含 storage slot）。本测试仅验证：
 *   - upgradeTo / upgradeToAndCall 接口签名
 *   - _authorizeUpgrade 权限（仅 owner）
 *   - upgradeToAndCall 委托调用执行
 *   - Upgraded 事件
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("UUPSUpgradeable (极简实现 - 扩展点)", function () {
    let mock, owner, other, user;

    beforeEach(async function () {
        [owner, other, user] = await ethers.getSigners();
        const MockUUPSContract = await ethers.getContractFactory("MockUUPSContract");
        mock = await MockUUPSContract.deploy();
        await mock.waitForDeployment();
    });

    it("Should deploy with owner = deployer", async function () {
        expect(await mock.owner()).to.equal(owner.address);
    });

    it("Should allow owner to call upgradeTo", async function () {
        const MockV2 = await ethers.getContractFactory("MockUUPSContract");
        const v2 = await MockV2.deploy();
        await v2.waitForDeployment();

        await expect(mock.connect(owner).upgradeTo(await v2.getAddress()))
            .to.emit(mock, "Upgraded")
            .withArgs(await v2.getAddress());
    });

    it("Should reject upgradeTo from non-owner", async function () {
        const MockV2 = await ethers.getContractFactory("MockUUPSContract");
        const v2 = await MockV2.deploy();
        await v2.waitForDeployment();

        await expect(
            mock.connect(other).upgradeTo(await v2.getAddress())
        ).to.be.revertedWithCustomError(mock, "OwnableUnauthorizedAccount");
    });

    it("Should execute delegatecall via upgradeToAndCall", async function () {
        const MockV2 = await ethers.getContractFactory("MockUUPSContract");
        const v2 = await MockV2.deploy();
        await v2.waitForDeployment();

        // setValue(uint256) selector
        const data = mock.interface.encodeFunctionData("setValue", [42]);
        await expect(mock.connect(owner).upgradeToAndCall(await v2.getAddress(), data))
            .to.emit(mock, "Upgraded");
        // 委托调用执行后，value 应被设置
        expect(await mock.value()).to.equal(42);
    });

    it("Should reject upgradeToAndCall on failed delegatecall", async function () {
        // 直接传非函数选择器的 bytes
        const badData = "0xdeadbeef";
        // 自己调用自己，但 data 非法会 revert
        await expect(
            mock.connect(owner).upgradeToAndCall(await mock.getAddress(), badData)
        ).to.be.reverted;  // 委托调用 revert
    });

    it("Should reject upgradeToAndCall from non-owner", async function () {
        const data = mock.interface.encodeFunctionData("setValue", [100]);
        await expect(
            mock.connect(other).upgradeToAndCall(await mock.getAddress(), data)
        ).to.be.revertedWithCustomError(mock, "OwnableUnauthorizedAccount");
    });

    it("Should preserve state across upgrade (演示)", async function () {
        // 先设置 value
        await mock.setValue(123);
        expect(await mock.value()).to.equal(123);

        // 部署同结构 v2（同样的 value slot）
        const MockV2 = await ethers.getContractFactory("MockUUPSContract");
        const v2 = await MockV2.deploy();
        await v2.waitForDeployment();

        // 极简版 UUPS 不做实际 slot 切换；这里仅验证升级入口正常
        await mock.connect(owner).upgradeTo(await v2.getAddress());
        // value 仍然是原值（因为没真正切换实现）
        expect(await mock.value()).to.equal(123);
    });
});
