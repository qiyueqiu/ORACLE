import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import Dashboard from './pages/Dashboard';
import Dispatch from './pages/Dispatch';
import AuditLog from './pages/AuditLog';
import Reputation from './pages/Reputation';

type Tab = 'dashboard' | 'dispatch' | 'audit' | 'reputation';

const NAV_ITEMS: { key: Tab; icon: string; label: string }[] = [
  { key: 'dashboard', icon: '🤖', label: '智能体管理' },
  { key: 'dispatch', icon: '🚀', label: '任务调度' },
  { key: 'audit', icon: '📋', label: '审计日志' },
  { key: 'reputation', icon: '📊', label: '信誉分析' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [account, setAccount] = useState('');
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const loadAccount = async () => {
      try {
        const provider = new ethers.JsonRpcProvider('http://localhost:8545');
        const signer = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
        setAccount(signer.address);
        setConnected(true);
      } catch {
        setConnected(false);
      }
    };
    loadAccount();
  }, []);

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-icon">ASB</div>
          <h1>ASB Blockchain</h1>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map(item => (
            <button
              key={item.key}
              className={`nav-item ${tab === item.key ? 'active' : ''}`}
              onClick={() => setTab(item.key)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="connection-status">
            <span className={`status-dot ${connected ? '' : 'disconnected'}`} />
            <span>{connected ? `已连接 ${account.slice(0, 6)}...${account.slice(-4)}` : '未连接'}</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'dispatch' && <Dispatch />}
        {tab === 'audit' && <AuditLog />}
        {tab === 'reputation' && <Reputation />}
      </main>
    </div>
  );
}
