import { useState, useEffect } from 'react';
import { QUALIFICATION_CONFIG } from '../contracts/abis';

interface AgentSummary {
  address: string;
  did: string;
  qualification: string;
  isActive: boolean;
  avgRating: number;
  ratingCount: number;
  totalScore: number;
  totalTasks: number;
  successRate: number;
  trend: string;
  reliabilityLevel: string;
}

const API_BASE = 'http://localhost:3001';

const TREND_MAP: Record<string, { label: string; icon: string; cls: string }> = {
  improving: { label: '上升', icon: '📈', cls: 'badge-success' },
  stable: { label: '稳定', icon: '➡️', cls: 'badge-info' },
  declining: { label: '下降', icon: '📉', cls: 'badge-danger' },
  new: { label: '新 Agent', icon: '🆕', cls: 'badge-accent' },
  insufficient_data: { label: '数据不足', icon: '❓', cls: 'badge-warning' },
};

const RELIABILITY_MAP: Record<string, { label: string; icon: string; cls: string; desc: string }> = {
  highly_reliable: { label: '高可靠', icon: '🌟', cls: 'badge-success', desc: '评分≥80且≥3次评估' },
  reliable: { label: '可靠', icon: '✅', cls: 'badge-primary', desc: '评分≥60且≥3次评估' },
  evaluating: { label: '评估中', icon: '⏳', cls: 'badge-accent', desc: '已有评分但不足3次' },
  unreliable: { label: '不可靠', icon: '⚠️', cls: 'badge-danger', desc: '评分<60且≥3次评估' },
  unrated: { label: '未评估', icon: '❔', cls: 'badge-warning', desc: '尚未执行过任务' },
};

const QUALITY_LABELS: Record<string, { label: string; color: string }> = {
  excellent: { label: '优秀', color: 'var(--success)' },
  good: { label: '良好', color: 'var(--primary)' },
  acceptable: { label: '合格', color: 'var(--warning)' },
  poor: { label: '较差', color: '#f97316' },
  failing: { label: '不合格', color: 'var(--danger)' },
};

