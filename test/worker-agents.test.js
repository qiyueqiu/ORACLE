/**
 * WorkerAgent / WorkerAgents 单元测试
 * 覆盖: buildPrompt / selectModel / chatWithChainOfThought / execute
 *
 * 用 axios-mock-adapter 拦截 HTTP 调用
 */
const { expect } = require("chai");
const axios = require("axios");
const MockAdapter = require("axios-mock-adapter");
const { WorkerAgent, QUALIFICATION_CONFIG } = require("../agents/worker-agents");

const SF_URL = "https://api.siliconflow.cn/v1/chat/completions";

describe("agents/worker-agents", function () {
    let mock;

    beforeEach(function () {
        mock = new MockAdapter(axios);
    });

    afterEach(function () {
        mock.restore();
    });

    describe("selectModel", function () {
        it("Should pick simple model for short tasks", function () {
            const info = { did: "test", address: "0x1", qualification: "code_review" };
            const w = new WorkerAgent("k", info);
            const model = w.selectModel("hello world");
            expect(model).to.equal("Qwen/Qwen2.5-7B-Instruct");
        });

        it("Should pick complex model for long tasks", function () {
            const info = { did: "test", address: "0x1", qualification: "code_review" };
            const w = new WorkerAgent("k", info);
            const longTask = "请分析这段非常长的代码".repeat(30);
            const model = w.selectModel(longTask);
            expect(model).to.equal("deepseek-ai/DeepSeek-V3");
        });

        it("Should pick complex model for tasks containing 分析/计算/创作", function () {
            const info = { did: "test", address: "0x1", qualification: "data_analysis" };
            const w = new WorkerAgent("k", info);
            const model = w.selectModel("数据分析");
            expect(model).to.equal("deepseek-ai/DeepSeek-V3");
        });
    });

    describe("buildPrompt", function () {
        it("Should include task description", function () {
            const info = { did: "test", address: "0x1", qualification: "code_review" };
            const w = new WorkerAgent("k", info);
            const prompt = w.buildPrompt("审计代码", {});
            expect(prompt).to.include("审计代码");
            expect(prompt).to.include(QUALIFICATION_CONFIG.code_review.systemPrompt);
        });

        it("Should include context when selectedAgent provided", function () {
            const info = { did: "test", address: "0x1", qualification: "code_review" };
            const w = new WorkerAgent("k", info);
            const prompt = w.buildPrompt("test", { selectedAgent: "0x1", reputation: 85 });
            expect(prompt).to.include("信誉评分: 85");
        });
    });

    describe("chatWithChainOfThought", function () {
        it("Should parse <思考> and <结果> tags", async function () {
            mock.onPost(SF_URL).reply(200, {
                choices: [{ message: { content: "<思考>让我想想</思考><结果>最终答案</结果>" } }],
                usage: { total_tokens: 10 },
                model: "m",
            });
            const info = { did: "test", address: "0x1", qualification: "code_review" };
            const w = new WorkerAgent("k", info);
            const r = await w.chatWithChainOfThought("m", "test");
            expect(r.chainOfThought).to.equal("让我想想");
        });

        it("Should return raw content when no tags", async function () {
            mock.onPost(SF_URL).reply(200, {
                choices: [{ message: { content: "no tags here" } }],
                usage: { total_tokens: 5 },
                model: "m",
            });
            const info = { did: "test", address: "0x1", qualification: "code_review" };
            const w = new WorkerAgent("k", info);
            const r = await w.chatWithChainOfThought("m", "test");
            expect(r.chainOfThought).to.equal("");
            expect(r.content).to.equal("no tags here");
        });
    });

    describe("execute", function () {
        it("Should return result and chainOfThought", async function () {
            mock.onPost(SF_URL).reply(200, {
                choices: [{ message: { content: "<思考>analyze</思考><结果>completed</结果>" } }],
                usage: { total_tokens: 50 },
                model: "m",
            });
            const info = { did: "did:codeReview1", address: "0xAgent1", qualification: "code_review" };
            const w = new WorkerAgent("k", info);
            const r = await w.execute("audit code", { selectedAgent: "did:codeReview1", reputation: 90 });
            expect(r.result).to.equal("completed");
            expect(r.chainOfThought).to.equal("analyze");
            expect(r.tokens).to.equal(50);
            expect(r.agentType).to.equal("code_review");
        });

        it("Should propagate LLM errors", async function () {
            mock.onPost(SF_URL).networkError();
            const info = { did: "x", address: "0x1", qualification: "code_review" };
            const w = new WorkerAgent("k", info);
            try {
                await w.execute("x");
                expect.fail("Should have thrown");
            } catch (e) {
                expect(e.message).to.match(/Network Error|SiliconFlow/);
            }
        });
    });

    describe("QUALIFICATION_CONFIG", function () {
        it("Should define 8 qualification types", function () {
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

        it("Each type should have name, icon, systemPrompt", function () {
            for (const cfg of Object.values(QUALIFICATION_CONFIG)) {
                expect(cfg.name).to.be.a("string");
                expect(cfg.icon).to.be.a("string");
                expect(cfg.systemPrompt).to.be.a("string");
            }
        });
    });
});
