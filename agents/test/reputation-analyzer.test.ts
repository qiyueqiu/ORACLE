/**
 * ReputationAnalyzerAgent 单元测试（ESM + TypeScript）
 * 覆盖: analyzeExecutionTrace / calculateTrend / fullAnalysis
 *
 * 用 instance-level axios-mock-adapter。private 成员（contracts/signer）
 * 通过 (analyzer as any) 注入 mock。
 */
import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { ReputationAnalyzerAgent, SCORING_DIMENSIONS } from '../src/reputation-analyzer.js';
import { SiliconFlowClient } from '../src/siliconflow-client.js';

const SF_URL = 'https://api.siliconflow.cn/v1/chat/completions';

describe('agents/reputation-analyzer', function () {
  let analyzer: ReputationAnalyzerAgent;
  let mock: MockAdapter;
  let sfInstance: ReturnType<typeof axios.create>;
  let mockSigner: { address: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockReputation: any;

  beforeEach(function () {
    mockSigner = { address: '0xSigner' };
    mockReputation = {
      connect: sinon.stub().returnsThis(),
      addRating: sinon.stub().resolves({ wait: () => Promise.resolve({ hash: '0xHash' }) }),
      applyPenalty: sinon.stub().resolves({ wait: () => Promise.resolve({ hash: '0xHash' }) }),
      getAverageRating: sinon.stub().resolves(80),
      isReliable: sinon.stub().resolves(true),
    };

    sfInstance = axios.create();
    mock = new MockAdapter(sfInstance);

    analyzer = new ReputationAnalyzerAgent(
      'k',
      'http://localhost:8545',
      { AgentDID: '0xA', AuditLog: '0xAL', Reputation: '0xR' },
      new SiliconFlowClient('k', sfInstance),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (analyzer as any).contracts.reputation = mockReputation;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (analyzer as any).signer = mockSigner;
  });

  afterEach(function () {
    sinon.restore();
    mock.restore();
  });

  describe('analyzeExecutionTrace', function () {
    it('Should return LLM-analyzed result on success', async function () {
      mock.onPost(SF_URL).reply(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                dimensions: {
                  accuracy: { score: 28, reason: 'good' },
                  completeness: { score: 22, reason: 'ok' },
                  professionalism: { score: 18, reason: 'deep' },
                  practicality: { score: 13, reason: 'useful' },
                  clarity: { score: 9, reason: 'clear' },
                },
                totalScore: 90,
                quality: 'excellent',
                taskCompleted: true,
                summary: 'task done well',
                strengths: ['good'],
                weaknesses: ['x'],
                suggestions: ['y'],
                shouldPenalty: false,
                penaltyReason: '',
              }),
            },
          },
        ],
        usage: { total_tokens: 50 },
      });
      const r = await analyzer.analyzeExecutionTrace({
        task: 'test',
        selectedAgent: { did: 'd1', address: '0xA1', qualification: 'code_review' },
        executionResult: 'result here is long enough to be considered valid',
        chainOfThought: 'thought',
      });
      expect(r.totalScore).to.equal(90);
      expect(r.quality).to.equal('excellent');
    });

    it('Should fall back to length-based scoring on LLM failure (long content)', async function () {
      mock.onPost(SF_URL).networkError();
      const r = await analyzer.analyzeExecutionTrace({
        task: 'test',
        selectedAgent: { did: 'd1', address: '0xA1', qualification: 'code_review' },
        executionResult: 'x'.repeat(100),
        chainOfThought: '',
      });
      expect(r.totalScore).to.equal(60);
      expect(r.quality).to.equal('acceptable');
      expect(r.taskCompleted).to.be.true;
      expect(r.shouldPenalty).to.be.false;
    });

    it('Should fall back to low score for empty result', async function () {
      mock.onPost(SF_URL).networkError();
      const r = await analyzer.analyzeExecutionTrace({
        task: 'test',
        selectedAgent: { did: 'd1', address: '0xA1', qualification: 'code_review' },
        executionResult: '',
        chainOfThought: '',
      });
      expect(r.totalScore).to.equal(25);
      expect(r.quality).to.equal('failing');
      expect(r.shouldPenalty).to.be.true;
    });

    it('Should recompute totalScore from dimensions if LLM-provided total is wrong', async function () {
      mock.onPost(SF_URL).reply(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                dimensions: {
                  accuracy: { score: 30, reason: '' },
                  completeness: { score: 25, reason: '' },
                  professionalism: { score: 20, reason: '' },
                  practicality: { score: 15, reason: '' },
                  clarity: { score: 10, reason: '' },
                },
                totalScore: 999,
                quality: '',
                taskCompleted: true,
              }),
            },
          },
        ],
        usage: { total_tokens: 0 },
      });
      const r = await analyzer.analyzeExecutionTrace({
        task: 't',
        selectedAgent: { did: 'd', address: '0xA1', qualification: 'x' },
        executionResult: 'long enough content for valid analysis here',
      });
      expect(r.totalScore).to.equal(100);
    });
  });

  describe('calculateTrend', function () {
    // calculateTrend 是 private 方法，通过 (analyzer as any) 访问
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trend = (rec: { rating: number }[]): string => (analyzer as any).calculateTrend(rec);

    it("Should return 'new' for < 2 records", function () {
      expect(trend([])).to.equal('new');
      expect(trend([{ rating: 80 }])).to.equal('new');
    });

    it("Should return 'new' when no older records to compare", function () {
      expect(trend([{ rating: 80 }, { rating: 85 }])).to.equal('new');
    });

    it("Should return 'improving' when recent avg > older avg + 10", function () {
      const rec = [
        { rating: 50 },
        { rating: 50 },
        { rating: 50 },
        { rating: 80 },
        { rating: 80 },
        { rating: 80 },
      ];
      expect(trend(rec)).to.equal('improving');
    });

    it("Should return 'declining' when recent avg < older avg - 10", function () {
      const rec = [
        { rating: 90 },
        { rating: 90 },
        { rating: 90 },
        { rating: 50 },
        { rating: 50 },
        { rating: 50 },
      ];
      expect(trend(rec)).to.equal('declining');
    });

    it("Should return 'stable' when within ±10", function () {
      const rec = [{ rating: 80 }, { rating: 80 }, { rating: 82 }, { rating: 82 }];
      expect(trend(rec)).to.equal('stable');
    });
  });

  describe('fullAnalysis', function () {
    it('Should call submitRatingOnChain and skip penalty for high score', async function () {
      mock.onPost(SF_URL).reply(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                dimensions: {
                  accuracy: { score: 30, reason: '' },
                  completeness: { score: 25, reason: '' },
                  professionalism: { score: 20, reason: '' },
                  practicality: { score: 15, reason: '' },
                  clarity: { score: 10, reason: '' },
                },
                totalScore: 100,
                quality: 'excellent',
                taskCompleted: true,
                shouldPenalty: false,
                penaltyReason: '',
              }),
            },
          },
        ],
        usage: { total_tokens: 0 },
      });
      const r = await analyzer.fullAnalysis({
        task: 't',
        selectedAgent: { address: '0xAgent', did: 'd', qualification: 'x' },
        executionResult: 'good result long enough here',
      });
      expect(r.analysis.totalScore).to.equal(100);
      expect(r.ratingResult.success).to.be.true;
      expect(r.penaltyResult).to.be.null;
    });

    it('Should apply penalty for very low score (shouldPenalty=true, score<20)', async function () {
      mock.onPost(SF_URL).reply(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                dimensions: {
                  accuracy: { score: 5, reason: '' },
                  completeness: { score: 5, reason: '' },
                  professionalism: { score: 5, reason: '' },
                  practicality: { score: 3, reason: '' },
                  clarity: { score: 2, reason: '' },
                },
                totalScore: 20,
                quality: 'failing',
                taskCompleted: false,
                shouldPenalty: true,
                penaltyReason: 'low quality',
              }),
            },
          },
        ],
        usage: { total_tokens: 0 },
      });
      const r = await analyzer.fullAnalysis({
        task: 't',
        selectedAgent: { address: '0xAgent', did: 'd', qualification: 'x' },
        executionResult: 'poor',
      });
      expect(r.analysis.shouldPenalty).to.be.true;
      expect(r.penaltyResult).to.not.be.null;
    });
  });

  describe('SCORING_DIMENSIONS', function () {
    it('Should expose 5 dimensions', function () {
      expect(SCORING_DIMENSIONS).to.have.length(5);
      const total = SCORING_DIMENSIONS.reduce((s, d) => s + d.maxScore, 0);
      expect(total).to.equal(100);
    });
  });
});
