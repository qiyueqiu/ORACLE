/**
 * SiliconFlowClient 单元测试
 * 覆盖 chat / chatWithJson happy path 与错误处理
 */
const { expect } = require("chai");
const sinon = require("sinon");
const axios = require("axios");
const { SiliconFlowClient } = require("../agents/siliconflow-client");

describe("agents/siliconflow-client", function () {
    let client, axiosPostStub;

    beforeEach(function () {
        client = new SiliconFlowClient("test-api-key");
        axiosPostStub = sinon.stub(axios, "post");
    });

    afterEach(function () {
        axiosPostStub.restore();
    });

    describe("chat()", function () {
        it("Should return content and usage on success", async function () {
            axiosPostStub.resolves({
                data: {
                    choices: [{ message: { content: "Hello, world!" } }],
                    usage: { total_tokens: 10 },
                    model: "model-x",
                },
            });

            const result = await client.chat("model-x", [{ role: "user", content: "hi" }]);
            expect(result.content).to.equal("Hello, world!");
            expect(result.usage.total_tokens).to.equal(10);
            expect(result.model).to.equal("model-x");
        });

        it("Should pass model, messages, temperature, max_tokens to API", async function () {
            axiosPostStub.resolves({
                data: { choices: [{ message: { content: "ok" } }], usage: {} },
            });

            await client.chat("m", [{ role: "user", content: "x" }], { temperature: 0.7, max_tokens: 100 });
            const args = axiosPostStub.firstCall.args;
            expect(args[1].model).to.equal("m");
            expect(args[1].temperature).to.equal(0.7);
            expect(args[1].max_tokens).to.equal(100);
            expect(args[0]).to.include("/chat/completions");
        });

        it("Should propagate network errors", async function () {
            axiosPostStub.rejects(new Error("connect ECONNREFUSED"));
            try {
                await client.chat("m", [{ role: "user", content: "x" }]);
                expect.fail("Should have thrown");
            } catch (err) {
                expect(err.message).to.include("ECONNREFUSED");
            }
        });

        it("Should propagate API errors (4xx/5xx)", async function () {
            const err = new Error("Request failed");
            err.response = { status: 401, data: { error: "invalid api key" } };
            axiosPostStub.rejects(err);
            try {
                await client.chat("m", [{ role: "user", content: "x" }]);
                expect.fail("Should have thrown");
            } catch (e) {
                // SiliconFlowClient 把 err.message 包了一层
                expect(e.message).to.include("SiliconFlow API error");
                expect(e.message).to.include("Request failed");
            }
        });
    });

    describe("chatWithJson()", function () {
        it("Should parse JSON content", async function () {
            axiosPostStub.resolves({
                data: {
                    choices: [{ message: { content: '{"intent":"code","score":90}' } }],
                    usage: { total_tokens: 5 },
                },
            });

            const schema = { intent: "", score: 0 };
            const result = await client.chatWithJson("m", [{ role: "user", content: "x" }], schema);
            expect(result.data.intent).to.equal("code");
            expect(result.data.score).to.equal(90);
        });

        it("Should strip markdown code blocks", async function () {
            axiosPostStub.resolves({
                data: {
                    choices: [{ message: { content: '```json\n{"x":1}\n```' } }],
                    usage: {},
                },
            });
            const result = await client.chatWithJson("m", [{ role: "user", content: "x" }], { x: 0 });
            expect(result.data.x).to.equal(1);
        });

        it("Should throw on invalid JSON", async function () {
            axiosPostStub.resolves({
                data: {
                    choices: [{ message: { content: "not json at all" } }],
                    usage: {},
                },
            });
            try {
                await client.chatWithJson("m", [{ role: "user", content: "x" }], { x: 0 });
                expect.fail("Should have thrown");
            } catch (e) {
                expect(e.message).to.match(/JSON|parse/);
            }
        });
    });
});
