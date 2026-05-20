import { useState, useEffect } from 'react';
import { getSigner, getContracts } from '../contracts/abis';
import { generateDID, generateSecret, generateCommitment, generateNullifier, hashSecret } from '../utils/did';

interface AgentInfo {
  address: string;
  did: string;
  qualification: string;
  isActive: boolean;
  reputation: string;
  ratingCount: number;
  registeredAt: number;
  trustScore: number; // 可信度评分
}

const QUALIFICATION_TYPES = ['weather', 'content', 'calc'];

// 资质权重配置
const QUALIFICATION_WEIGHTS: Record<string, number> = {
  weather: 1.0,
  content: 1.0,
  calc: 1.2, // calc 类型权重稍高
};

// 资质显示名称
const QUALIFICATION_NAMES: Record<string, string> = {
  weather: '🌤️ 天气服务',
  content: '📝 内容创作',
  calc: '🔢 计算服务',
};

export default function Dashboard() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [didName, setDidName] = useState('');
  const [qualType, setQualType] = useState('weather');
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);

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
        const qualWeight = QUALIFICATION_WEIGHTS[agent[3]] || 1.0;

        list.push({
          address: addr,
          did: agent[1],
          qualification: agent[3],
          isActive: agent[4],
          reputation: avgRep.toFixed(1),
          ratingCount: Number(rep[1]),
          registeredAt: Number(agent[5]),
          trustScore: avgRep * qualWeight, // 可信度 = 信誉 × 资质权重
        });
      }
      setAgents(list);
    } catch (e: any) {
      setError('加载智能体失败: ' + e.message);
    }
  };

  useEffect(() => {
    loadAgents();
  }, []);

  const handleRegister = async () => {
    if (!didName.trim()) {
      setError('请输入 DID 名称');
      return;
    }
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
      await loadAgents();
    } catch (e: any) {
      setError('注册失败: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  // 统计信息
  const stats = {
    total: agents.length,
    active: agents.filter(a => a.isActive).length,
    avgReputation: agents.length > 0
      ? (agents.reduce((sum, a) => sum + parseFloat(a.reputation), 0) / agents.length).toFixed(1)
      : '0.0',
    byQualification: {
      weather: agents.filter(a => a.qualification === 'weather').length,
      content: agents.filter(a => a.qualification === 'content').length,
      calc: agents.filter(a => a.qualification === 'calc').length,
    }
  };

  // 按可信度排序
  const sortedAgents = [...agents].sort((a, b) => b.trustScore - a.trustScore);

  const formatTime = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString('zh-CN');
  };

  const getTrustScoreColor = (score: number) => {
    if (score >= 5.0) return '#10b981'; // green
    if (score >= 4.0) return '#3b82f6'; // blue
    if (score >= 3.0) return '#f59e0b'; // yellow
    return '#ef4444'; // red
  };

  return (
    <div className="page">
      <h2>🤖 智能体控制台</h2>
      {error && <div className="error-msg">{error}</div>}

      {/* 统计卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--accent)' }}>{stats.total}</div>
          <div style={{ color: 'var(--text-dim)' }}>总 Agent 数</div>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--success)' }}>{stats.active}</div>
          <div style={{ color: 'var(--text-dim)' }}>活跃 Agent</div>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--primary)' }}>{stats.avgReputation}</div>
          <div style={{ color: 'var(--text-dim)' }}>平均信誉分</div>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>
            🌤️ {stats.byQualification.weather} | 📝 {stats.byQualification.content} | 🔢 {stats.byQualification.calc}
          </div>
          <div style={{ color: 'var(--text-dim)' }}>资质分布</div>
        </div>
      </div>

      {/* 注册表单 */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>📝 注册新智能体</h3>
        <div className="form-row">
          <input
            placeholder="智能体名称 (例如: WeatherBot)"
            value={didName}
            onChange={e => setDidName(e.target.value)}
          />
          <select value={qualType} onChange={e => setQualType(e.target.value)}>
            {QUALIFICATION_TYPES.map(t => (
              <option key={t} value={t}>{QUALIFICATION_NAMES[t] || t}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={handleRegister} disabled={loading}>
            {loading ? '注册中...' : '注册'}
          </button>
        </div>
        <div style={{ marginTop: '12px', fontSize: '0.85rem', color: 'var(--text-dim)' }}>
          💡 提示：当前连接账户将作为 Agent 所有者
        </div>
      </div>

      {/* Agent 列表 */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3>已注册智能体 ({agents.length})</h3>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>
            按可信度排序 ↑
          </div>
        </div>

        {agents.length === 0 ? (
          <div className="empty-state">暂无智能体</div>
        ) : (
          <div className="agent-list">
            {sortedAgents.map((a, index) => (
              <div
                key={a.address}
                className="agent-card"
                onClick={() => setSelectedAgent(a)}
                style={{ cursor: 'pointer', borderLeft: `4px solid ${getTrustScoreColor(a.trustScore)}` }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    background: 'var(--primary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 'bold',
                    color: 'white'
                  }}>
                    #{index + 1}
                  </div>
                  <div className="agent-info" style={{ flex: 1 }}>
                    <div className="agent-did">{a.did}</div>
                    <div className="agent-meta">
                      {QUALIFICATION_NAMES[a.qualification] || a.qualification}
                      {' • '}
                      {a.isActive ? '✅ 活跃' : '❌ 未激活'}
                      {' • '}
                      {a.ratingCount} 个评分
                    </div>
                    <div className="agent-meta" style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                      {a.address.slice(0, 10)}...{a.address.slice(-8)}
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="agent-score">
                    <div className="score-value" style={{ color: getTrustScoreColor(a.trustScore) }}>
                      {a.reputation}
                    </div>
                    <div className="score-label">信誉分</div>
                  </div>
                  <div style={{
                    fontSize: '0.75rem',
                    color: 'var(--text-dim)',
                    marginTop: '4px'
                  }}>
                    可信度: <strong>{a.trustScore.toFixed(1)}</strong>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Agent 详情弹窗 */}
      {selectedAgent && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }} onClick={() => setSelectedAgent(null)}>
          <div className="card" style={{ maxWidth: '500px', width: '90%' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: '16px' }}>🤖 Agent 详情</h3>

            <div style={{ marginBottom: '12px' }}>
              <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>DID</label>
              <div style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{selectedAgent.did}</div>
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>地址</label>
              <div style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{selectedAgent.address}</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
              <div>
                <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>资质类型</label>
                <div>{QUALIFICATION_NAMES[selectedAgent.qualification] || selectedAgent.qualification}</div>
              </div>
              <div>
                <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>状态</label>
                <div>{selectedAgent.isActive ? '✅ 活跃' : '❌ 未激活'}</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '12px' }}>
              <div>
                <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>信誉分</label>
                <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: getTrustScoreColor(selectedAgent.trustScore) }}>
                  {selectedAgent.reputation} / 5.0
                </div>
              </div>
              <div>
                <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>评分次数</label>
                <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{selectedAgent.ratingCount}</div>
              </div>
              <div>
                <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>可信度</label>
                <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: getTrustScoreColor(selectedAgent.trustScore) }}>
                  {selectedAgent.trustScore.toFixed(1)}
                </div>
              </div>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>注册时间</label>
              <div>{formatTime(selectedAgent.registeredAt)}</div>
            </div>

            <button className="btn-primary" onClick={() => setSelectedAgent(null)} style={{ width: '100%' }}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
