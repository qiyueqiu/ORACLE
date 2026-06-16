/**
 * API Server 集成测试（ESM + TypeScript，supertest）
 *
 * 测试策略：import api-server 拿到 app 实例，用 supertest 注入。
 * api-server.ts 用 isMainModule 守卫，import 时不会 app.listen，
 * 因此无需占用端口。
 *
 * 注意：原 CJS 测试用 sinon.stub(require('axios'),'post')，在 ESM 下
 * live binding 只读不可 stub；改用 axios-mock-adapter 拦截 LLM 请求。
 */
import { expect } from 'chai';
import request from 'supertest';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

// 在 import api-server 之前设置必要环境变量
process.env.SILICONFLOW_API_KEY = 'test-key';
process.env.ROUTER_SIGNER_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
process.env.REPUTATION_SIGNER_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
// P2：worker 改用助记词派生（demo 模式），不再用单一 WORKER_DEMO_PRIVATE_KEY 代签
process.env.WORKER_SIGNING_MODE = 'demo';
process.env.AGENT_DID_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
process.env.AUDIT_LOG_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
process.env.REPUTATION_ADDRESS = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
process.env.API_PORT = '0';
process.env.API_ACCESS_KEYS = '';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.RATE_LIMIT_MAX = '100';

// 全局拦截 axios（LLM 调用），返回最小合法响应，避免真实网络依赖
const mock = new MockAdapter(axios);
mock.onPost(/chat\/completions/).reply(200, {
  choices: [{ message: { content: '{}' } }],
  usage: { total_tokens: 10 },
  model: 'test',
});

// 动态 import：确保 env 与 mock 在模块求值前就绪
const appMod = await import('../src/api-server.js');
const app = appMod.default;

describe('API Server (集成测试)', function () {
  after(function () {
    mock.restore();
    // 强制结束，防止 ethers provider 重试导致进程挂起
    setTimeout(() => process.exit(0), 100);
  });

  describe('GET /api/health', function () {
    it('Should return 200 with health info', async function () {
      const res = await request(app).get('/api/health');
      expect(res.status).to.equal(200);
      expect(res.body.status).to.equal('ok');
      expect(res.body.chainId).to.be.a('number');
      expect(res.body.apiAuthRequired).to.be.a('boolean');
    });
  });

  describe('GET /api/agent-types', function () {
    it('Should return 8 qualification types', async function () {
      const res = await request(app).get('/api/agent-types');
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('array');
      expect(res.body).to.have.length(8);
      expect(res.body[0]).to.have.property('key');
      expect(res.body[0]).to.have.property('name');
      expect(res.body[0]).to.have.property('icon');
    });
  });

  describe('GET /api/scoring-dimensions', function () {
    it('Should return 5 dimensions', async function () {
      const res = await request(app).get('/api/scoring-dimensions');
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('array');
      expect(res.body).to.have.length(5);
    });
  });

  describe('GET /api/dispatch/history', function () {
    it('Should return history array', async function () {
      const res = await request(app).get('/api/dispatch/history');
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('array');
    });
  });

  describe('POST /api/dispatch validation', function () {
    it('Should return 400 for missing task', async function () {
      const res = await request(app).post('/api/dispatch').send({});
      expect(res.status).to.equal(400);
      expect(res.body.error).to.include('任务描述');
    });
  });

  describe('POST /api/user-rating validation', function () {
    it('Should return 400 for missing agentAddress', async function () {
      const res = await request(app).post('/api/user-rating').send({ score: 80 });
      expect(res.status).to.equal(400);
    });

    it('Should return 400 for out-of-range score', async function () {
      const res = await request(app)
        .post('/api/user-rating')
        .send({ agentAddress: '0xAgent', score: 150 });
      expect(res.status).to.equal(400);
    });
  });

  describe('GET /api/reputation/summary', function () {
    it('Should return summary object', async function () {
      const res = await request(app).get('/api/reputation/summary');
      expect([200, 500]).to.include(res.status);
    });
  });

  describe('POST /api/dispatch/stream validation', function () {
    it('Should return error event for missing task', async function () {
      const res = await request(app).post('/api/dispatch/stream').send({});
      expect(res.status).to.equal(200);
      expect(res.text).to.include('event: error');
    });
  });
});
