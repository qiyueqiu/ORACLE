/**
 * SiliconFlowClient 单元测试（ESM + TypeScript）
 * 覆盖 chat / chatWithJson happy path 与错误处理
 *
 * 用 instance-level axios + axios-mock-adapter 拦截，避免 axios 1.16 fetch adapter
 * 兼容性问题（全局 mock adapter 会被 fetch adapter 绕过）
 */
import { expect } from 'chai';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { SiliconFlowClient } from '../src/siliconflow-client.js';

describe('agents/siliconflow-client', function () {
  let client: SiliconFlowClient;
  let mock: InstanceType<typeof MockAdapter>;
  let instance: ReturnType<typeof axios.create>;

  beforeEach(function () {
    instance = axios.create();
    mock = new MockAdapter(instance);
    // 默认关重试:多数用例只验证成功/错误传播,不应被退避拖慢。
    client = new SiliconFlowClient('test-api-key', instance, undefined, { maxRetries: 0 });
  });

  afterEach(function () {
    mock.restore();
  });

  describe('chat()', function () {
    it('Should return content and usage on success', async function () {
      mock.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(200, {
        choices: [{ message: { content: 'Hello, world!' } }],
        usage: { total_tokens: 10 },
        model: 'model-x',
      });

      const result = await client.chat('model-x', [{ role: 'user', content: 'hi' }]);
      expect(result.content).to.equal('Hello, world!');
      expect(result.usage.total_tokens).to.equal(10);
      expect(result.model).to.equal('model-x');
    });

    it('Should pass model, messages, temperature, max_tokens to API', async function () {
      let capturedBody: Record<string, unknown> | null = null;
      mock.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(function (config) {
        capturedBody = JSON.parse(config.data as string) as Record<string, unknown>;
        return [200, { choices: [{ message: { content: 'ok' } }], usage: {} }];
      });

      await client.chat('m', [{ role: 'user', content: 'x' }], { temperature: 0.7, max_tokens: 100 });
      expect(capturedBody!.model).to.equal('m');
      expect(capturedBody!.temperature).to.equal(0.7);
      expect(capturedBody!.max_tokens).to.equal(100);
    });

    it('Should NOT include enable_thinking by default', async function () {
      let capturedBody: Record<string, unknown> | null = null;
      mock.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(function (config) {
        capturedBody = JSON.parse(config.data as string) as Record<string, unknown>;
        return [200, { choices: [{ message: { content: 'ok' } }], usage: {} }];
      });

      await client.chat('m', [{ role: 'user', content: 'x' }]);
      expect(capturedBody!).to.not.have.property('enable_thinking');
    });

    it('Should inject enable_thinking=false when disableThinking is set', async function () {
      const inst = axios.create();
      const m = new MockAdapter(inst);
      const thinkOffClient = new SiliconFlowClient('k', inst, undefined, { disableThinking: true });
      let capturedBody: Record<string, unknown> | null = null;
      m.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(function (config) {
        capturedBody = JSON.parse(config.data as string) as Record<string, unknown>;
        return [200, { choices: [{ message: { content: 'ok' } }], usage: {} }];
      });

      await thinkOffClient.chat('m', [{ role: 'user', content: 'x' }]);
      expect(capturedBody!.enable_thinking).to.equal(false);
      m.restore();
    });

    it('Should pass extraBody fields through to the request', async function () {
      let capturedBody: Record<string, unknown> | null = null;
      mock.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(function (config) {
        capturedBody = JSON.parse(config.data as string) as Record<string, unknown>;
        return [200, { choices: [{ message: { content: 'ok' } }], usage: {} }];
      });

      await client.chat('m', [{ role: 'user', content: 'x' }], { extraBody: { enable_thinking: false } });
      expect(capturedBody!.enable_thinking).to.equal(false);
    });

    it('Should propagate network errors', async function () {
      mock.onPost('https://api.siliconflow.cn/v1/chat/completions').networkError();

      try {
        await client.chat('m', [{ role: 'user', content: 'x' }]);
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as Error).message).to.match(/Network Error|ECONNREFUSED/i);
      }
    });

    it('Should propagate API errors (4xx/5xx)', async function () {
      mock.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(401, { error: 'invalid api key' });

      try {
        await client.chat('m', [{ role: 'user', content: 'x' }]);
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).to.include('SiliconFlow API error');
      }
    });

    it('Should retry on 429 then succeed (transient rate-limit)', async function () {
      this.timeout(8000);
      const inst = axios.create();
      const m = new MockAdapter(inst);
      const retryClient = new SiliconFlowClient('k', inst, undefined, { maxRetries: 3 });
      let calls = 0;
      m.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(function () {
        calls++;
        if (calls <= 2) return [429, { error: 'rate limited' }];
        return [200, { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 3 } }];
      });
      const result = await retryClient.chat('m', [{ role: 'user', content: 'x' }]);
      expect(result.content).to.equal('ok');
      expect(calls).to.equal(3); // 两次 429 + 一次成功
    });

    it('Should NOT retry on 4xx semantic errors (e.g. 401)', async function () {
      const inst = axios.create();
      const m = new MockAdapter(inst);
      const retryClient = new SiliconFlowClient('k', inst, undefined, { maxRetries: 3 });
      let calls = 0;
      m.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(function () {
        calls++;
        return [401, { error: 'invalid api key' }];
      });
      try {
        await retryClient.chat('m', [{ role: 'user', content: 'x' }]);
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).to.include('SiliconFlow API error');
      }
      expect(calls).to.equal(1); // 401 非瞬时,不重试
    });

    it('Should give up after maxRetries and throw (persistent 429)', async function () {
      this.timeout(8000);
      const inst = axios.create();
      const m = new MockAdapter(inst);
      const retryClient = new SiliconFlowClient('k', inst, undefined, { maxRetries: 2 });
      let calls = 0;
      m.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(function () {
        calls++;
        return [429, { error: 'rate limited' }];
      });
      try {
        await retryClient.chat('m', [{ role: 'user', content: 'x' }]);
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).to.include('SiliconFlow API error');
      }
      expect(calls).to.equal(3); // 初次 + 2 次重试
    });
  });

  describe('chatWithJson()', function () {
    it('Should parse JSON content', async function () {
      mock.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(200, {
        choices: [{ message: { content: '{"intent":"code","score":90}' } }],
        usage: { total_tokens: 5 },
      });

      const schema = { intent: '', score: 0 };
      const result = await client.chatWithJson('m', [{ role: 'user', content: 'x' }], schema);
      expect((result.data as Record<string, unknown>).intent).to.equal('code');
      expect((result.data as Record<string, unknown>).score).to.equal(90);
    });

    it('Should strip markdown code blocks', async function () {
      mock.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(200, {
        choices: [{ message: { content: '```json\n{"x":1}\n```' } }],
        usage: {},
      });
      const result = await client.chatWithJson('m', [{ role: 'user', content: 'x' }], { x: 0 });
      expect((result.data as Record<string, unknown>).x).to.equal(1);
    });

    it('Should throw on invalid JSON', async function () {
      mock.onPost('https://api.siliconflow.cn/v1/chat/completions').reply(200, {
        choices: [{ message: { content: 'not json at all' } }],
        usage: {},
      });
      try {
        await client.chatWithJson('m', [{ role: 'user', content: 'x' }], { x: 0 });
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).to.match(/JSON|parse/);
      }
    });
  });
});
