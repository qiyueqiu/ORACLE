import { useState } from 'react';

type FlowStep = 'idle' | 'parsing' | 'candidates' | 'evaluating' | 'decision' | 'executing' | 'done';

interface StepConfig {
  label: string;
  status: 'pending' | 'active' | 'done';
  icon: string;
}

interface ExecutionLogEntry {
  stepId: string;
  stepType: string;
  agent: string;
  phase: string;
  model?: string;
  input: string;
  output: string;
  chainOfThought?: string;
  tokens?: number;
  duration?: number;
  timestamp: number;
}

interface CandidateAgent {
  did: string;
  address: string;
  qualification: string;
  avgRating: number;
  ratingCount: number;
  score?: number;
}

const QUALIFICATION_NAMES: Record<string, string> = {
  weather: '🌤️ 天气',
  content: '📝 内容',
  calc: '🔢 计算',
};

const API_BASE = 'http://localhost:3001';

export default function Dispatch() {
  const [task, setTask] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<FlowStep>('idle');
  const [candidates, setCandidates] = useState<CandidateAgent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<CandidateAgent | null>(null);
  const [decisionReason, setDecisionReason] = useState('');
  const [executionResult, setExecutionResult] = useState('');
  const [chainOfThought, setChainOfThought] = useState('');
  const [executionLog, setExecutionLog] = useState<ExecutionLogEntry[]>([]);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [tokensUsed, setTokensUsed] = useState(0);

  const steps: StepConfig[] = [
    { label: '意图解析', status: step === 'idle' ? 'pending' : step === 'parsing' ? 'active' : 'done', icon: '🧠' },
    { label: '获取候选', status: step === 'idle' || step === 'parsing' ? 'pending' : step === 'candidates' ? 'active' : 'done', icon: '🔍' },
    { label: 'LLM 评估', status: step === 'idle' || step === 'parsing' || step === 'candidates' ? 'pending' : step === 'evaluating' ? 'active' : 'done', icon: '🤖' },
    { label: '做出决策', status: step === 'idle' || step === 'parsing' || step === 'candidates' || step === 'evaluating' ? 'pending' : step === 'decision' ? 'active' : 'done', icon: '🎯' },
    { label: '执行任务', status: step === 'idle' || step === 'parsing' || step === 'candidates' || step === 'evaluating' || step === 'decision' ? 'pending' : step === 'executing' ? 'active' : 'done', icon: '⚡' },
  ];

  const handleDispatch = async () => {
    if (!task.trim()) {
      setError('请输入任务描述');
      return;
    }

    setLoading(true);
    setError('');
    setStep('parsing');
    setCandidates([]);
    setSelectedAgent(null);
    setDecisionReason('');
    setExecutionResult('');
    setChainOfThought('');
    setExecutionLog([]);
    setExpandedLog(null);
    setTokensUsed(0);

    try {
      // 使用流式 API
      await dispatchWithStream();
    } catch (e: any) {
      setError(`调度失败: ${e.message}`);
      setStep('idle');
    } finally {
      setLoading(false);
    }
  };

  const dispatchWithStream = () => {
    return new Promise<void>((resolve, reject) => {
      let currentEvent = '';

      fetch(`${API_BASE}/api/dispatch/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task })
      }).then(async (response) => {
        if (!response.body) {
          reject(new Error('No response body'));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));

                switch (currentEvent) {
                  case 'start':
                    break;

                  case 'phase':
                    if (data.phase === 'intent_parsing') setStep('parsing');
                    else if (data.phase === 'getting_candidates') setStep('candidates');
                    else if (data.phase === 'evaluating') setStep('evaluating');
                    else if (data.phase === 'executing') setStep('executing');
                    break;

                  case 'intent_parsed':
                    addLogEntry({
                      stepId: `intent-${Date.now()}`,
                      stepType: 'llm_call',
                      agent: 'Router',
                      phase: 'intent_parsing',
                      model: 'Qwen/Qwen2.5-7B-Instruct',
                      input: task,
                      output: JSON.stringify(data.intent, null, 2),
                      timestamp: Date.now() / 1000,
                    });
                    break;

                  case 'candidates':
                    setCandidates(data.candidates);
                    break;

                  case 'evaluated':
                    setCandidates(prev =>
                      prev.map((c, i) => ({
                        ...c,
                        score: data.rankings?.[i]?.score || 0
                      }))
                    );
                    setStep('decision');
                    break;

                  case 'selected':
                    setCandidates(prev => {
                      const found = prev.find(c => c.did === data.selected?.did);
                      if (found) {
                        setSelectedAgent({ ...found, ...data.selected });
                      }
                      return prev;
                    });
                    setDecisionReason(data.decision);
                    break;

                  case 'chain_of_thought':
                    setChainOfThought(data.chainOfThought);
                    break;

                  case 'complete':
                    setExecutionResult(data.result);
                    setTokensUsed(data.tokensUsed || 0);
                    setStep('done');
                    resolve();
                    return;

                  case 'error':
                    setError(data.error);
                    reject(new Error(data.error));
                    return;
                }
              } catch (err) {
                console.error('Parse error:', err);
              }
            }
          }
        }

        resolve();
      }).catch(reject);
    });
  };

  const addLogEntry = (entry: ExecutionLogEntry) => {
    setExecutionLog(prev => [...prev, entry]);
  };

  const toggleLog = (stepId: string) => {
    setExpandedLog(expandedLog === stepId ? null : stepId);
  };

  const getScoreColor = (score: number) => {
    if (!score) return '#888';
    if (score >= 80) return '#10b981';
    if (score >= 60) return '#3b82f6';
    if (score >= 40) return '#f59e0b';
    return '#ef4444';
  };

  return (
    <div className="page">
      <h2>🚀 LLM 驱动任务调度</h2>
      {error && <div className="error-msg">{error}</div>}

      {/* 任务输入 */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>📋 创建任务</h3>
        <input
          className="task-input"
          placeholder="输入任务描述 (例如: 北京今天天气怎么样？)"
          value={task}
          onChange={e => setTask(e.target.value)}
          disabled={loading}
        />
        <button className="btn-primary" onClick={handleDispatch} disabled={loading || step === 'done'}>
          {loading ? '处理中...' : step === 'done' ? '已完成' : '开始调度'}
        </button>
      </div>

      {/* 调度流程 */}
      <div className="card">
        <h3 style={{ marginBottom: 16 }}>📊 执行流程追踪</h3>
        <div className="dispatch-flow">
          {steps.map((s, i) => (
            <div key={i} className={`flow-step ${s.status}`}>
              <div className="step-icon">{s.icon}</div>
              <div className="step-info">
                <div className="step-label">{s.label}</div>
                <div className="step-status">
                  {s.status === 'pending' && '等待中...'}
                  {s.status === 'active' && '进行中...'}
                  {s.status === 'done' && '✓ 完成'}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Token 使用 */}
        {tokensUsed > 0 && (
          <div style={{ marginTop: '16px', padding: '12px', background: 'rgba(139, 92, 246, 0.1)', borderRadius: '8px' }}>
            <div style={{ fontSize: '0.9rem' }}>
              💰 LLM Token 消耗: <strong>{tokensUsed}</strong>
            </div>
          </div>
        )}
      </div>

      {/* 候选 Agent 对比 */}
      {candidates.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 16 }}>🤖 候选 Agent ({candidates.length})</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="candidates-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>资质</th>
                  <th>信誉</th>
                  <th>评分</th>
                  <th>LLM 评分</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((agent) => (
                  <tr
                    key={agent.did}
                    style={{
                      background: selectedAgent?.did === agent.did ? 'rgba(16, 185, 129, 0.1)' : undefined,
                    }}
                  >
                    <td>
                      <div>{agent.did}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontFamily: 'monospace' }}>
                        {agent.address.slice(0, 8)}...
                      </div>
                    </td>
                    <td>{QUALIFICATION_NAMES[agent.qualification] || agent.qualification}</td>
                    <td>{agent.avgRating.toFixed(1)} ⭐</td>
                    <td>{agent.ratingCount}</td>
                    <td style={{ color: getScoreColor(agent.score || 0), fontWeight: 'bold' }}>
                      {agent.score !== undefined ? agent.score : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 决策理由 */}
      {selectedAgent && decisionReason && (
        <div className="card" style={{ border: '2px solid var(--accent)' }}>
          <h3 style={{ marginBottom: 12 }}>🧠 LLM 决策</h3>
          <div style={{ whiteSpace: 'pre-line', lineHeight: '1.6' }}>
            {decisionReason}
          </div>
          <div style={{ marginTop: '12px', fontSize: '0.85rem', color: 'var(--text-dim)' }}>
            选中: <strong>{selectedAgent.did}</strong> ({QUALIFICATION_NAMES[selectedAgent.qualification]})
          </div>
        </div>
      )}

      {/* 思考链 */}
      {chainOfThought && (
        <div className="card" style={{ border: '2px solid #8b5cf6' }}>
          <h3 style={{ marginBottom: 12 }}>💭 Agent 思考过程</h3>
          <div style={{
            background: 'rgba(139, 92, 246, 0.1)',
            padding: '16px',
            borderRadius: '8px',
            whiteSpace: 'pre-wrap',
            fontFamily: 'monospace',
            fontSize: '0.9rem',
            lineHeight: '1.6'
          }}>
            {chainOfThought}
          </div>
        </div>
      )}

      {/* 执行结果 */}
      {executionResult && (
        <div className="card" style={{ border: '2px solid var(--success)' }}>
          <h3 style={{ marginBottom: 12 }}>✅ 执行结果</h3>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
            {executionResult}
          </div>
        </div>
      )}

      {/* LLM 调用日志 */}
      {executionLog.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 16 }}>📜 LLM 调用日志</h3>
          <div className="execution-log">
            {executionLog.map((log) => (
              <div key={log.stepId} className="log-entry">
                <div
                  className="log-header"
                  onClick={() => toggleLog(log.stepId)}
                  style={{ cursor: 'pointer' }}
                >
                  <span className="log-phase">{log.phase}</span>
                  <span className="log-agent">{log.agent}</span>
                  {log.model && <span className="log-model">{log.model.split('/').pop()}</span>}
                  {log.tokens && <span className="log-tokens">{log.tokens} tokens</span>}
                  <span className="log-toggle">{expandedLog === log.stepId ? '▼' : '▶'}</span>
                </div>
                {expandedLog === log.stepId && (
                  <div className="log-details">
                    <div className="log-section">
                      <strong>输入:</strong>
                      <pre>{log.input.slice(0, 200)}{log.input.length > 200 ? '...' : ''}</pre>
                    </div>
                    <div className="log-section">
                      <strong>输出:</strong>
                      <pre>{log.output.slice(0, 500)}{log.output.length > 500 ? '...' : ''}</pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
