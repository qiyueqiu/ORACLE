/**
 * security.test.ts — P6 安全模块单测
 *
 * 覆盖：makeApiAuth、makeRateLimit、sendError
 */
import { expect } from 'chai';
import type { Request, Response } from 'express';
import { makeApiAuth, makeRateLimit, sendError } from '../src/security.js';

// ─── 轻量级 mock 工具 ───────────────────────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    header: (_name: string) => undefined,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

interface MockRes {
  _status: number;
  _body: unknown;
  _ended: boolean;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
  writableEnded: boolean;
  destroyed: boolean;
}

function makeRes(): MockRes {
  const res: MockRes = {
    _status: 200,
    _body: null,
    _ended: false,
    writableEnded: false,
    destroyed: false,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      res._ended = true;
      return res;
    },
  };
  return res;
}

// ─── makeApiAuth ────────────────────────────────────────────────

describe('makeApiAuth', function () {
  it('无 key 配置 + isDev=false → 503 AUTH_NOT_CONFIGURED', function () {
    const middleware = makeApiAuth({ accessKeys: [], revokedKeys: [], isDev: false });
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    middleware(req as Request, res as unknown as Response, () => { nextCalled = true; });
    expect(nextCalled).to.equal(false);
    expect(res._status).to.equal(503);
    const body = res._body as { error: { code: string } };
    expect(body.error.code).to.equal('AUTH_NOT_CONFIGURED');
  });

  it('无 key 配置 + isDev=true → 放行 (next())', function () {
    const middleware = makeApiAuth({ accessKeys: [], revokedKeys: [], isDev: true });
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    middleware(req as Request, res as unknown as Response, () => { nextCalled = true; });
    expect(nextCalled).to.equal(true);
    expect(res._status).to.equal(200); // json() not called
  });

  it('有 key 配置，请求无 x-api-key → 401 UNAUTHORIZED', function () {
    const middleware = makeApiAuth({ accessKeys: ['secret123'], revokedKeys: [], isDev: false });
    const req = makeReq({ header: (_n: string) => undefined } as Partial<Request>);
    const res = makeRes();
    let nextCalled = false;
    middleware(req as Request, res as unknown as Response, () => { nextCalled = true; });
    expect(nextCalled).to.equal(false);
    expect(res._status).to.equal(401);
    const body = res._body as { error: { code: string } };
    expect(body.error.code).to.equal('UNAUTHORIZED');
  });

  it('错误 key → 401 UNAUTHORIZED', function () {
    const middleware = makeApiAuth({ accessKeys: ['correct-key'], revokedKeys: [], isDev: false });
    const req = makeReq({
      header: (name: string) => name === 'x-api-key' ? 'wrong-key' : undefined,
    } as Partial<Request>);
    const res = makeRes();
    let nextCalled = false;
    middleware(req as Request, res as unknown as Response, () => { nextCalled = true; });
    expect(nextCalled).to.equal(false);
    expect(res._status).to.equal(401);
    const body = res._body as { error: { code: string } };
    expect(body.error.code).to.equal('UNAUTHORIZED');
  });

  it('撤销 key → 401 KEY_REVOKED', function () {
    const middleware = makeApiAuth({
      accessKeys: ['valid-key'],
      revokedKeys: ['revoked-key'],
      isDev: false,
    });
    const req = makeReq({
      header: (name: string) => name === 'x-api-key' ? 'revoked-key' : undefined,
    } as Partial<Request>);
    const res = makeRes();
    let nextCalled = false;
    middleware(req as Request, res as unknown as Response, () => { nextCalled = true; });
    expect(nextCalled).to.equal(false);
    expect(res._status).to.equal(401);
    const body = res._body as { error: { code: string } };
    expect(body.error.code).to.equal('KEY_REVOKED');
  });

  it('正确 key → 放行 (next())', function () {
    const middleware = makeApiAuth({
      accessKeys: ['good-key'],
      revokedKeys: [],
      isDev: false,
    });
    const req = makeReq({
      header: (name: string) => name === 'x-api-key' ? 'good-key' : undefined,
    } as Partial<Request>);
    const res = makeRes();
    let nextCalled = false;
    middleware(req as Request, res as unknown as Response, () => { nextCalled = true; });
    expect(nextCalled).to.equal(true);
    expect(res._ended).to.equal(false);
  });

  it('多个合法 key，任意一个都能放行', function () {
    const middleware = makeApiAuth({
      accessKeys: ['key-a', 'key-b', 'key-c'],
      revokedKeys: [],
      isDev: false,
    });
    for (const key of ['key-a', 'key-b', 'key-c']) {
      const req = makeReq({
        header: (name: string) => name === 'x-api-key' ? key : undefined,
      } as Partial<Request>);
      const res = makeRes();
      let nextCalled = false;
      middleware(req as Request, res as unknown as Response, () => { nextCalled = true; });
      expect(nextCalled, `key=${key} should pass`).to.equal(true);
    }
  });
});

