import { useState, useEffect } from 'react';
import { getSigner, getContracts } from '../contracts/abis';

interface AuditRecord {
  id: number;
  timestamp: number;
  requester: string;
  targetAgent: string;
  taskDescription: string;
  decisionReason: number; // enum
  executionStatus: number; // enum
  executionResult: string;
  reputationRating: number;
  transactionHash: string;
}

const DECISION_REASON_NAMES: Record<string, string> = {
  '0': '✅ 资质合格',
  '1': '⚠️ 信誉不足',
  '2': '❌ 未注册',
  '3': '❌ 证明无效',
  '4': '❌ 未激活',
};

const EXECUTION_STATUS_NAMES: Record<string, { label: string; color: string }> = {
  '0': { label: '⏳ 等待中', color: '#f59e0b' },
  '1': { label: '✅ 成功', color: '#10b981' },
  '2': { label: '❌ 失败', color: '#ef4444' },
  '3': { label: '⏰ 超时', color: '#6366f1' },
};

export default function AuditLog() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [filteredRecords, setFilteredRecords] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<AuditRecord | null>(null);

  // 筛选条件
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [resultFilter, setResultFilter] = useState<string>('');

  const loadRecords = async () => {
    setLoading(true);
    setError('');
    try {
      const signer = await getSigner();
      const { auditLog } = getContracts(signer);
      const allIds = await auditLog.getAllRecords();
      const list: AuditRecord[] = [];

      for (const id of allIds) {
        const rec = await auditLog.getRecord(Number(id));
        list.push({
          id: Number(rec[0]),
          timestamp: Number(rec[1]),
          requester: rec[2],
          targetAgent: rec[3],
          taskDescription: rec[4],
          decisionReason: Number(rec[5]),
          executionStatus: Number(rec[6]),
          executionResult: rec[7],
          reputationRating: Number(rec[8]),
          transactionHash: rec[9],
        });
      }

      // 按时间倒序排列
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
      setFilteredRecords(list);
    } catch (e: any) {
      setError('加载审计日志失败: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRecords();
  }, []);

  // 应用筛选
  useEffect(() => {
    let filtered = [...records];

    if (agentFilter) {
      filtered = filtered.filter(r =>
        r.targetAgent.toLowerCase().includes(agentFilter.toLowerCase()) ||
        r.taskDescription.toLowerCase().includes(agentFilter.toLowerCase())
      );
    }

    if (statusFilter !== '') {
      filtered = filtered.filter(r => r.executionStatus === Number(statusFilter));
    }

    if (resultFilter === 'rated') {
      filtered = filtered.filter(r => r.reputationRating > 0);
    } else if (resultFilter === 'unrated') {
      filtered = filtered.filter(r => r.reputationRating === 0);
    }

    setFilteredRecords(filtered);
  }, [records, agentFilter, statusFilter, resultFilter]);

  const formatTime = (ts: number) => {
    return new Date(ts * 1000).toLocaleString('zh-CN');
  };

  const formatAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  // 统计信息
  const stats = {
    total: records.length,
    success: records.filter(r => r.executionStatus === 1).length,
    failed: records.filter(r => r.executionStatus === 2).length,
    pending: records.filter(r => r.executionStatus === 0).length,
    rated: records.filter(r => r.reputationRating > 0).length,
  };

  return (
    <div className="page">
      <h2>📋 审计日志</h2>
      {error && <div className="error-msg">{error}</div>}

      {/* 统计卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        <div className="card" style={{ textAlign: 'center', padding: '16px' }}>
          <div style={{ fontSize: '1.8rem', fontWeight: 'bold' }}>{stats.total}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>总记录</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '16px' }}>
          <div style={{ fontSize: '1.8rem', fontWeight: 'bold', color: '#10b981' }}>{stats.success}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>成功</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '16px' }}>
          <div style={{ fontSize: '1.8rem', fontWeight: 'bold', color: '#ef4444' }}>{stats.failed}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>失败</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '16px' }}>
          <div style={{ fontSize: '1.8rem', fontWeight: 'bold', color: '#f59e0b' }}>{stats.pending}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>等待中</div>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '16px' }}>
          <div style={{ fontSize: '1.8rem', fontWeight: 'bold', color: '#8b5cf6' }}>{stats.rated}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>已评分</div>
        </div>
      </div>

      {/* 筛选器 */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>🔍 筛选条件</h3>
        <div className="filter-row" style={{ flexWrap: 'wrap' }}>
          <input
            placeholder="搜索 Agent 地址或任务描述..."
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
            style={{ flex: '2', minWidth: '200px' }}
          />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            style={{ flex: '1', minWidth: '120px' }}
          >
            <option value="">全部状态</option>
            <option value="0">⏳ 等待中</option>
            <option value="1">✅ 成功</option>
            <option value="2">❌ 失败</option>
            <option value="3">⏰ 超时</option>
          </select>
          <select
            value={resultFilter}
            onChange={e => setResultFilter(e.target.value)}
            style={{ flex: '1', minWidth: '120px' }}
          >
            <option value="">全部评分</option>
            <option value="rated">⭐ 已评分</option>
            <option value="unrated">○ 未评分</option>
          </select>
          <button className="btn-primary" onClick={() => { setAgentFilter(''); setStatusFilter(''); setResultFilter(''); }}>
            清除
          </button>
        </div>
        <div style={{ marginTop: '8px', fontSize: '0.85rem', color: 'var(--text-dim)' }}>
          显示 {filteredRecords.length} / {records.length} 条记录
        </div>
      </div>

      {/* 记录列表 */}
      <div className="card">
        <h3>调度记录 ({filteredRecords.length})</h3>
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : filteredRecords.length === 0 ? (
          <div className="empty-state">暂无记录</div>
        ) : (
          <div className="audit-records">
            {filteredRecords.map((r) => (
              <div
                key={r.id}
                className="audit-record-card"
                onClick={() => setSelectedRecord(r)}
                style={{
                  borderLeft: `4px solid ${EXECUTION_STATUS_NAMES[String(r.executionStatus)]?.color || '#ccc'}`,
                  cursor: 'pointer'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <span style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        background: EXECUTION_STATUS_NAMES[String(r.executionStatus)]?.color || '#ccc',
                        color: 'white'
                      }}>
                        {EXECUTION_STATUS_NAMES[String(r.executionStatus)]?.label || '未知'}
                      </span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                        #{r.id}
                      </span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                        {formatTime(r.timestamp)}
                      </span>
                    </div>

                    <div style={{ marginBottom: '8px' }}>
                      <strong>任务:</strong> {r.taskDescription}
                    </div>

                    <div style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>
                      <div>👤 请求者: <span style={{ fontFamily: 'monospace' }}>{formatAddress(r.requester)}</span></div>
                      <div>🤖 目标 Agent: <span style={{ fontFamily: 'monospace' }}>{formatAddress(r.targetAgent)}</span></div>
                    </div>
                  </div>

                  <div style={{ textAlign: 'right' }}>
                    {r.reputationRating > 0 && (
                      <div style={{ fontSize: '1.2rem' }}>
                        {'⭐'.repeat(r.reputationRating)}
                      </div>
                    )}
                  </div>
                </div>

                {r.executionResult && (
                  <div style={{
                    marginTop: '8px',
                    padding: '8px',
                    background: 'rgba(0,0,0,0.03)',
                    borderRadius: '4px',
                    fontSize: '0.85rem',
                    whiteSpace: 'pre-wrap'
                  }}>
                    💬 {r.executionResult}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 详情弹窗 */}
      {selectedRecord && (
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
        }} onClick={() => setSelectedRecord(null)}>
          <div className="card" style={{ maxWidth: '600px', width: '90%', maxHeight: '80vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: '16px' }}>📋 调度记录详情 #{selectedRecord.id}</h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
              <div>
                <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>时间</label>
                <div>{formatTime(selectedRecord.timestamp)}</div>
              </div>
              <div>
                <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>状态</label>
                <div style={{ color: EXECUTION_STATUS_NAMES[String(selectedRecord.executionStatus)]?.color }}>
                  {EXECUTION_STATUS_NAMES[String(selectedRecord.executionStatus)]?.label}
                </div>
              </div>
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>任务描述</label>
              <div>{selectedRecord.taskDescription}</div>
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>请求者</label>
              <div style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{selectedRecord.requester}</div>
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>目标 Agent</label>
              <div style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{selectedRecord.targetAgent}</div>
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>决策原因</label>
              <div>{DECISION_REASON_NAMES[String(selectedRecord.decisionReason)]}</div>
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>执行结果</label>
              <div style={{ whiteSpace: 'pre-wrap' }}>{selectedRecord.executionResult}</div>
            </div>

            {selectedRecord.reputationRating > 0 && (
              <div style={{ marginBottom: '12px' }}>
                <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>信誉评分</label>
                <div style={{ fontSize: '1.2rem' }}>
                  {'⭐'.repeat(selectedRecord.reputationRating)} ({selectedRecord.reputationRating}/5)
                </div>
              </div>
            )}

            <div style={{ marginBottom: '16px' }}>
              <label style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>交易哈希</label>
              <div style={{
                fontFamily: 'monospace',
                fontSize: '0.75rem',
                wordBreak: 'break-all',
                padding: '8px',
                background: 'rgba(0,0,0,0.03)',
                borderRadius: '4px'
              }}>
                {selectedRecord.transactionHash}
              </div>
            </div>

            <button className="btn-primary" onClick={() => setSelectedRecord(null)} style={{ width: '100%' }}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
