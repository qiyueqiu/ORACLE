/**
 * RouterAgent 单元测试（ESM + TypeScript）
 * 覆盖 parseIntent / getCandidateAgents / evaluateCandidates / makeDecision / route
 * 通过 instance-level axios-mock-adapter 拦截 SiliconFlow HTTP 调用
 *
 * NOTE: The original CJS test used sinon.stub(ethers, 'JsonRpcProvider') to prevent
 * a real provider from being created. In ESM, named module exports are read-only live
 * bindings and cannot be stubbed via sinon. Instead, we pass a real (unconnected)
 * provider URL and immediately overwrite router.contracts via (router as any).contracts
 * after construction — the provider is never called during these unit tests.
 */
import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { RouterAgent, ruleScore, clampScore } from '../src/router-agent.js';
import { SiliconFlowClient } from '../src/siliconflow-client.js';
import type { Candidate } from '../src/types.js';

const SF_URL = 'https://api.siliconflow.cn/v1/chat/completions';

describe('agents/router-agent', function () {
  let router: RouterAgent;
  let mock: InstanceType<typeof MockAdapter>;
  let sfInstance: ReturnType<typeof axios.create>;
  let mockAgentDID: {
    agentCount: sinon.SinonStub;
    agentList: sinon.SinonStub;
    agents: sinon.SinonStub;
  };
  let mockReputation: {
    getReputation: sinon.SinonStub;
  };

  beforeEach(function () {
    mockAgentDID = {
      agentCount: sinon.stub(),
      agentList: sinon.stub(),
      agents: sinon.stub(),
    };
    mockReputation = {
      getReputation: sinon.stub(),
    };

    sfInstance = axios.create();
    mock = new MockAdapter(sfInstance);

    router = new RouterAgent(
      'test-key',
      'http://localhost:8545',
      { AgentDID: '0xAgentDID', AuditLog: '0xAuditLog', Reputation: '0xReputation' },
      new SiliconFlowClient('test-key', sfInstance),
    );
    // contracts is private in TS; overwrite via any to inject mocks
    (router as any).contracts = {
      agentDID: mockAgentDID,
      reputation: mockReputation,
    };
  });

  afterEach(function () {
    sinon.restore();
    mock.restore();
  });

  describe('parseIntent', function () {
    it('Should return LLM-parsed intent on success', async function () {
      mock.onPost(SF_URL).reply(200, {
        choices: [{ message: { content: '{"intent":"code review","requiredQualification":"code_review","complexity":"simple","priority":"quality"}' } }],
        usage: { total_tokens: 20 },
      });

      const intent = await router.parseIntent('帮我审查代码');
      expect(intent.intent).to.equal('code review');
      expect(intent.requiredQualification).to.equal('code_review');
    });

    it('Should fall back to keyword matching on LLM failure', async function () {
      mock.onPost(SF_URL).networkError();

      const intent = await router.parseIntent('请帮我翻译这段英文');
      expect(intent.requiredQualification).to.equal('translation');
      expect(intent.intent).to.equal('请帮我翻译这段英文');
    });

    it("Should default to 'content' for unknown keywords", async function () {
      mock.onPost(SF_URL).networkError();

      const intent = await router.parseIntent('随机随机完全无法识别');
      expect(intent.requiredQualification).to.equal('content');
    });
  });

  describe('getCandidateAgents', function () {
    it('Should return only active agents with reputation', async function () {
      mockAgentDID.agentCount.resolves(2n);
      mockAgentDID.agentList
        .onCall(0).resolves('0xAgent1')
        .onCall(1).resolves('0xAgent2');
      mockAgentDID.agents
        .onCall(0).resolves({ address: '0xAgent1', did: 'did:1', commitment: '0xcommit', qualificationType: 'code_review', isActive: true, registeredAt: 1000n })
        .onCall(1).resolves({ address: '0xAgent2', did: 'did:2', commitment: '0xcommit2', qualificationType: 'code_review', isActive: false, registeredAt: 2000n });
      mockReputation.getReputation
        .onCall(0).resolves({ totalRating: 100n, ratingCount: 1n, averageRating: 80n, lastUpdated: 0n })
        .onCall(1).resolves({ totalRating: 0n, ratingCount: 0n, averageRating: 0n, lastUpdated: 0n });

      const candidates = await router.getCandidateAgents('code_review');
      expect(candidates).to.have.length(1);
      expect(candidates[0].address).to.equal('0xAgent1');
      expect(candidates[0].avgRating).to.equal(80);
    });

    it('Should return empty array when no agents', async function () {
      mockAgentDID.agentCount.resolves(0n);
      const candidates = await router.getCandidateAgents('any');
      expect(candidates).to.deep.equal([]);
    });
  });

  describe('evaluateCandidates', function () {
    it('Should return LLM-evaluated candidates with score', async function () {
      mock.onPost(SF_URL).reply(200, {
        choices: [{ message: { content: '{"rankings":[{"index":0,"score":90,"reason":"best"},{"index":1,"score":50,"reason":"ok"}],"decision":"Choose 0xA"}' } }],
        usage: { total_tokens: 10 },
      });

      const candidates: Candidate[] = [
        { address: '0xA', did: 'a', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 0 },
        { address: '0xB', did: 'b', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 0 },
      ];
      const { candidates: ranked, decision } = await router.evaluateCandidates(
        candidates, { intent: 'test', requiredQualification: 'code_review', complexity: 'simple', priority: 'quality' }, 'code_review',
      );
      expect(ranked[0].address).to.equal('0xA');
      expect(ranked[0].score).to.equal(90);
      expect(decision).to.equal('Choose 0xA');
    });

    it('Should fall back to rule-based scoring on LLM failure', async function () {
      mock.onPost(SF_URL).networkError();

      const candidates: Candidate[] = [
        { address: '0xA', did: 'agentA', qualification: 'code_review', avgRating: 90, ratingCount: 1, isActive: true, score: 0 },
        { address: '0xB', did: 'agentB', qualification: 'code_review', avgRating: 60, ratingCount: 1, isActive: true, score: 0 },
      ];
      const { candidates: ranked, decision } = await router.evaluateCandidates(
        candidates, { requiredQualification: 'code_review', intent: '', complexity: 'simple', priority: 'quality' }, 'code_review',
      );
      expect(ranked.length).to.equal(2);
      expect(decision).to.be.a('string');
      expect(decision.length).to.be.greaterThan(0);
    });

    // 改造 9：论文公式 (3) 与代码严格一致 —— 百分制 0-100 信誉缩放到 0-40
    it('Fallback rule-based score should use 0.6*q + 0.4*(avgRating*0.4) for 0-100 scale', async function () {
      mock.onPost(SF_URL).networkError();
      const candidates: Candidate[] = [
        { address: '0xA', did: 'agentA', qualification: 'code_review', avgRating: 100, ratingCount: 1, isActive: true, score: 0 },
        { address: '0xB', did: 'agentB', qualification: 'content',     avgRating: 0,   ratingCount: 1, isActive: true, score: 0 },
      ];
      const { candidates: ranked } = await router.evaluateCandidates(
        candidates, { requiredQualification: 'code_review', intent: '', complexity: 'simple', priority: 'quality' }, 'code_review',
      );
      // 0xA: 匹配资质 q=60, rNorm=40 -> 0.6*60+0.4*40 = 36+16 = 52
      // 0xB: 不匹配 q=40, rNorm=0   -> 0.6*40+0.4*0  = 24+0  = 24
      const a = ranked.find((c) => c.address === '0xA');
      const b = ranked.find((c) => c.address === '0xB');
      expect(a!.score).to.be.closeTo(52, 0.001);
      expect(b!.score).to.be.closeTo(24, 0.001);
      expect(ranked[0].address).to.equal('0xA');
    });
  });

  describe('makeDecision', function () {
    it('Should pick the top-ranked candidate', async function () {
      const candidates: Candidate[] = [
        { address: '0xA', did: 'a', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 90 },
        { address: '0xB', did: 'b', qualification: 'code_review', avgRating: 0, ratingCount: 0, isActive: true, score: 50 },
      ];
      const result = await router.makeDecision(candidates, 'test reason');
      expect(result.agent.address).to.equal('0xA');
      expect(result.reason).to.equal('test reason');
    });
  });

  describe('route (end-to-end with stubs)', function () {
    it('Should throw when no candidates (route-level check)', async function () {
      mock.onPost(SF_URL).reply(200, {
        choices: [{ message: { content: '{"intent":"x","requiredQualification":"code_review","complexity":"simple","priority":"quality"}' } }],
        usage: { total_tokens: 5 },
      });
      mockAgentDID.agentCount.resolves(0n);

      try {
        await router.route('test');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as Error).message).to.match(/候选|Agent|candidates/i);
      }
    });

    it('Should return selected agent and executionLog', async function () {
      mock.onPost(SF_URL).reply(200, {
        choices: [{ message: { content: '{"intent":"x","requiredQualification":"code_review","complexity":"simple","priority":"quality","rankings":[{"index":0,"score":90,"reason":"best"}],"decision":"ok"}' } }],
        usage: { total_tokens: 5 },
      });

      mockAgentDID.agentCount.resolves(1n);
      mockAgentDID.agentList.resolves('0xAgent1');
      mockAgentDID.agents.resolves({ address: '0xAgent1', did: 'did:1', commitment: '0xcommit', qualificationType: 'code_review', isActive: true, registeredAt: 1000n });
      mockReputation.getReputation.resolves({ totalRating: 100n, ratingCount: 1n, averageRating: 80n, lastUpdated: 0n });

      const result = await router.route('帮我审查代码');
      expect(result.agent.address).to.equal('0xAgent1');
      expect(result.reason).to.be.a('string');
      expect(result.executionLog).to.be.an('array');
    });
  });

  // P1-C4：确定性评分 —— 消除 Math.random 兜底后，评分必须可复现
  describe('ruleScore / clampScore (P1-C4 deterministic scoring)', function () {
    const mk = (qualification: string, avgRating: number): Candidate => ({
      address: '0xX',
      did: 'did:x',
      qualification,
      avgRating,
      ratingCount: 1,
      isActive: true,
      score: 0,
    });

    it('ruleScore matches paper formula 0.6q+0.4rNorm for qualification match', function () {
      // q=60, rNorm=80*0.4=32 → 0.6*60 + 0.4*32 = 36 + 12.8 = 48.8
      expect(ruleScore(mk('code_review', 80), 'code_review')).to.be.closeTo(48.8, 1e-9);
    });

    it('ruleScore uses q=40 for qualification mismatch', function () {
      // q=40, rNorm=80*0.4=32 → 0.6*40 + 0.4*32 = 24 + 12.8 = 36.8
      expect(ruleScore(mk('translation', 80), 'code_review')).to.be.closeTo(36.8, 1e-9);
    });

    it('ruleScore is deterministic (same input → same output across calls)', function () {
      const c = mk('code_review', 73);
      const first = ruleScore(c, 'code_review');
      for (let i = 0; i < 100; i++) {
        expect(ruleScore(c, 'code_review')).to.equal(first);
      }
    });

    it('ruleScore ranks a qualification-matched high-rep candidate highest', function () {
      const match = ruleScore(mk('code_review', 90), 'code_review'); // 36 + 14.4 = 50.4
      const mismatch = ruleScore(mk('weather', 90), 'code_review'); // 24 + 14.4 = 38.4
      const matchLowRep = ruleScore(mk('code_review', 10), 'code_review'); // 36 + 1.6 = 37.6
      expect(match).to.be.greaterThan(mismatch);
      expect(match).to.be.greaterThan(matchLowRep);
    });

    it('clampScore bounds LLM-returned scores to [0,100]', function () {
      expect(clampScore(150)).to.equal(100);
      expect(clampScore(-20)).to.equal(0);
      expect(clampScore(73)).to.equal(73);
      // 非有限值（NaN/Infinity）视为异常输入，归 0（异常值不应获得高分）
      expect(clampScore(NaN)).to.equal(0);
      expect(clampScore(Infinity)).to.equal(0);
      expect(clampScore(-Infinity)).to.equal(0);
    });
  });
});
