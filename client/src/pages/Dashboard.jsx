// client/src/pages/Dashboard.jsx
import React, { useEffect, useState } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useTelegram } from '../hooks/useTelegram';
import { useTrading } from '../hooks/useTrading';
import StatsCard from '../components/Dashboard/StatsCard';
import AccountCard from '../components/Dashboard/AccountCard';
import SignalFeed from '../components/Dashboard/SignalFeed';
import TradeList from '../components/Dashboard/TradeList';

export default function Dashboard() {
  const { connected, emit } = useWebSocket();
  const { isConnected, channels } = useTelegram();
  const { accounts, stats } = useTrading();

  const [signals, setSignals] = useState([]);
  const [trades, setTrades] = useState([]);

  useEffect(() => {
    if (connected) {
      // Request initial data
      emit('dashboard:getData');
    }
  }, [connected]);

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Trading Dashboard</h1>
        <p className="text-gray-600 mt-2">
          Monitor your signals and trades in real-time
        </p>
      </div>

      {/* Connection Status */}
      <div className="mb-6 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}></div>
          <span className="text-sm font-medium">
            {connected ? 'Server Connected' : 'Server Disconnected'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
          <span className="text-sm font-medium">
            {isConnected ? 'Telegram Connected' : 'Telegram Disconnected'}
          </span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatsCard
          title="Total Trades"
          value={stats.totalTrades || 0}
          icon="📊"
          trend={stats.tradesTrend}
        />
        <StatsCard
          title="Win Rate"
          value={`${stats.winRate || 0}%`}
          icon="🎯"
          trend={stats.winRateTrend}
        />
        <StatsCard
          title="Total P/L"
          value={`$${stats.totalPnL || 0}`}
          icon="💰"
          trend={stats.pnlTrend}
          isProfit={stats.totalPnL >= 0}
        />
        <StatsCard
          title="Active Positions"
          value={stats.activePositions || 0}
          icon="🔥"
        />
      </div>

      {/* Accounts Grid */}
      <div className="mb-8">
        <h2 className="text-xl font-bold mb-4">Trading Accounts</h2>
        {accounts.length === 0 ? (
          <div className="bg-white rounded-lg p-8 text-center">
            <p className="text-gray-500">No accounts connected yet</p>
            <button className="mt-4 bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700">
              Add Account
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {accounts.map((account) => (
              <AccountCard key={account.id} account={account} />
            ))}
          </div>
        )}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Signal Feed */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-bold mb-4">Recent Signals</h2>
          <SignalFeed signals={signals} />
        </div>

        {/* Trade History */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-bold mb-4">Recent Trades</h2>
          <TradeList trades={trades} />
        </div>
      </div>

      {/* Channel Status */}
      <div className="mt-8 bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-bold mb-4">
          Active Channels ({channels.length})
        </h2>
        {channels.length === 0 ? (
          <p className="text-gray-500">No channels subscribed</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {channels.map((channel) => (
              <div
                key={channel.id}
                className="flex items-center gap-2 p-3 border rounded-lg"
              >
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                <span className="text-sm truncate">{channel.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
