/**
 * RouterAgent 单元测试
 * 覆盖 parseIntent / getCandidateAgents / evaluateCandidates / makeDecision / route
 * 通过 instance-level axios-mock-adapter 拦截 SiliconFlow HTTP 调用
 */
const { expect } = require("chai");
const sinon = require("sinon");
const axios = require("axios");
const MockAdapter = require("axios-mock-adapter");
const { RouterAgent } = require("../agents/router-agent");

const SF_URL = "https://api.siliconflow.cn/v1/chat/completions";

describe("agents/router-agent", function () {
    let router;
    let mock, sfInstance;
    let mockAgentDID, mockReputation;

    beforeEach(function () {
        mockAgentDID = {
            agentCount: sinon.stub(),
            agentList: sinon.stub(),
            agents: sinon.stub(),
        };
        mockReputation = {
            getReputation: sinon.stub(),
        };
        const provider = {
            getNetwork: sinon.stub().resolves({ chainId: 31337n }),
        };
        const ethers = require("ethers");
        sinon.stub(ethers, "JsonRpcProvider").returns(provider);

        sfInstance = axios.create();
        mock = new MockAdapter(sfInstance);
        router = new RouterAgent("test-key", "http://localhost:8545", {
            AgentDID: "0xAgentDID",
            Reputation: "0xReputation",
        }, new (require("../agents/siliconflow-client").SiliconFlowClient)("test-key", sfInstance));
        router.contracts.agentDID = mockAgentDID;
        router.contracts.reputation = mockReputation;
    });

    afterEach(function () {
        sinon.restore();
        mock.restore();
    });

    describe("parseIntent", function () {
        it("Should return LLM-parsed intent on success", async function () {
            mock.onPost(SF_URL).reply(200, {
                choices: [{ message: { content: '{"intent":"code review","requiredQualification":"code_review","complexity":"simple","priority":"quality"}' } }],
                usage: { total_tokens: 20 },
            });

            const intent = await router.parseIntent("帮我审查代码");
            expect(intent.intent).to.equal("code review");
            expect(intent.requiredQualification).to.equal("code_review");
        });

        it("Should fall back to keyword matching on LLM failure", async function () {
            mock.onPost(SF_URL).networkError();

            const intent = await router.parseIntent("请帮我翻译这段英文");
            expect(intent.requiredQualification).to.equal("translation");
            expect(intent.intent).to.equal("请帮我翻译这段英文");
        });

        it("Should default to 'content' for unknown keywords", async function () {
            mock.onPost(SF_URL).networkError();

            const intent = await router.parseIntent("随机随机完全无法识别");
            expect(intent.requiredQualification).to.equal("content");
        });
    });

    describe("getCandidateAgents", function () {
        it("Should return only active agents with reputation", async function () {
            mockAgentDID.agentCount.resolves(2n);
            mockAgentDID.agentList
                .onCall(0).resolves("0xAgent1")
                .onCall(1).resolves("0xAgent2");
            mockAgentDID.agents
                .onCall(0).resolves(["0xAgent1", "did:1", "0xcommit", "code_review", true, 1000n])
                .onCall(1).resolves(["0xAgent2", "did:2", "0xcommit2", "code_review", false, 2000n]);
            mockReputation.getReputation
                .onCall(0).resolves([100n, 1n, 80n, 0n])
                .onCall(1).resolves([0n, 0n, 0n, 0n]);

            const candidates = await router.getCandidateAgents("code_review");
            expect(candidates).to.have.length(1);
            expect(candidates[0].address).to.equal("0xAgent1");
            expect(candidates[0].avgRating).to.equal(80);
        });

        it("Should return empty array when no agents", async function () {
            mockAgentDID.agentCount.resolves(0n);
            const candidates = await router.getCandidateAgents("any");
            expect(candidates).to.deep.equal([]);
        });
    });

    describe("evaluateCandidates", function () {
        it("Should return LLM-evaluated candidates with score", async function () {
            mock.onPost(SF_URL).reply(200, {
                choices: [{ message: { content: '{"rankings":[{"index":0,"score":90,"reason":"best"},{"index":1,"score":50,"reason":"ok"}],"decision":"Choose 0xA"}' } }],
                usage: { total_tokens: 10 },
            });

            const candidates = [
                { address: "0xA", did: "a", qualification: "code_review" },
                { address: "0xB", did: "b", qualification: "code_review" },
            ];
            const { candidates: ranked, decision } = await router.evaluateCandidates(
                candidates, { intent: "test", requiredQualification: "code_review" }, "code_review"
            );
            expect(ranked[0].address).to.equal("0xA");
            expect(ranked[0].score).to.equal(90);
            expect(decision).to.equal("Choose 0xA");
        });

        it("Should fall back to rule-based scoring on LLM failure", async function () {
            mock.onPost(SF_URL).networkError();

            const candidates = [
                { address: "0xA", did: "agentA", qualification: "code_review", avgRating: 90 },
                { address: "0xB", did: "agentB", qualification: "code_review", avgRating: 60 },
            ];
            const { candidates: ranked, decision } = await router.evaluateCandidates(
                candidates, { requiredQualification: "code_review" }, "code_review"
            );
            expect(ranked.length).to.equal(2);
            expect(decision).to.be.a("string");
            expect(decision.length).to.be.greaterThan(0);
        });
    });

    describe("makeDecision", function () {
        it("Should pick the top-ranked candidate", async function () {
            const candidates = [
                { address: "0xA", did: "a", qualification: "code_review", score: 90 },
                { address: "0xB", did: "b", qualification: "code_review", score: 50 },
            ];
            const result = await router.makeDecision(candidates, "test reason");
            expect(result.agent.address).to.equal("0xA");
            expect(result.reason).to.equal("test reason");
        });
    });

    describe("route (end-to-end with stubs)", function () {
        it("Should throw when no candidates (route-level check)", async function () {
            mock.onPost(SF_URL).reply(200, {
                choices: [{ message: { content: '{"intent":"x","requiredQualification":"code_review","complexity":"simple","priority":"quality"}' } }],
                usage: { total_tokens: 5 },
            });
            mockAgentDID.agentCount.resolves(0n);

            try {
                await router.route("test");
                expect.fail("Should have thrown");
            } catch (err) {
                expect(err.message).to.match(/候选|Agent|candidates/i);
            }
        });

        it("Should return selected agent and executionLog", async function () {
            mock.onPost(SF_URL).reply(200, {
                choices: [{ message: { content: '{"intent":"x","requiredQualification":"code_review","complexity":"simple","priority":"quality","rankings":[{"index":0,"score":90,"reason":"best"}],"decision":"ok"}' } }],
                usage: { total_tokens: 5 },
            });

            mockAgentDID.agentCount.resolves(1n);
            mockAgentDID.agentList.resolves("0xAgent1");
            mockAgentDID.agents.resolves(["0xAgent1", "did:1", "0xcommit", "code_review", true, 1000n]);
            mockReputation.getReputation.resolves([100n, 1n, 80n, 0n]);

            const result = await router.route("帮我审查代码");
            expect(result.agent.address).to.equal("0xAgent1");
            expect(result.reason).to.be.a("string");
            expect(result.executionLog).to.be.an("array");
        });
    });
});
