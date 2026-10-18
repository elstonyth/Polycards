export type MonitoredAccount = {
  id: string;
  name: string | null;
  email: string | null;
  balance: number | null;
  status: 'active' | 'frozen' | 'disabled' | 'unavailable';
};

export type AutomationMonitorSnapshot = {
  mode: 'read-only';
  automationEnabled: false;
  updatedAt: string;
  accounts: MonitoredAccount[];
};

export type MonitorLeaderboard = {
  period: 'weekly' | 'alltime';
  entries: {
    rank: number;
    name: string;
    handle: string | null;
    volume: number;
    pulls: number;
  }[];
};
