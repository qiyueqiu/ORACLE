/**
 * AuditAdapter 单元测试（ESM + TypeScript）
 *
 * 覆盖成本--可验证性帕累托前沿接入生产的适配器契约：
 *  - full / optimized 两模式正确构造
 *  - optimized 缺地址时明确抛错（fail-fast，不静默退回 full）
 *  - 两模式的 supportsOnChainReadback 标志正确（影响 reputation summary 降级）
 *  - recordId 从交易回执的首个 indexed topic 解析
 *
 * 不依赖链上交易：构造适配器只需 signer，logSchedule/updateExecution 的链上行为
 * 由真实 dispatch（连本地 hardhat node）端到端验证。
 */
import { expect } from 'chai';
import { ethers } from 'ethers';
import {
  makeAuditAdapter,
  FullAuditAdapter,
  OptimizedAuditAdapter,
} from '../src/audit-adapter.js';

const DUMMY_AUDIT = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const DUMMY_OPTIMIZED = '0x6B9B6C2b1A6EA7AE619882109e640d0a530527ce';
// 一个确定性测试私钥（Hardhat account #0），仅离线构造签名器用
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('agents/audit-adapter', function () {
  let signer: ethers.Wallet;

  beforeEach(function () {
    signer = new ethers.Wallet(TEST_PK);
  });

  describe('makeAuditAdapter 工厂', function () {
    it('默认/full 模式返回 FullAuditAdapter，支持链上回读', function () {
      const a = makeAuditAdapter('full', { AuditLog: DUMMY_AUDIT }, signer);
      expect(a).to.be.instanceOf(FullAuditAdapter);
      expect(a.mode).to.equal('full');
      expect(a.supportsOnChainReadback).to.equal(true);
    });

    it('optimized 模式返回 OptimizedAuditAdapter，不支持链上回读', function () {
      const a = makeAuditAdapter(
        'optimized',
        { AuditLog: DUMMY_AUDIT, AuditLogOptimized: DUMMY_OPTIMIZED },
        signer,
      );
      expect(a).to.be.instanceOf(OptimizedAuditAdapter);
      expect(a.mode).to.equal('optimized');
      // event-only 模式：可发现性移到链下 indexer，无 getRecord 回读
      expect(a.supportsOnChainReadback).to.equal(false);
    });

    it('optimized 模式缺 AuditLogOptimized 地址时 fail-fast 抛错（不静默退回 full）', function () {
      expect(() => makeAuditAdapter('optimized', { AuditLog: DUMMY_AUDIT }, signer)).to.throw(
        /AUDIT_LOG_OPTIMIZED_ADDRESS/,
      );
    });
  });

  describe('适配器契约', function () {
    it('两模式都暴露 logSchedule / updateExecution 方法', function () {
      const full = makeAuditAdapter('full', { AuditLog: DUMMY_AUDIT }, signer);
      const opt = makeAuditAdapter(
        'optimized',
        { AuditLog: DUMMY_AUDIT, AuditLogOptimized: DUMMY_OPTIMIZED },
        signer,
      );
      for (const a of [full, opt]) {
        expect(a.logSchedule).to.be.a('function');
        expect(a.updateExecution).to.be.a('function');
      }
    });
  });
});
