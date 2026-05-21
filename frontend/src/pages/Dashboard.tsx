import { useState, useEffect } from 'react';
import { getSigner, getContracts, QUALIFICATION_CONFIG } from '../contracts/abis';
import { generateDID, generateSecret, generateCommitment, generateNullifier, hashSecret } from '../utils/did';

interface AgentInfo {
  address: string;
  did: string;
  qualification: string;
  isActive: boolean;
  reputation: string;
  ratingCount: number;
  registeredAt: number;
  trustScore: number;
}

const QUALIFICATION_TYPES = Object.keys(QUALIFICATION_CONFIG);

export default function Dashboard() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [didName, setDidName] = useState('');
  const [qualType, setQualType] = useState('code_review');
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  const loadAgents = async () => {
    try {
      const signer = await getSigner();
      const { agentDID, reputation } = getContracts(signer);
      const count = await agentDID.agentCount();
      const list: AgentInfo[] = [];

      for (let i = 0; i < Number(count); i++) {
        const addr = await agentDID.agentList(i);
        const agent = await agentDID.agents(addr);
        const rep = await reputation.getReputation(addr);
        const avgRep = Number(rep[1]) > 0 ? Number(rep[0]) / Number(rep[1]) : 0;

        list.push({
          address: addr,
          did: agent[1],
          qualification: agent[3],
          isActive: agent[4],
          reputation: avgRep.toFixed(1),
          ratingCount: Number(rep[1]),
          registeredAt: Number(agent[5]),
          trustScore: avgRep,
        });
      }
      setAgents(list);
    } catch (e: any) {
      setError('加载智能体失败: ' + e.message);
    }
  };

  useEffect(() => { loadAgents(); }, []);

  const handleRegister = async () => {
    if (!didName.trim()) { setError('请输入 Agent 名称'); return; }
    setLoading(true);
    setError('');
    try {
      const signer = await getSigner();
      const { agentDID } = getContracts(signer);
      const did = generateDID(didName);
      const secret = generateSecret();
      const nullifier = generateNullifier(did, secret);
      const secretHash = hashSecret(secret);
      const commitment = generateCommitment(nullifier, secretHash);
      const tx = await agentDID.registerAgent(did, commitment, qualType);
      await tx.wait();
      setDidName('');
      setShowRegister(false);
      await loadAgents();
    } catch (e: any) {
      setError('注册失败: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  const stats = {
    total: agents.length,
    active: agents.filter(a => a.isActive).length,
    avgReputation: agents.length > 0
      ? (agents.reduce((sum, a) => sum + parseFloat(a.reputation), 0) / agents.length).toFixed(1)
      : '0.0',
  };

  const qualDistribution = QUALIFICATION_TYPES.map(q => ({
    key: q,
    ...QUALIFICATION_CONFIG[q],
    count: agents.filter(a => a.qualification === q).length,
  })).filter(q => q.count > 0);

  const sortedAgents = [...agents].sort((a, b) => b.trustScore - a.trustScore);

  const getScoreColor = (score: number) => {
    if (score >= 4.0) return 'var(--success)';
    if (score >= 3.0) return 'var(--primary)';
    if (score >= 2.0) return 'var(--warning)';
    return 'var(--danger)';
  };

  const formatTime = (ts: number) => new Date(ts * 1000).toLocaleString('zh-CN');

  return (
    <div className="page">
      <div className="page-header">
        <h2>智能体管理</h2>
        <p>注册和管理区块链上的 AI 智能体</p>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value text-primary">{stats.total}</div>
          <div className="stat-label">已注册 Agent</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-success">{stats.active}</div>
          <div className="stat-label">活跃 Agent</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-accent">{stats.avgReputation}</div>
          <div className="stat-label">平均信誉分</div>
        </div>
      </div>

      {/* Agent 类型分布 */}
      {qualDistribution.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">资质分布</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {qualDistribution.map(q => (
              <span key={q.key} className={`badge qual-${q.key}`}>
                {q.icon} {q.name} ({q.count})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 注册按钮 */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">注册新 Agent</span>
          <button className="btn-primary btn-sm" onClick={() => setShowRegister(!showRegister)}>
            {showRegister ? '取消' : '+ 注册'}
          </button>
        </div>
        {showRegister && (
          <div style={{ marginTop: 12 }}>
            <div className="form-row" style={{ marginBottom: 12 }}>
              <input
                placeholder="Agent 名称 (例如: CodeReviewer)"
                value={didName}
                onChange={e => setDidName(e.target.value)}
                style={{ flex: 2 }}
              />
              <select value={qualType} onChange={e => setQualType(e.target.value)} style={{ flex: 1 }}>
                {QUALIFICATION_TYPES.map(t => (
                  <option key={t} value={t}>
                    {QUALIFICATION_CONFIG[t].icon} {QUALIFICATION_CONFIG[t].name}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn-primary" onClick={handleRegister} disabled={loading} style={{ width: '100%' }}>
              {loading ? '注册中...' : '注册到区块链'}
            </button>
          </div>
        )}
      </div>

      {/* Agent 列表 */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">已注册智能体 ({agents.length})</span>
          <button className="btn-secondary btn-sm" onClick={loadAgents}>刷新</button>
        </div>

        {agents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🤖</div>
            <div className="empty-state-text">暂无智能体，点击上方注册按钮添加</div>
          </div>
        ) : (
          <div className="agent-list">
            {sortedAgents.map((a) => {
              const config = QUALIFICATION_CONFIG[a.qualification];
              return (
                <div
                  key={a.address}
                  className="agent-card"
                  onClick={() => setSelectedAgent(a)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div className="agent-avatar" style={{ background: config?.color ? `${config.color}20` : 'var(--bg-secondary)' }}>
                      {config?.icon || '🤖'}
                    </div>
                    <div className="agent-info">
                      <div className="agent-did">{a.did}</div>
                      <div className="agent-meta">
                        <span className={`badge qual-${a.qualification}`} style={{ marginRight: 6 }}>
                          {config?.name || a.qualification}
                        </span>
                        {a.isActive ? '活跃' : '未激活'}
                        {' · '}
                        {a.ratingCount} 次评分
                      </div>
                      <div className="agent-meta" style={{ fontFamily: 'monospace' }}>
                        {a.address.slice(0, 10)}...{a.address.slice(-6)}
                      </div>
                    </div>
                  </div>
                  <div className="agent-score">
                    <div className="score-value" style={{ color: getScoreColor(a.trustScore) }}>
                      {a.reputation}
                    </div>
                    <div className="score-label">信誉分</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Agent 详情弹窗 */}
      {selectedAgent && (
        <div className="modal-overlay" onClick={() => setSelectedAgent(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="card-header" style={{ marginBottom: 20 }}>
              <span className="card-title">
                {QUALIFICATION_CONFIG[selectedAgent.qualification]?.icon || '🤖'} Agent 详情
              </span>
              <button className="btn-secondary btn-sm" onClick={() => setSelectedAgent(null)}>关闭</button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>DID</div>
              <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', wordBreak: 'break-all' }}>{selectedAgent.did}</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>资质类型</div>
                <span className={`badge qual-${selectedAgent.qualification}`}>
                  {QUALIFICATION_CONFIG[selectedAgent.qualification]?.name || selectedAgent.qualification}
                </span>
              </div>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>状态</div>
                <span className={`badge ${selectedAgent.isActive ? 'badge-success' : 'badge-warning'}`}>
                  {selectedAgent.isActive ? '活跃' : '未激活'}
                </span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>信誉分</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 700, color: getScoreColor(selectedAgent.trustScore) }}>
                  {selectedAgent.reputation}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>评分次数</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 700 }}>{selectedAgent.ratingCount}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>排名</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--primary)' }}>
                  #{sortedAgents.findIndex(a => a.address === selectedAgent.address) + 1}
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>注册时间</div>
              <div>{formatTime(selectedAgent.registeredAt)}</div>
            </div>

            <div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>地址</div>
              <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 6, wordBreak: 'break-all' }}>
                {selectedAgent.address}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
