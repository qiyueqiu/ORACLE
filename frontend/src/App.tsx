import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import Dashboard from './pages/Dashboard';
import Dispatch from './pages/Dispatch';
import AuditLog from './pages/AuditLog';

type Tab = 'dashboard' | 'dispatch' | 'audit';

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [account, setAccount] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const loadAccount = async () => {
      try {
        const provider = new ethers.JsonRpcProvider('http://localhost:8545');
        const signer = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
        setAccount(signer.address);
      } catch (e: any) {
        setError('无法连接区块链。Hardhat 节点是否在 localhost:8545 运行？');
      }
    };
    loadAccount();
  }, []);

  return (
    <div>
      <div className="header">
        <h1>🏗️ ASB + 区块链演示</h1>
        {account ? (
          <div className="wallet-info">
            已连接: {account.slice(0, 6)}...{account.slice(-4)}
          </div>
        ) : (
          <div className="wallet-info" style={{ color: 'var(--warning)' }}>
            未连接
          </div>
        )}
      </div>

      {error && <div className="error-msg" style={{ marginBottom: 20 }}>{error}</div>}

      <div className="tabs">
        {(['dashboard', 'dispatch', 'audit'] as Tab[]).map(t => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'dashboard' ? '控制台' : t === 'dispatch' ? '任务调度' : '审计日志'}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && <Dashboard />}
      {tab === 'dispatch' && <Dispatch />}
      {tab === 'audit' && <AuditLog />}
    </div>
  );
}