export default function Reputation() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<AgentSummary | null>(null);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/reputation/summary`);
      const data = await res.json();
      setAgents(data.agents || []);
    } catch (e: any) {
      setError('加载信誉数据失败: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const ratedAgents = agents.filter(a => a.ratingCount > 0);
  const avgRating = ratedAgents.length > 0
    ? Math.round(ratedAgents.reduce((s, a) => s + a.avgRating, 0) / ratedAgents.length)
    : 0;
  const reliableAgents = agents.filter(a =>
    a.reliabilityLevel === 'highly_reliable' || a.reliabilityLevel === 'reliable'
  ).length;
  const avgSuccessRate = agents.length > 0
    ? Math.round(agents.reduce((s, a) => s + a.successRate, 0) / agents.length)
    : 0;

  const getRatingColor = (rating: number) => {
    if (rating >= 80) return 'var(--success)';
    if (rating >= 60) return 'var(--primary)';
    if (rating >= 40) return 'var(--warning)';
    return 'var(--danger)';
  };

  const getRatingLevel = (rating: number) => {
    if (rating >= 80) return '优秀';
    if (rating >= 60) return '良好';
    if (rating >= 40) return '合格';
    if (rating >= 20) return '较差';
    return '不合格';
  };

  const sortedAgents = [...agents].sort((a, b) => b.avgRating - a.avgRating);

  return (
    <div className="page">
      <div className="page-header">
        <h2>信誉分析</h2>
        <p>百分制信誉评估系统 — 多维度执行质量分析 + 用户评价</p>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value text-primary">{agents.length}</div>
          <div className="stat-label">注册 Agent</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-success">{reliableAgents}</div>
          <div className="stat-label">可靠 Agent</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-accent">{avgRating}</div>
          <div className="stat-label">平均信誉分</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-info">{avgSuccessRate}%</div>
          <div className="stat-label">平均成功率</div>
        </div>
      </div>

      {/* 可靠性等级说明 */}
      <div className="card" style={{ background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)', borderColor: '#bae6fd' }}>
        <div className="card-header">
          <span className="card-title">🏷️ 可靠性等级</span>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {Object.entries(RELIABILITY_MAP).map(([key, val]) => (
            <div key={key} style={{
              padding: '8px 14px', borderRadius: 8, background: 'white',
              border: '1px solid #e2e8f0', fontSize: '0.85rem',
            }}>
              <span className={`badge ${val.cls}`}>{val.icon} {val.label}</span>
              <span style={{ marginLeft: 8, color: 'var(--text-dim)', fontSize: '0.8rem' }}>{val.desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 信誉排行 */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Agent 信誉排行</span>
          <button className="btn-secondary btn-sm" onClick={loadData}>
            {loading ? '加载中...' : '刷新'}
          </button>
        </div>

        {agents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📊</div>
            <div className="empty-state-text">
              {loading ? '加载中...' : '暂无数据。执行任务后，信誉分析 Agent 会自动评估并调整评分。'}
            </div>
          </div>
        ) : (
          <div className="agent-list">
            {sortedAgents.map((agent, index) => {
              const config = QUALIFICATION_CONFIG[agent.qualification];
              const trend = TREND_MAP[agent.trend] || TREND_MAP.insufficient_data;
              const reliability = RELIABILITY_MAP[agent.reliabilityLevel] || RELIABILITY_MAP.unrated;

              return (
                <div key={agent.address} className="agent-card" onClick={() => setSelectedAgent(agent)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: 10,
                      background: 'var(--primary-light)', display: 'flex',
                      alignItems: 'center', justifyContent: 'center',
                      fontWeight: 700, color: 'var(--primary)', fontSize: '0.9rem',
                    }}>
                      #{index + 1}
                    </div>
                    <div className="agent-avatar" style={{ background: config ? `${config.color}20` : 'var(--bg-secondary)' }}>
                      {config?.icon || '🤖'}
                    </div>
                    <div className="agent-info">
                      <div className="agent-did">{agent.did}</div>
                      <div className="agent-meta">
                        <span className={`badge qual-${agent.qualification}`} style={{ marginRight: 6 }}>
                          {config?.name || agent.qualification}
                        </span>
                        <span className={`badge ${reliability.cls}`} style={{ marginRight: 6 }}>
                          {reliability.icon} {reliability.label}
                        </span>
                        <span className={`badge ${trend.cls}`} style={{ marginRight: 6 }}>
                          {trend.icon} {trend.label}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div style={{ minWidth: 200 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, color: getRatingColor(agent.avgRating) }}>
                        {agent.avgRating} / 100
                      </span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                        {agent.ratingCount} 次评分
                      </span>
                    </div>
                    <div className="reputation-bar">
                      <div className="reputation-bar-track">
                        <div
                          className="reputation-bar-fill"
                          style={{
                            width: `${agent.avgRating}%`,
                            background: getRatingColor(agent.avgRating),
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 评分机制说明 */}
      <div className="card" style={{ background: 'linear-gradient(135deg, #fefce8 0%, #fef9c3 100%)', borderColor: '#fde68a' }}>
        <div className="card-header">
          <span className="card-title">📋 百分制信誉评分机制</span>
        </div>
        <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>五维评分体系（满分 100）</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: '0.85rem' }}>
              <div style={{ padding: '6px 10px', background: 'rgba(255,255,255,0.6)', borderRadius: 6 }}>
                <strong>准确性 (30分)</strong> — 结果是否正确回答了任务核心问题
              </div>
              <div style={{ padding: '6px 10px', background: 'rgba(255,255,255,0.6)', borderRadius: 6 }}>
                <strong>完整性 (25分)</strong> — 是否覆盖了任务的所有方面
              </div>
              <div style={{ padding: '6px 10px', background: 'rgba(255,255,255,0.6)', borderRadius: 6 }}>
                <strong>专业性 (20分)</strong> — 是否体现了专业知识深度
              </div>
              <div style={{ padding: '6px 10px', background: 'rgba(255,255,255,0.6)', borderRadius: 6 }}>
                <strong>实用性 (15分)</strong> — 结果是否具有实际可操作性
              </div>
              <div style={{ padding: '6px 10px', background: 'rgba(255,255,255,0.6)', borderRadius: 6 }}>
                <strong>规范性 (10分)</strong> — 格式是否清晰、逻辑是否连贯
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--success)' }}>质量等级</div>
              <ul style={{ paddingLeft: 20, fontSize: '0.85rem' }}>
                <li><strong style={{ color: 'var(--success)' }}>≥80</strong> — 优秀：完美完成</li>
                <li><strong style={{ color: 'var(--primary)' }}>≥60</strong> — 良好：基本正确</li>
                <li><strong style={{ color: 'var(--warning)' }}>≥40</strong> — 合格：部分完成</li>
              </ul>
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--danger)' }}>惩罚机制</div>
              <ul style={{ paddingLeft: 20, fontSize: '0.85rem' }}>
                <li><strong>&lt;40分</strong> — 链上惩罚 +10</li>
                <li><strong>&lt;20分</strong> — 链上惩罚 +30</li>
                <li>连续低分 → 标记为不可靠</li>
              </ul>
            </div>
          </div>
          <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(255,255,255,0.6)', borderRadius: 6, fontSize: '0.85rem' }}>
            <strong>评分流程：</strong>任务执行完成 → 信誉分析 Agent 五维评分 → 评分提交到区块链 → 用户评价 → Router Agent 使用信誉数据优化路由
          </div>
        </div>
      </div>

      {/* Agent 详情弹窗 */}
      {selectedAgent && (
        <div className="modal-overlay" onClick={() => setSelectedAgent(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="card-header" style={{ marginBottom: 20 }}>
              <span className="card-title">📊 Agent 信誉详情</span>
              <button className="btn-secondary btn-sm" onClick={() => setSelectedAgent(null)}>关闭</button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>Agent</div>
              <div style={{ fontWeight: 600 }}>{selectedAgent.did}</div>
              <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: 2 }}>
                {selectedAgent.address}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>资质</div>
                <span className={`badge qual-${selectedAgent.qualification}`}>
                  {QUALIFICATION_CONFIG[selectedAgent.qualification]?.icon} {QUALIFICATION_CONFIG[selectedAgent.qualification]?.name}
                </span>
              </div>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>可靠性</div>
                <span className={`badge ${(RELIABILITY_MAP[selectedAgent.reliabilityLevel]?.cls || 'badge-warning')}`}>
                  {RELIABILITY_MAP[selectedAgent.reliabilityLevel]?.icon} {RELIABILITY_MAP[selectedAgent.reliabilityLevel]?.label}
                </span>
              </div>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>趋势</div>
                <span className={`badge ${(TREND_MAP[selectedAgent.trend]?.cls || 'badge-warning')}`}>
                  {TREND_MAP[selectedAgent.trend]?.icon} {TREND_MAP[selectedAgent.trend]?.label}
                </span>
              </div>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>状态</div>
                <span className={`badge ${selectedAgent.isActive ? 'badge-success' : 'badge-danger'}`}>
                  {selectedAgent.isActive ? '🟢 活跃' : '🔴 停用'}
                </span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>信誉分</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 700, color: getRatingColor(selectedAgent.avgRating) }}>
                  {selectedAgent.avgRating}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>成功率</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--primary)' }}>
                  {selectedAgent.successRate}%
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>评分次数</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 700 }}>{selectedAgent.ratingCount}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 4 }}>总分</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 700 }}>{selectedAgent.totalScore}</div>
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: 8 }}>信誉评分进度</div>
              <div className="reputation-bar" style={{ height: 14 }}>
                <div className="reputation-bar-track" style={{ height: 14 }}>
                  <div
                    className="reputation-bar-fill"
                    style={{
                      width: `${selectedAgent.avgRating}%`,
                      background: getRatingColor(selectedAgent.avgRating),
                    }}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: 4 }}>
                <span>0</span>
                <span style={{ color: 'var(--warning)' }}>▲ 合格 (≥40)</span>
                <span style={{ color: 'var(--primary)' }}>▲ 良好 (≥60)</span>
                <span style={{ color: 'var(--success)' }}>▲ 优秀 (≥80)</span>
                <span>100</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
