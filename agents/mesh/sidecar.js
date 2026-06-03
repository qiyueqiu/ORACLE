/**
 * 流量管理：Circuit Breaker + 负载均衡 + 重试 + 金丝雀（M3 Service Mesh 化）
 *
 * 类比 Service Mesh Sidecar（Envoy / Linkerd）：
 *   - CircuitBreaker: 检测到目标 Agent 失败率突增时熔断
 *   - LoadBalancer: 加权随机选择
 *   - RetryPolicy: 失败自动重试（≤ maxRetries）
 *   - CanaryRelease: 新 Agent 仅承接 canaryPct% 流量
 *
 * 数据来源：链上 Reputation + AgentDID（结合 on-chain metrics）
 */
'use strict';

class CircuitBreaker {
    constructor(opts = {}) {
        this.window = opts.window || 100;          // 滑动窗口大小
        this.failureThreshold = opts.failureThreshold || 0.5;  // 失败率阈值
        this.minSamples = opts.minSamples || 5;
        this.state = new Map();  // agent => { failures, successes, open, openedAt }
    }

    recordSuccess(agent) {
        const s = this._get(agent);
        s.successes = (s.successes + 1) % this.window;
        if (s.open && Date.now() - s.openedAt > 30000) s.open = false;  // 30s 后半开
    }

    recordFailure(agent) {
        const s = this._get(agent);
        s.failures = (s.failures + 1) % this.window;
        const total = s.successes + s.failures;
        if (total >= this.minSamples && s.failures / total > this.failureThreshold) {
            s.open = true;
            s.openedAt = Date.now();
        }
    }

    isOpen(agent) {
        return this._get(agent).open;
    }

    _get(agent) {
        if (!this.state.has(agent)) this.state.set(agent, { failures: 0, successes: 0, open: false, openedAt: 0 });
        return this.state.get(agent);
    }
}

class LoadBalancer {
    constructor(circuitBreaker) {
        this.cb = circuitBreaker;
    }

    /**
     * 从候选列表中按 reputation × (1 - recentFailureRate) 加权随机选一个
     * @param {Array<{address, qualification, avgRating, recentFailureRate, canaryStage}>} candidates
     * @returns {object|null} 选中的 candidate，或 null
     */
    pick(candidates) {
        const live = candidates.filter(c => !this.cb.isOpen(c.address));
        if (live.length === 0) return null;

        // Canary: 仅 canaryStage==1 的新 Agent 接收 5% 流量
        const canary = live.filter(c => c.canaryStage === 1);
        const stable = live.filter(c => c.canaryStage !== 1);
        if (canary.length > 0 && stable.length > 0 && Math.random() < 0.05) {
            return this._weightedPick(canary);
        }
        return this._weightedPick(stable.length > 0 ? stable : live);
    }

    _weightedPick(list) {
        const weights = list.map(c => {
            const rep = Math.max(c.avgRating || 0, 0);
            const successRate = 1 - (c.recentFailureRate || 0);
            return rep * successRate + 1;  // +1 防 0
        });
        const sum = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * sum;
        for (let i = 0; i < list.length; i++) {
            r -= weights[i];
            if (r <= 0) return list[i];
        }
        return list[list.length - 1];
    }
}

class RetryPolicy {
    constructor(opts = {}) {
        this.maxRetries = opts.maxRetries || 2;
        this.backoffMs = opts.backoffMs || 200;
    }

    async execute(fn, context) {
        let lastErr;
        for (let i = 0; i <= this.maxRetries; i++) {
            try {
                return await fn(context, i);
            } catch (err) {
                lastErr = err;
                if (i < this.maxRetries) {
                    await new Promise(r => setTimeout(r, this.backoffMs * (i + 1)));
                }
            }
        }
        throw lastErr;
    }
}

/**
 * 可观测性指标（Prometheus-style）
 */
class Metrics {
    constructor() {
        this.counters = new Map();
        this.gauges = new Map();
        this.histograms = new Map();
    }

    inc(name, value = 1, labels = {}) {
        const key = name + JSON.stringify(labels);
        this.counters.set(key, (this.counters.get(key) || 0) + value);
    }

    set(name, value, labels = {}) {
        const key = name + JSON.stringify(labels);
        this.gauges.set(key, value);
    }

    observe(name, value, labels = {}) {
        const key = name + JSON.stringify(labels);
        if (!this.histograms.has(key)) this.histograms.set(key, []);
        this.histograms.get(key).push(value);
    }

    /**
     * 导出 Prometheus 文本格式
     */
    toPrometheus() {
        const lines = [];
        for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
        for (const [k, v] of this.gauges) lines.push(`${k} ${v}`);
        for (const [k, vs] of this.histograms) {
            const sum = vs.reduce((a, b) => a + b, 0);
            const count = vs.length;
            lines.push(`${k}_sum ${sum}`);
            lines.push(`${k}_count ${count}`);
        }
        return lines.join('\n');
    }
}

module.exports = { CircuitBreaker, LoadBalancer, RetryPolicy, Metrics };
