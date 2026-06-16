/**
 * WorkerAgent / WorkerAgents 单元测试（ESM + TypeScript）
 * 覆盖: buildPrompt / selectModel / chatWithChainOfThought / execute
 *
 * 用 instance-level axios-mock-adapter
 */
import { expect } from 'chai';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { WorkerAgent, QUALIFICATION_CONFIG } from '../src/worker-agents.js';
import { SiliconFlowClient } from '../src/siliconflow-client.js';

const SF_URL = 'https://api.siliconflow.cn/v1/chat/completions';

describe('agents/worker-agents', function () {
  let mock: InstanceType<typeof MockAdapter>;
  let sfInstance: ReturnType<typeof axios.create>;

  beforeEach(function () {
    sfInstance = axios.create();
    mock = new MockAdapter(sfInstance);
  });

  afterEach(function () {
    mock.restore();
  });

  describe('selectModel', function () {
    it('Should pick simple model for short tasks', function () {
      const info = { did: 'test', address: '0x1', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 0 };
      const w = new WorkerAgent('k', info);
      // selectModel is private; access via any
      const model = (w as any).selectModel('hello world') as string;
      expect(model).to.equal('Qwen/Qwen2.5-7B-Instruct');
    });

    it('Should pick complex model for long tasks', function () {
      const info = { did: 'test', address: '0x1', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 0 };
      const w = new WorkerAgent('k', info);
      const longTask = '请分析这段非常长的代码'.repeat(30);
      const model = (w as any).selectModel(longTask) as string;
      expect(model).to.equal('deepseek-ai/DeepSeek-V3');
    });

    it('Should pick complex model for tasks containing 分析/计算/创作', function () {
      const info = { did: 'test', address: '0x1', qualification: 'data_analysis', avgRating: 0, ratingCount: 0, isActive: true, score: 0 };
      const w = new WorkerAgent('k', info);
      const model = (w as any).selectModel('数据分析') as string;
      expect(model).to.equal('deepseek-ai/DeepSeek-V3');
    });
  });

  describe('buildPrompt', function () {
    it('Should include task description', function () {
      const info = { did: 'test', address: '0x1', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 0 };
      const w = new WorkerAgent('k', info);
      const prompt = (w as any).buildPrompt('审计代码', {}) as string;
      expect(prompt).to.include('审计代码');
      expect(prompt).to.include(QUALIFICATION_CONFIG.code_review.systemPrompt);
    });

    it('Should include context when selectedAgent provided', function () {
      const info = { did: 'test', address: '0x1', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 0 };
      const w = new WorkerAgent('k', info);
      const prompt = (w as any).buildPrompt('test', { selectedAgent: '0x1', reputation: 85 }) as string;
      expect(prompt).to.include('信誉评分: 85');
    });
  });

  describe('chatWithChainOfThought', function () {
    it('Should parse <思考> and <结果> tags', async function () {
      mock.onPost(SF_URL).reply(200, {
        choices: [{ message: { content: '<思考>让我想想</思考><结果>最终答案</结果>' } }],
        usage: { total_tokens: 10 },
        model: 'm',
      });
      const info = { did: 'test', address: '0x1', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 0 };
      const w = new WorkerAgent('k', info, new SiliconFlowClient('k', sfInstance));
      const r = await (w as any).chatWithChainOfThought('m', 'test') as { chainOfThought: string; content: string };
      expect(r.chainOfThought).to.equal('让我想想');
    });

    it('Should return raw content when no tags', async function () {
      mock.onPost(SF_URL).reply(200, {
        choices: [{ message: { content: 'no tags here' } }],
        usage: { total_tokens: 5 },
        model: 'm',
      });
      const info = { did: 'test', address: '0x1', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 0 };
      const w = new WorkerAgent('k', info, new SiliconFlowClient('k', sfInstance));
      const r = await (w as any).chatWithChainOfThought('m', 'test') as { chainOfThought: string; content: string };
      expect(r.chainOfThought).to.equal('');
      expect(r.content).to.equal('no tags here');
    });
  });

  describe('execute', function () {
    it('Should return result and chainOfThought', async function () {
      mock.onPost(SF_URL).reply(200, {
        choices: [{ message: { content: '<思考>analyze</思考><结果>completed</结果>' } }],
        usage: { total_tokens: 50 },
        model: 'm',
      });
      const info = { did: 'did:codeReview1', address: '0xAgent1', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 0 };
      const w = new WorkerAgent('k', info, new SiliconFlowClient('k', sfInstance));
      const r = await w.execute('audit code', { selectedAgent: 'did:codeReview1', reputation: 90 });
      expect(r.result).to.equal('completed');
      expect(r.chainOfThought).to.equal('analyze');
      expect(r.tokens).to.equal(50);
      expect(r.agentType).to.equal('code_review');
    });

    it('Should propagate LLM errors', async function () {
      mock.onPost(SF_URL).networkError();
      const info = { did: 'x', address: '0x1', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 0 };
      const w = new WorkerAgent('k', info, new SiliconFlowClient('k', sfInstance));
      try {
        await w.execute('x');
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).to.match(/Network Error|SiliconFlow/);
      }
    });
  });

  describe('QUALIFICATION_CONFIG', function () {
    it('Should define 8 qualification types', function () {
      expect(Object.keys(QUALIFICATION_CONFIG)).to.have.length(8);
      expect(QUALIFICATION_CONFIG.code_review).to.exist;
      expect(QUALIFICATION_CONFIG.data_analysis).to.exist;
      expect(QUALIFICATION_CONFIG.translation).to.exist;
      expect(QUALIFICATION_CONFIG.research).to.exist;
      expect(QUALIFICATION_CONFIG.creative).to.exist;
      expect(QUALIFICATION_CONFIG.weather).to.exist;
      expect(QUALIFICATION_CONFIG.content).to.exist;
      expect(QUALIFICATION_CONFIG.calc).to.exist;
    });

    it('Each type should have name, icon, systemPrompt', function () {
      for (const cfg of Object.values(QUALIFICATION_CONFIG)) {
        expect(cfg.name).to.be.a('string');
        expect(cfg.icon).to.be.a('string');
        expect(cfg.systemPrompt).to.be.a('string');
      }
    });
  });
});