// ─── makeRateLimit ──────────────────────────────────────────────

describe('makeRateLimit', function () {
  it('未超限 → 放行 (next())', function () {
    const middleware = makeRateLimit({ windowMs: 60000, max: 5 });
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    middleware(req as Request, res as unknown as Response, () => { nextCalled = true; });
    expect(nextCalled).to.equal(true);
  });

  it('超限 → 429 RATE_LIMITED', function () {
    const middleware = makeRateLimit({ windowMs: 60000, max: 3 });
    const req = makeReq(); // 同一 IP
    // 发送 3 次（刚好到达上限）
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      let nextCalled = false;
      middleware(req as Request, res as unknown as Response, () => { nextCalled = true; });
      expect(nextCalled, `request ${i + 1} should pass`).to.equal(true);
    }
    // 第 4 次超限
    const res = makeRes();
    let nextCalled = false;
    middleware(req as Request, res as unknown as Response, () => { nextCalled = true; });
    expect(nextCalled).to.equal(false);
    expect(res._status).to.equal(429);
    const body = res._body as { error: { code: string } };
    expect(body.error.code).to.equal('RATE_LIMITED');
  });

  it('不同 key/IP 各自独立计数', function () {
    const middleware = makeRateLimit({ windowMs: 60000, max: 1 });
    const makeKeyReq = (key: string) => makeReq({
      header: (name: string) => name === 'x-api-key' ? key : undefined,
    } as Partial<Request>);

    // key-x 消耗 1 次（刚好到上限）
    const r1 = makeRes();
    let n1 = false;
    middleware(makeKeyReq('key-x') as Request, r1 as unknown as Response, () => { n1 = true; });
    expect(n1).to.equal(true);

    // key-y 独立桶，第 1 次仍应放行
    const r2 = makeRes();
    let n2 = false;
    middleware(makeKeyReq('key-y') as Request, r2 as unknown as Response, () => { n2 = true; });
    expect(n2).to.equal(true);

    // key-x 再次请求超限
    const r3 = makeRes();
    let n3 = false;
    middleware(makeKeyReq('key-x') as Request, r3 as unknown as Response, () => { n3 = true; });
    expect(n3).to.equal(false);
    expect(r3._status).to.equal(429);
  });

  it('LRU 容量上限不崩溃（maxTrackedKeys=10）', function () {
    const middleware = makeRateLimit({ windowMs: 60000, max: 100, maxTrackedKeys: 10 });
    // 插入 20 个不同 IP，不应抛错
    for (let i = 0; i < 20; i++) {
      const req = makeReq({ ip: `10.0.0.${i}` } as Partial<Request>);
      const res = makeRes();
      middleware(req as Request, res as unknown as Response, () => { /* ok */ });
    }
    // 只要不抛错，测试通过
    expect(true).to.equal(true);
  });
});

// ─── sendError ──────────────────────────────────────────────────

describe('sendError', function () {
  it('响应体不含原始 error.message', function () {
    const res = makeRes();
    sendError(res as unknown as Response, 500, 'INTERNAL_ERROR', new Error('super secret details'));
    expect(res._status).to.equal(500);
    const body = res._body as { error: { code: string; requestId: string } };
    expect(body.error.code).to.equal('INTERNAL_ERROR');
    expect(body.error.requestId).to.be.a('string');
    // 不应泄露原始 message
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.to.include('super secret details');
  });

  it('响应体含 code 和 requestId', function () {
    const res = makeRes();
    sendError(res as unknown as Response, 401, 'UNAUTHORIZED');
    const body = res._body as { error: { code: string; requestId: string } };
    expect(body.error.code).to.equal('UNAUTHORIZED');
    expect(body.error.requestId).to.match(/^req-\d+-\d+$/);
  });

  it('多次调用 requestId 不重复', function () {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      sendError(res as unknown as Response, 500, 'ERR');
      const body = res._body as { error: { code: string; requestId: string } };
      ids.push(body.error.requestId);
    }
    const unique = new Set(ids);
    expect(unique.size).to.equal(5);
  });
});
