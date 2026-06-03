import { useState, useRef, useEffect } from 'react';
import { QUALIFICATION_CONFIG } from '../contracts/abis';

type FlowPhase = 'idle' | 'intent_parsing' | 'getting_candidates' | 'evaluating' | 'decision' | 'executing' | 'logging' | 'reputation_analysis' | 'done';

interface PipelineStep {
  key: FlowPhase;
  label: string;
  icon: string;
}

interface CandidateAgent {
  did: string;
  address: string;
  qualification: string;
  avgRating: number;
  ratingCount: number;
  score?: number;
  reason?: string;
}

interface DimensionScore {
  score: number;
  reason: string;
}

interface ReputationAnalysis {
  totalScore: number;
  quality: string;
  taskCompleted: boolean;
  summary: string;
  dimensions: Record<string, DimensionScore>;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
}

const PIPELINE_STEPS: PipelineStep[] = [
  { key: 'intent_parsing', label: '意图解析', icon: '🧠' },
  { key: 'getting_candidates', label: '获取候选 Agent', icon: '🔍' },
  { key: 'evaluating', label: 'LLM 评估候选', icon: '🤖' },
  { key: 'decision', label: '路由决策', icon: '🎯' },
  { key: 'executing', label: 'Agent 执行', icon: '⚡' },
  { key: 'logging', label: '链上记录', icon: '⛓️' },
  { key: 'reputation_analysis', label: '信誉评估', icon: '📊' },
];

const DIMENSION_LABELS: Record<string, { name: string; max: number }> = {
  accuracy: { name: '准确性', max: 30 },
  completeness: { name: '完整性', max: 25 },
  professionalism: { name: '专业性', max: 20 },
  practicality: { name: '实用性', max: 15 },
  clarity: { name: '规范性', max: 10 },
};

const QUALITY_MAP: Record<string, { label: string; cls: string; color: string }> = {
  excellent: { label: '优秀', cls: 'badge-success', color: '#10b981' },
  good: { label: '良好', cls: 'badge-primary', color: '#3b82f6' },
  acceptable: { label: '合格', cls: 'badge-accent', color: '#8b5cf6' },
  poor: { label: '较差', cls: 'badge-warning', color: '#f59e0b' },
  failing: { label: '不合格', cls: 'badge-danger', color: '#ef4444' },
};

const API_BASE = 'http://localhost:3001';
const API_KEY = 'demo-key-change-me';

