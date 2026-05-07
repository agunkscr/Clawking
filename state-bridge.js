import EventEmitter from 'events';

class DashboardState extends EventEmitter {
  constructor() {
    super();
    this.agents = {};            // key: agentId -> { id, hp, ep, status, rewards, inventory, ... }
    this.global = {
      totalWins: 0,
      totalMoltz: 0,
      totalSmoltz: 0,
      totalCross: 0,
      botsRunning: 0,
    };
    this.logs = [];
    this.maxLogs = 500;
    this.uptime = Date.now();
  }

  updateAgent(agentId, data) {
    if (!this.agents[agentId]) {
      this.agents[agentId] = { id: agentId, inventory: [], rewards: {} };
      this.global.botsRunning = Object.keys(this.agents).length;
    }
    Object.assign(this.agents[agentId], data);
    this.agents[agentId].lastUpdate = Date.now();
    // Update global stats if provided
    if (data.totalWins !== undefined) this.global.totalWins = data.totalWins;
    if (data.totalMoltz !== undefined) this.global.totalMoltz = data.totalMoltz;
    if (data.totalSmoltz !== undefined) this.global.totalSmoltz = data.totalSmoltz;
    if (data.totalCross !== undefined) this.global.totalCross = data.totalCross;
    this.emit('agent_update', agentId);
  }

  addLog(agentId, message, type = 'info') {
    const entry = { agentId, message, type, time: Date.now() };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    this.emit('log', entry);
  }

  getSnapshot() {
    return {
      agents: this.agents,
      global: this.global,
      logs: this.logs.slice(-50), // hanya kirim 50 terakhir
      uptime: this.uptime,
      timestamp: Date.now(),
    };
  }
}

// Singleton
const dashboardState = new DashboardState();
export default dashboardState;