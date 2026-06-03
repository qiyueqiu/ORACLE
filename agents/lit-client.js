/**
 * Lit Protocol 任务描述加密（M3 改造 12 - 任务隐私）
 *
 * 设计：
 *   - 用户用 Worker 的公钥加密任务描述（Lit 阈值加密）
 *   - 链上 TaskCommitment 只存加密后的 commitment
 *   - Worker 用 Lit 节点网络解密密文（满足访问条件时）
 *
 * 当前实现（M3 阶段）：
 *   - 提供 LitClient 占位符（mock 模式：返回原文）
 *   - 接口与 lit-js-sdk 兼容（未来切换到真实 SDK）
 *
 * 用法：
 *   const lit = new LitClient();
 *   const encrypted = await lit.encrypt(taskDescription, workerPubKey);
 *   const decrypted = await lit.decrypt(encrypted, workerWallet);
 */
'use strict';

const crypto = require('crypto');

class LitClient {
    constructor(opts = {}) {
        this.mode = opts.mode || 'mock';
        this.litNetwork = opts.network || 'datil-dev';  // Lit 测试网
    }

    /**
     * 加密任务描述（mock 模式：对称加密；真实模式：Lit access control + threshold decrypt）
     */
    async encrypt(plaintext, recipientPubKey) {
        if (this.mode === 'mock') {
            const key = crypto.randomBytes(32);
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
            const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
            // 真实模式：用 recipientPubKey 加密 key；mock 直接拼
            return {
                ciphertext: encrypted.toString('base64'),
                iv: iv.toString('base64'),
                // 模拟：key 也作为 access control 条件的一部分
                accessControlConditions: [
                    {
                        contractAddress: '',
                        standardContractType: '',
                        chain: 'ethereum',
                        method: '',
                        parameters: [':userAddress'],
                        returnValueTest: { comparator: '=', value: recipientPubKey }
                    }
                ],
                encryptedSymmetricKey: key.toString('base64'),
                mock: true
            };
        }
        throw new Error('Real Lit mode requires lit-js-sdk; install separately');
    }

    /**
     * 解密（mock 模式：直接用 symmetric key）
     */
    async decrypt(encryptedObject, workerWallet) {
        if (this.mode === 'mock') {
            const key = Buffer.from(encryptedObject.encryptedSymmetricKey, 'base64');
            const iv = Buffer.from(encryptedObject.iv, 'base64');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            const decrypted = Buffer.concat([
                decipher.update(Buffer.from(encryptedObject.ciphertext, 'base64')),
                decipher.final()
            ]);
            return decrypted.toString('utf8');
        }
        throw new Error('Real Lit mode requires lit-js-sdk');
    }

    /**
     * 检查 access control（链上验证 Worker 公钥）
     */
    async checkAccess(encryptedObject, workerAddress) {
        if (this.mode === 'mock') {
            return encryptedObject.accessControlConditions.some(c =>
                c.returnValueTest.value.toLowerCase() === workerAddress.toLowerCase()
            );
        }
        throw new Error('Real Lit mode requires lit-js-sdk');
    }
}

let _default = null;
function getLitClient() {
    if (!_default) _default = new LitClient();
    return _default;
}

module.exports = { LitClient, getLitClient };
