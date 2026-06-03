import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { getProvider, CONTRACT_ADDRESSES } from '../contracts/abis';

interface AuditRecord {
  id: number;
  timestamp: number;
  requester: string;
  targetAgent: string;
  taskDescription: string;
  decisionReason: number;
  executionStatus: number;
  executionResult: string;
  reputationRating: number;
  transactionHash: string;
}

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  '0': { label: '等待中', cls: 'badge-warning' },
  '1': { label: '成功', cls: 'badge-success' },
  '2': { label: '失败', cls: 'badge-danger' },
  '3': { label: '超时', cls: 'badge-accent' },
};

const AUDITLOG_ABI = [
  'function getAllRecords() view returns (uint256[] memory)',
  'function getRecord(uint256 recordId) view returns (uint256 id, uint256 timestamp, address requester, address targetAgent, bytes32 taskCommitment, uint8 decisionReason, uint8 executionStatus, string memory executionResult, uint256 reputationRating, bytes32 transactionHash)',
  'function getRecordFull(uint256 recordId) view returns (uint256 id, uint256 timestamp, address requester, address targetAgent, bytes32 taskCommitment, uint8 decisionReason, uint8 executionStatus, string memory executionResult, uint256 reputationRating, address routerSigner, bytes32 decisionDigest, address workerSigner)',
];

export default function AuditLog() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [filteredRecords, setFilteredRecords] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<AuditRecord | null>(null);

  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const loadRecords = async () => {
    setLoading(true);
    setError('');
    try {
      // 只读：直接用 provider，无需 signer
      const provider = getProvider();
      const auditLog = new ethers.Contract(CONTRACT_ADDRESSES.AuditLog, AUDITLOG_ABI, provider);
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

      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
      setFilteredRecords(list);
    } catch (e: any) {
      setError('加载审计日志失败: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadRecords(); }, []);

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
    setFilteredRecords(filtered);
  }, [records, agentFilter, statusFilter]);

  const stats = {
    total: records.length,
    success: records.filter(r => r.executionStatus === 1).length,
    failed: records.filter(r => r.executionStatus === 2).length,
    rated: records.filter(r => r.reputationRating > 0).length,
  };

  const formatTime = (ts: number) => new Date(ts * 1000).toLocaleString('zh-CN');
  const shortAddr = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <div className="page">
      <div className="page-header">
        <h2>审计日志</h2>
        <p>链上不可篡改的任务调度记录</p>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value text-primary">{stats.total}</div>
          <div className="stat-label">总记录</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-success">{stats.success}</div>
          <div className="stat-label">成功</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-danger">{stats.failed}</div>
          <div className="stat-label">失败</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-accent">{stats.rated}</div>
          <div className="stat-label">已评分</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">筛选</span>
          <button className="btn-secondary btn-sm" onClick={() => { setAgentFilter(''); setStatusFilter(''); }}>清除</button>
        </div>
        <div className="filter-row">
          <input
            placeholder="搜索 Agent 或任务描述..."
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
            style={{ flex: 2 }}
          />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ flex: 1 }}>
            <option value="">全部状态</option>
            <option value="0">等待中</option>
            <option value="1">成功</option>
            <option value="2">失败</option>
            <option value="3">超时</option>
          </select>
        </div>
        <div className="meta-text" style={{ marginTop: 8 }}>
          显示 {filteredRecords.length} / {records.length} 条
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">调度记录</span>
          <button className="btn-secondary btn-sm" onClick={loadRecords}>
            {loading ? '加载中...' : '刷新'}
          </button>
        </div>

        {filteredRecords.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <div className="empty-state-text">{loading ? '加载中...' : '暂无记录'}</div>
          </div>
        ) : (
          <div className="audit-records">
            {filteredRecords.map(r => {
              const status = STATUS_MAP[String(r.executionStatus)] || { label: '未知', cls: 'badge-warning' };
              return (
                <div key={r.id} className="audit-record-card" onClick={() => setSelectedRecord(r)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <span className={`badge ${status.cls}`}>{status.label}</span>
                        <span className="meta-text">#{r.id}</span>
                        <span className="meta-text">{formatTime(r.timestamp)}</span>
                      </div>
                      <div style={{ fontWeight: 500, marginBottom: 6 }}>{r.taskDescription}</div>
                      <div className="meta-text">
                        目标: <span style={{ fontFamily: 'monospace' }}>{shortAddr(r.targetAgent)}</span>
                      </div>
                    </div>
                    {r.reputationRating > 0 && (
                      <div style={{ fontSize: '1rem', color: 'var(--warning)' }}>
                        {'★'.repeat(r.reputationRating)}{'☆'.repeat(5 - r.reputationRating)}
                      </div>
                    )}
                  </div>
                  {r.executionResult && (
                    <div style={{
                      marginTop: 10, padding: 10, background: 'var(--bg-secondary)',
                      borderRadius: 6, fontSize: '0.85rem', color: 'var(--text-secondary)',
                      whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'hidden',
                    }}>
                      {r.executionResult.slice(0, 200)}{r.executionResult.length > 200 ? '...' : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedRecord && (
        <div className="modal-overlay" onClick={() => setSelectedRecord(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="card-header" style={{ marginBottom: 20 }}>
              <span className="card-title">调度记录 #{selectedRecord.id}</span>
              <button className="btn-secondary btn-sm" onClick={() => setSelectedRecord(null)}>关闭</button>
            </div>

            <div className="field-grid-2 modal-section">
              <div>
                <div className="field-label">时间</div>
                <div>{formatTime(selectedRecord.timestamp)}</div>
              </div>
              <div>
                <div className="field-label">状态</div>
                <span className={`badge ${(STATUS_MAP[String(selectedRecord.executionStatus)]?.cls || 'badge-warning')}`}>
                  {STATUS_MAP[String(selectedRecord.executionStatus)]?.label}
                </span>
              </div>
            </div>

            <div className="modal-section">
              <div className="field-label">任务描述</div>
              <div>{selectedRecord.taskDescription}</div>
            </div>

            <div className="field-grid-2 modal-section">
              <div>
                <div className="field-label">请求者</div>
                <div style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{selectedRecord.requester}</div>
              </div>
              <div>
                <div className="field-label">目标 Agent</div>
                <div style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{selectedRecord.targetAgent}</div>
              </div>
            </div>

            <div className="modal-section">
              <div className="field-label">执行结果</div>
              <div style={{
                padding: 12, background: 'var(--bg-secondary)', borderRadius: 6,
                whiteSpace: 'pre-wrap', fontSize: '0.85rem', maxHeight: 300, overflow: 'auto',
              }}>
                {selectedRecord.executionResult}
              </div>
            </div>

            {selectedRecord.reputationRating > 0 && (
              <div className="modal-section">
                <div className="field-label">信誉评分</div>
                <div style={{ fontSize: '1.5rem', color: 'var(--warning)' }}>
                  {'★'.repeat(selectedRecord.reputationRating)}{'☆'.repeat(5 - selectedRecord.reputationRating)}
                  <span style={{ fontSize: '0.9rem', marginLeft: 8 }}>({selectedRecord.reputationRating}/5)</span>
                </div>
              </div>
            )}

            <div>
              <div className="field-label">交易哈希</div>
              <div style={{
                fontFamily: 'monospace', fontSize: '0.75rem', padding: 10,
                background: 'var(--bg-secondary)', borderRadius: 6, wordBreak: 'break-all',
              }}>
                {selectedRecord.transactionHash}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
