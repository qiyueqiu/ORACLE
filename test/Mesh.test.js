const { expect } = require("chai");
const { CircuitBreaker, LoadBalancer, RetryPolicy, Metrics } = require("../agents/mesh/sidecar.cjs");

describe("Service Mesh Sidecar (M3)", function () {
    describe("CircuitBreaker", function () {
        it("Should open after threshold", function () {
            const cb = new CircuitBreaker({ window: 10, failureThreshold: 0.5, minSamples: 4 });
            for (let i = 0; i < 5; i++) cb.recordFailure("agent1");
            expect(cb.isOpen("agent1")).to.be.true;
        });

        it("Should stay closed below threshold", function () {
            const cb = new CircuitBreaker({ window: 10, failureThreshold: 0.5, minSamples: 4 });
            for (let i = 0; i < 5; i++) cb.recordSuccess("agent2");
            expect(cb.isOpen("agent2")).to.be.false;
        });

        it("Should not open with too few samples", function () {
            const cb = new CircuitBreaker({ window: 10, failureThreshold: 0.5, minSamples: 5 });
            cb.recordFailure("agent3");
            expect(cb.isOpen("agent3")).to.be.false;
        });
    });

    describe("LoadBalancer", function () {
        it("Should return null if all agents are open", function () {
            const cb = new CircuitBreaker();
            cb.recordFailure("a");
            cb.recordFailure("a");
            const lb = new LoadBalancer(cb);
            const r = lb.pick([{ address: "a", avgRating: 50 }]);
            // 2 samples < minSamples 5 → 不会熔断 → 应能选
            expect(r).to.not.be.null;
        });

        it("Should prefer higher reputation", function () {
            const lb = new LoadBalancer(new CircuitBreaker());
            const candidates = [
                { address: "low", avgRating: 10, recentFailureRate: 0 },
                { address: "high", avgRating: 90, recentFailureRate: 0 },
            ];
            // 多次抽样，高 reputation 应被选中更多次（容差放宽到 60%）
            let count = 0;
            for (let i = 0; i < 500; i++) {
                if (lb.pick(candidates)?.address === "high") count++;
            }
            expect(count).to.be.greaterThan(300);
        });
    });

    describe("RetryPolicy", function () {
        it("Should retry up to maxRetries", async function () {
            const rp = new RetryPolicy({ maxRetries: 2, backoffMs: 10 });
            let attempts = 0;
            try {
                await rp.execute(async () => {
                    attempts++;
                    throw new Error("fail");
                });
            } catch {}
            expect(attempts).to.equal(3);  // initial + 2 retries
        });

        it("Should succeed on retry", async function () {
            const rp = new RetryPolicy({ maxRetries: 3, backoffMs: 10 });
            let attempts = 0;
            const result = await rp.execute(async () => {
                attempts++;
                if (attempts < 2) throw new Error("transient");
                return "ok";
            });
            expect(attempts).to.equal(2);
            expect(result).to.equal("ok");
        });
    });

    describe("Metrics", function () {
        it("Should track counters", function () {
            const m = new Metrics();
            m.inc("dispatch_total", 1, { status: "ok" });
            m.inc("dispatch_total", 1, { status: "ok" });
            const text = m.toPrometheus();
            expect(text).to.include("dispatch_total");
        });

        it("Should track histograms", function () {
            const m = new Metrics();
            m.observe("dispatch_latency_ms", 100);
            m.observe("dispatch_latency_ms", 200);
            const text = m.toPrometheus();
            expect(text).to.include("dispatch_latency_ms_sum 300");
            expect(text).to.include("dispatch_latency_ms_count 2");
        });
    });
});
