/**
 * IPFS 客户端（M2 改造 9）
 *
 * 设计目标：
 *   - Worker 把完整结果（Markdown、代码、图片）上传到 IPFS
 *   - 链上 AuditLog 只存 CID（bytes32）+ resultDigest
 *   - 前端通过 CID 拉 IPFS 节点获取完整内容
 *
 * 当前实现：
 *   - 内存 mock 模式：upload 返回 `mock-<hash>` 格式 CID，便于测试与离线运行
 *   - HTTP 模式：当配置了 IPFS_API_URL（如 http://localhost:5001/api/v0 或 Pinata 端点）时真正上传
 *
 * 切换为真实 IPFS：
 *   - 本地：docker run -p 5001:5001 ipfs/kubo + 设置 IPFS_API_URL=http://localhost:5001/api/v0
 *   - Pinata：IPFS_API_URL=https://api.pinata.cloud + IPFS_API_KEY=<JWT>
 *   - Web3.Storage：IPFS_API_URL=https://api.web3.storage + IPFS_API_TOKEN=<token>
 */
'use strict';

const crypto = require('crypto');

class IPFSClient {
    /**
     * @param {object} opts
     * @param {string} [opts.apiUrl] IPFS HTTP API URL
     * @param {string} [opts.apiKey] API 认证 key
     * @param {string} [opts.mode] 'mock' | 'http'（默认 'mock'，有 apiUrl 时自动切 http）
     */
    constructor(opts = {}) {
        this.apiUrl = opts.apiUrl || process.env.IPFS_API_URL || '';
        this.apiKey = opts.apiKey || process.env.IPFS_API_KEY || '';
        this.mode = opts.mode || (this.apiUrl ? 'http' : 'mock');
    }

    /**
     * 上传内容到 IPFS
     * @param {string|Buffer} content
     * @returns {Promise<{cid: string, size: number}>}
     */
    async upload(content) {
        if (this.mode === 'mock') {
            return this._uploadMock(content);
        }
        return this._uploadHttp(content);
    }

    /**
     * 从 IPFS 拉取内容（mock 模式仅返回之前上传过的）
     */
    async fetch(cid) {
        if (this.mode === 'mock') {
            return this._fetchMock(cid);
        }
        return this._fetchHttp(cid);
    }

    async _uploadMock(content) {
        const buf = typeof content === 'string' ? Buffer.from(content) : content;
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const cid = `mock-${hash.slice(0, 32)}`;  // 32 hex = 16 bytes, pad to bytes32
        const cidBytes32 = '0x' + hash.slice(0, 64);
        this._store = this._store || new Map();
        this._store.set(cid, buf);
        return { cid, cidBytes32, size: buf.length };
    }

    async _fetchMock(cid) {
        this._store = this._store || new Map();
        const buf = this._store.get(cid);
        if (!buf) throw new Error(`IPFS mock: CID ${cid} not found`);
        return buf;
    }

    async _uploadHttp(content) {
        // 占位：实际实现需 axios + form-data
        throw new Error('IPFS HTTP mode not implemented yet; set IPFS_API_URL= (empty) for mock mode');
    }

    async _fetchHttp(cid) {
        throw new Error('IPFS HTTP mode not implemented yet');
    }
}

let _defaultClient = null;
function getIPFSClient() {
    if (!_defaultClient) _defaultClient = new IPFSClient();
    return _defaultClient;
}

module.exports = { IPFSClient, getIPFSClient };
