/**
 * security.ts — P6 生产加固：鉴权 fail-secure + 有界 LRU 限流 + 错误脱敏
 *
 * 所有函数以工厂函数形式导出，便于单测时传入不同 opts。
 */

import { createHash } from 'crypto';
import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// ─────────────────────────────────────────────────────────────
// §1  错误脱敏
// ─────────────────────────────────────────────────────────────

let _reqCounter = 0;

/** 生成单调递增 requestId（确定性，不用随机源）。 */
function nextRequestId(): string {
  _reqCounter += 1;
  return `req-${Date.now()}-${_reqCounter}`;
}

/**
 * sendError — 客户端只见 {error:{code, requestId}}，不泄露原始 message/stack。
 * 服务端用结构化 JSON 记录 full detail。
 */
export function sendError(
  res: Response,
  status: number,
  code: string,
  logDetail?: unknown,
): void {
  const requestId = nextRequestId();
  console.error(
    JSON.stringify({
      level: 'error',
      component: 'api-server',
      requestId,
      code,
      detail: logDetail instanceof Error
        ? { message: logDetail.message, stack: logDetail.stack }
        : logDetail,
      ts: new Date().toISOString(),
    }),
  );
  res.status(status).json({ error: { code, requestId } });
}

// ─────────────────────────────────────────────────────────────
// §2  鉴权 fail-secure（常量时间比较）
// ─────────────────────────────────────────────────────────────

export interface ApiAuthOpts {
  accessKeys: string[];
  revokedKeys: string[];
  isDev: boolean;
}

/**
 * makeApiAuth — 返回 Express 中间件。
 *
 * 行为矩阵：
 *  - 无 key 配置 + dev  → 放行（开发便利）
 *  - 无 key 配置 + prod → 503 AUTH_NOT_CONFIGURED（fail-secure）
 *  - key 在撤销列表中   → 401 KEY_REVOKED
 *  - key 不存在/错误    → 401 UNAUTHORIZED
 *  - key 正确           → 放行
 */
export function makeApiAuth(opts: ApiAuthOpts) {
  const { accessKeys, revokedKeys, isDev } = opts;

  // 预计算所有合法 key 的 SHA-256 摘要（固定长度，方便 timingSafeEqual）
  const validDigests = accessKeys.map(hashKey);
  const revokedSet = new Set(revokedKeys);

  return function apiAuth(req: Request, res: Response, next: NextFunction): void {
    // 1. 未配置 key
    if (accessKeys.length === 0) {
      if (isDev) {
        return next();
      }
      sendError(res, 503, 'AUTH_NOT_CONFIGURED');
      return;
    }

    // 2. 取请求携带的 key
    const key = req.header('x-api-key');
    if (!key) {
      sendError(res, 401, 'UNAUTHORIZED');
      return;
    }

    // 3. 撤销检查（明文比较即可，撤销是公开语义）
    if (revokedSet.has(key)) {
      sendError(res, 401, 'KEY_REVOKED');
      return;
    }

    // 4. 常量时间比较：对摘要比较，避免早退时序泄漏
    const incomingDigest = hashKey(key);
    const incomingBuf = Buffer.from(incomingDigest, 'hex');
    let matched = false;
    for (const digest of validDigests) {
      const validBuf = Buffer.from(digest, 'hex');
      // timingSafeEqual 要求等长；SHA-256 hex 永远 64 字符，已满足
      if (timingSafeEqual(incomingBuf, validBuf)) {
        matched = true;
        // 不 break：继续循环以保持恒定时间
      }
    }

    if (!matched) {
      sendError(res, 401, 'UNAUTHORIZED');
      return;
    }

    next();
  };
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// ─────────────────────────────────────────────────────────────
// §3  有界 LRU per-key 限流
// ─────────────────────────────────────────────────────────────

export interface RateLimitOpts {
  windowMs: number;
  max: number;
  /** 最多跟踪多少个 key（超出淘汰最旧）。默认 10000。 */
  maxTrackedKeys?: number;
}

/**
 * 极简有界 LRU：基于 Map 的插入顺序 + size 上限。
 * Map 迭代顺序是插入顺序，删第一个 = 淘汰最旧。
 */
class BoundedLRU<K, V> {
  private readonly map: Map<K, V>;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    // 读取时移到末尾（LRU 语义）
    const v = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // 淘汰最旧（第一个插入的）
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * makeRateLimit — 返回 Express 中间件。
 *
 * 桶键：有 x-api-key 时用 key，否则回退 IP。
 * 超限返回 429 RATE_LIMITED。
 */
export function makeRateLimit(opts: RateLimitOpts) {
  const { windowMs, max, maxTrackedKeys = 10000 } = opts;
  const buckets = new BoundedLRU<string, number[]>(maxTrackedKeys);

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const bucketKey =
      req.header('x-api-key') ||
      req.ip ||
      req.socket.remoteAddress ||
      'unknown';

    const now = Date.now();
    const cutoff = now - windowMs;
    const prev = buckets.get(bucketKey) ?? [];
    const bucket = prev.filter((t) => t > cutoff);

    if (bucket.length >= max) {
      sendError(res, 429, 'RATE_LIMITED');
      return;
    }

    bucket.push(now);
    buckets.set(bucketKey, bucket);
    next();
  };
}