export default function Dispatch() {
  const [task, setTask] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<FlowPhase>('idle');

  const [intent, setIntent] = useState<any>(null);
  const [candidates, setCandidates] = useState<CandidateAgent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<CandidateAgent | null>(null);
  const [chainOfThought, setChainOfThought] = useState('');
  const [executionResult, setExecutionResult] = useState('');
  const [executionModel, setExecutionModel] = useState('');
  const [reputationAnalysis, setReputationAnalysis] = useState<ReputationAnalysis | null>(null);
  const [tokensUsed, setTokensUsed] = useState(0);
  const [lastAgentAddress, setLastAgentAddress] = useState('');

  const [phaseDetails, setPhaseDetails] = useState<Record<string, string>>({});
  const resultRef = useRef<HTMLDivElement>(null);

  const [userRating, setUserRating] = useState(80);
  const [userComment, setUserComment] = useState('');
  const [userRatingSubmitted, setUserRatingSubmitted] = useState(false);
  const [userRatingSubmitting, setUserRatingSubmitting] = useState(false);

  useEffect(() => {
    if (phase === 'done' && resultRef.current) {
      resultRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [phase]);

  const getStepStatus = (stepKey: FlowPhase): 'pending' | 'active' | 'done' => {
    if (phase === 'idle') return 'pending';
    if (phase === 'done') return 'done';
    const order = PIPELINE_STEPS.map(s => s.key);
    const currentIdx = order.indexOf(phase);
    const stepIdx = order.indexOf(stepKey);
    if (stepIdx < currentIdx) return 'done';
    if (stepIdx === currentIdx) return 'active';
    return 'pending';
  };

  const getConnectorStatus = (stepKey: FlowPhase): '' | 'active' | 'done' => {
    if (phase === 'idle') return '';
    if (phase === 'done') return 'done';
    const order = PIPELINE_STEPS.map(s => s.key);
    const currentIdx = order.indexOf(phase);
    const stepIdx = order.indexOf(stepKey);
    if (stepIdx < currentIdx) return 'done';
    if (stepIdx === currentIdx) return 'active';
    return '';
  };

  const handleDispatch = async () => {
    if (!task.trim()) { setError('请输入任务描述'); return; }

    setLoading(true);
    setError('');
    setPhase('intent_parsing');
    setIntent(null);
    setCandidates([]);
    setSelectedAgent(null);
    setChainOfThought('');
    setExecutionResult('');
    setExecutionModel('');
    setReputationAnalysis(null);
    setTokensUsed(0);
    setLastAgentAddress('');
    setPhaseDetails({});
    setUserRating(80);
    setUserComment('');
    setUserRatingSubmitted(false);

    try {
      await dispatchWithStream();
    } catch (e: any) {
      setError(`调度遇到问题: ${e.message}`);
      setPhase('idle');
    } finally {
      setLoading(false);
    }
  };

  const dispatchWithStream = () => {
    return new Promise<void>((resolve, reject) => {
      let currentEvent = '';

      fetch(`${API_BASE}/api/dispatch/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ task })
      }).then(async response => {
        if (!response.body) { reject(new Error('No response body')); return; }

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
                handleSSEEvent(currentEvent, data, resolve, reject);
              } catch {}
            }
          }
        }
        resolve();
      }).catch(reject);
    });
  };

  const handleSSEEvent = (
    event: string, data: any, resolve: () => void, reject: (e: Error) => void
  ) => {
    switch (event) {
      case 'start':
        break;

      case 'phase':
        setPhase(data.phase as FlowPhase);
        if (data.detail) {
          setPhaseDetails(prev => ({ ...prev, [data.phase]: data.detail }));
        }
        break;

      case 'intent_parsed':
        setIntent(data.intent);
        if (data.detail) {
          setPhaseDetails(prev => ({ ...prev, intent_parsing: data.detail }));
        }
        break;

      case 'candidates':
        setCandidates(data.candidates);
        if (data.detail) {
          setPhaseDetails(prev => ({ ...prev, getting_candidates: data.detail }));
        }
        break;

      case 'evaluated':
        setCandidates(prev =>
          prev.map((c, i) => ({
            ...c,
            score: data.rankings?.[i]?.score || 0,
            reason: data.rankings?.[i]?.reason || '',
          }))
        );
        if (data.detail) {
          setPhaseDetails(prev => ({ ...prev, evaluating: data.detail }));
        }
        setPhase('decision');
        break;

      case 'selected':
        setSelectedAgent({
          did: data.selected.did,
          address: data.selected.address,
          qualification: data.selected.qualification,
          avgRating: data.selected.avgRating || 0,
          ratingCount: 0,
          score: data.selected.score,
        });
        if (data.detail) {
          setPhaseDetails(prev => ({ ...prev, decision: data.detail }));
        }
        break;

      case 'chain_of_thought':
        setChainOfThought(data.chainOfThought);
        setExecutionModel(data.model || '');
        break;

      case 'result':
        setExecutionResult(data.result);
        if (data.agentType) {
          const config = QUALIFICATION_CONFIG[data.agentType];
          if (config) {
            setPhaseDetails(prev => ({ ...prev, executing: `${config.icon} ${config.name} 执行完成` }));
          }
        }
        break;

      case 'logged':
        if (data.message) {
          setPhaseDetails(prev => ({ ...prev, logging: data.message }));
        }
        break;

      case 'reputation_analyzed':
        setReputationAnalysis(data.analysis || null);
        if (data.detail) {
          setPhaseDetails(prev => ({ ...prev, reputation_analysis: data.detail }));
        }
        break;

      case 'complete':
        setTokensUsed(data.tokensUsed || 0);
        setLastAgentAddress(data.agentAddress || '');
        setPhase('done');
        resolve();
        break;

      case 'error':
        setError(data.error);
        setPhase('idle');
        reject(new Error(data.error));
        break;
    }
  };

  const submitUserRating = async () => {
    if (!lastAgentAddress) return;
    setUserRatingSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/user-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({
          agentAddress: lastAgentAddress,
          score: userRating,
          comment: userComment,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setUserRatingSubmitted(true);
      } else {
        setError(data.error || '提交评价失败');
      }
    } catch (e: any) {
      setError(`提交评价失败: ${e.message}`);
    } finally {
      setUserRatingSubmitting(false);
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return 'var(--success)';
    if (score >= 60) return 'var(--primary)';
    if (score >= 40) return 'var(--warning)';
    return 'var(--danger)';
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>任务调度</h2>
        <p>提交任务，观察 AI Agent 全流程实时执行</p>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="card">
        <div className="task-input-wrapper">
          <input
            className="task-input"
            placeholder="描述你的任务，例如：帮我审查一段 JavaScript 代码的安全性..."
            value={task}
            onChange={e => setTask(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !loading && handleDispatch()}
            disabled={loading}
          />
          <button
            className="btn-primary task-input-btn"
            onClick={handleDispatch}
            disabled={loading || !task.trim()}
          >
            {loading ? '执行中...' : '开始调度'}
          </button>
        </div>
      </div>

      {phase !== 'idle' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">执行管线</span>
            {tokensUsed > 0 && (
              <span className="badge badge-accent">{tokensUsed} tokens</span>
            )}
          </div>
          <div className="pipeline">
            {PIPELINE_STEPS.map((step, i) => {
              const status = getStepStatus(step.key);
              const connectorStatus = i < PIPELINE_STEPS.length - 1 ? getConnectorStatus(step.key) : '';
              const detail = phaseDetails[step.key];

              return (
                <div key={step.key}>
                  <div className={`pipeline-step ${status}`}>
                    <div className="pipeline-icon">
                      {status === 'active' ? <span className="animate-pulse">{step.icon}</span> : step.icon}
                    </div>
                    <div className="pipeline-content">
                      <div className="pipeline-title">
                        {step.label}
                        {status === 'active' && <span className="badge badge-primary" style={{ marginLeft: 8 }}>进行中</span>}
                        {status === 'done' && <span style={{ marginLeft: 8, color: 'var(--success)' }}>✓</span>}
                      </div>
                      {status === 'active' && !detail && (
                        <div className="pipeline-desc">处理中...</div>
                      )}
                      {detail && (
                        <div className="pipeline-detail">{detail}</div>
                      )}
                    </div>
                  </div>
                  {i < PIPELINE_STEPS.length - 1 && (
                    <div className={`pipeline-connector ${connectorStatus}`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {intent && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">🧠 意图解析</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="badge badge-primary">意图: {intent.intent}</span>
            <span className="badge badge-accent">资质: {intent.requiredQualification}</span>
            <span className="badge badge-info">复杂度: {intent.complexity}</span>
          </div>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">🤖 候选 Agent ({candidates.length})</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="candidates-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>资质</th>
                  <th>信誉</th>
                  <th>评分</th>
                  <th>匹配度</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map(agent => {
                  const config = QUALIFICATION_CONFIG[agent.qualification];
                  const isSelected = selectedAgent?.did === agent.did;
                  return (
                    <tr key={agent.did} className={isSelected ? 'selected-row' : ''}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{agent.did}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontFamily: 'monospace' }}>
                          {agent.address?.slice(0, 10)}...
                        </div>
                      </td>
                      <td>
                        <span className={`badge qual-${agent.qualification}`}>
                          {config?.icon} {config?.name || agent.qualification}
                        </span>
                      </td>
                      <td>{agent.avgRating}</td>
                      <td>{agent.ratingCount}</td>
                      <td style={{ color: getScoreColor(agent.score || 0), fontWeight: 700 }}>
                        {agent.score !== undefined ? agent.score : '-'}
                        {isSelected && ' ← 选中'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {chainOfThought && (
        <div className="thinking-panel">
          <div className="panel-title">💭 Agent 思考过程 {executionModel && <span className="badge badge-accent" style={{ marginLeft: 8 }}>{executionModel.split('/').pop()}</span>}</div>
          <div className="panel-content" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
            {chainOfThought}
          </div>
        </div>
      )}

      {executionResult && (
        <div className="result-panel" ref={resultRef}>
          <div className="panel-title">✅ 执行结果</div>
          <div className="panel-content">{executionResult}</div>
        </div>
      )}

      {reputationAnalysis && (
        <div className="analysis-panel">
          <div className="panel-title">
            📊 信誉评估
            <span className="badge" style={{
              marginLeft: 8,
              background: getScoreColor(reputationAnalysis.totalScore),
              color: 'white',
            }}>
              {reputationAnalysis.totalScore}/100
            </span>
            <span className={`badge ${QUALITY_MAP[reputationAnalysis.quality]?.cls || 'badge-warning'}`} style={{ marginLeft: 4 }}>
              {QUALITY_MAP[reputationAnalysis.quality]?.label || reputationAnalysis.quality}
            </span>
            {reputationAnalysis.taskCompleted && (
              <span className="badge badge-success" style={{ marginLeft: 4 }}>任务完成</span>
            )}
          </div>

          {reputationAnalysis.summary && (
            <div style={{ marginBottom: 16, padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: '0.9rem', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
              {reputationAnalysis.summary}
            </div>
          )}

          {reputationAnalysis.dimensions && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 8 }}>评分详情</div>
              {Object.entries(DIMENSION_LABELS).map(([key, dim]) => {
                const d = reputationAnalysis.dimensions[key];
                if (!d) return null;
                const pct = (d.score / dim.max) * 100;
                return (
                  <div key={key} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>{dim.name} <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>(满分 {dim.max})</span></span>
                      <span style={{ fontSize: '0.85rem', fontWeight: 700, color: getScoreColor((d.score / dim.max) * 100) }}>{d.score}</span>
                    </div>
                    <div style={{ height: 6, background: 'var(--bg-secondary)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', width: `${pct}%`, borderRadius: 3,
                        background: getScoreColor((d.score / dim.max) * 100),
                        transition: 'width 0.5s ease',
                      }} />
                    </div>
                    {d.reason && (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: 3, lineHeight: 1.4 }}>{d.reason}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {reputationAnalysis.strengths.length > 0 && (
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--success)', marginBottom: 4 }}>优点</div>
                <ul style={{ paddingLeft: 20, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  {reputationAnalysis.strengths.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {reputationAnalysis.weaknesses.length > 0 && (
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--warning)', marginBottom: 4 }}>不足</div>
                <ul style={{ paddingLeft: 20, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  {reputationAnalysis.weaknesses.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
          </div>

          {reputationAnalysis.suggestions.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary)', marginBottom: 4 }}>改进建议</div>
              <ul style={{ paddingLeft: 20, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {reputationAnalysis.suggestions.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {phase === 'done' && lastAgentAddress && (
        <div className="card" style={{ background: 'linear-gradient(135deg, #fefce8 0%, #fef9c3 100%)', borderColor: '#fde68a' }}>
          <div className="card-header">
            <span className="card-title">⭐ 你的评价</span>
            {userRatingSubmitted && <span className="badge badge-success">已提交，感谢！</span>}
          </div>

          {!userRatingSubmitted ? (
            <>
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>你的评分:</span>
                  <input
                    type="range" min={0} max={100} value={userRating}
                    onChange={e => setUserRating(Number(e.target.value))}
                    style={{ flex: 1, accentColor: getScoreColor(userRating) }}
                  />
                  <span style={{
                    fontSize: '1.2rem', fontWeight: 700, minWidth: 60, textAlign: 'right',
                    color: getScoreColor(userRating),
                  }}>
                    {userRating}/100
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                  <span>不合格</span>
                  <span>|</span>
                  <span>合格</span>
                  <span>|</span>
                  <span>良好</span>
                  <span>|</span>
                  <span>优秀</span>
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <textarea
                  placeholder="补充评价（可选）..."
                  value={userComment}
                  onChange={e => setUserComment(e.target.value)}
                  style={{
                    width: '100%', minHeight: 60, padding: '8px 12px',
                    border: '1px solid var(--border)', borderRadius: 8,
                    fontSize: '0.9rem', resize: 'vertical', fontFamily: 'inherit',
                  }}
                />
              </div>

              <button
                className="btn-primary"
                onClick={submitUserRating}
                disabled={userRatingSubmitting}
                style={{ width: '100%' }}
              >
                {userRatingSubmitting ? '提交中...' : '提交评价到区块链'}
              </button>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '12px 0', color: 'var(--success)', fontWeight: 500 }}>
              你的评价 ({userRating}/100) 已记录到区块链，将影响该 Agent 的信誉分
            </div>
          )}
        </div>
      )}
    </div>
  );
}
