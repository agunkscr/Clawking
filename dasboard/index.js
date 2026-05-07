import 'dotenv/config';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { decideActions } from './strategy.js';
import dashboardState from './state-bridge.js';
import { startDashboard } from './dashboard-server.js';

const BASE = 'https://cdn.moltyroyale.com/api';
const WS_JOIN = 'wss://cdn.moltyroyale.com/ws/join';
const WS_AGENT = 'wss://cdn.moltyroyale.com/ws/agent';

let VERSION = 'unknown';
let HEADERS = {};

async function init() {
  try {
    const vRes = await fetch(`${BASE}/version`);
    if (vRes.status === 426) { console.error('Outdated client!'); process.exit(1); }
    const vData = await vRes.json();
    VERSION = vData.data.version;
  } catch (e) { console.warn('Version fetch failed:', e.message); }
  HEADERS = {
    'X-Version': VERSION,
    'Authorization': `mr-auth ${process.env.API_KEY}`,
    'Content-Type': 'application/json'
  };
}

// Variabel untuk melacak data agent
let currentAgentId = 'primary'; // sesuaikan jika multi-agent
let gameStats = { totalWins: 0, totalMoltz: 0, totalSmoltz: 0, totalCross: 0 };

function updateDashboardFromView(view) {
  const self = view.self || {};
  const hp = self.hp ?? 100;
  const ep = self.ep ?? 10;
  const status = self.isAlive ? 'alive' : 'dead';
  const rewards = {
    sMoltz: self.rewards?.sMoltz || 0,
    Moltz: self.rewards?.Moltz || 0,
  };
  dashboardState.updateAgent(currentAgentId, {
    name: 'BotAgent',
    hp, ep, status, rewards,
    inventory: self.inventory || [],
  });
}

async function main() {
  console.log('=== Molty Royale Bot ===');
  try {
    const meRes = await fetch(`${BASE}/accounts/me`, { headers: HEADERS });
    if (!meRes.ok) {
      if (meRes.status === 401) { console.error('Invalid API Key'); process.exit(1); }
      console.error(`/accounts/me error ${meRes.status}`);
      return delayAndRetry(60000);
    }
    const me = (await meRes.json()).data;
    console.log(`Identity: ${me.readiness.erc8004Id ? 'OK' : 'MISSING'}`);

    if (!me.readiness.erc8004Id) {
      console.error('No ERC-8004 identity. Exiting.');
      process.exit(0);
    }

    // Update global stats jika ada
    if (me.stats) {
      gameStats.totalWins = me.stats.totalWins || 0;
      gameStats.totalMoltz = me.stats.moltz || 0;
      gameStats.totalSmoltz = me.stats.smoltz || 0;
      dashboardState.updateAgent(currentAgentId, gameStats);
    }

    if (me.currentGames && me.currentGames.length > 0) {
      const game = me.currentGames[0];
      return playGameViaAgentSocket(game.gameId);
    }

    const entryType = process.env.ENTRY_TYPE || 'free';
    if (entryType === 'paid') {
      console.warn('Paid mode not implemented. Use free.');
      process.exit(0);
    } else {
      return joinFree();
    }
  } catch (error) {
    console.error('Main loop error:', error);
    delayAndRetry(10000);
  }
}

function delayAndRetry(ms) {
  setTimeout(main, ms);
}

function joinFree() {
  const ws = new WebSocket(WS_JOIN, { headers: HEADERS });
  ws.on('open', () => console.log('/ws/join opened'));
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'welcome') {
      ws.send(JSON.stringify({ type: 'hello', entryType: 'free' }));
    } else if (msg.type === 'game_started') {
      dashboardState.addLog(currentAgentId, `Game started: ${msg.gameId}`);
      playGameLoop(ws, msg.gameId);
    } else if (msg.type === 'error') {
      console.error('Join error:', msg.error);
      ws.close();
    }
  });
  ws.on('close', (code) => { console.log(`Join closed (${code})`); delayAndRetry(5000); });
  ws.on('error', (e) => console.error('WS join error:', e.message));
}

function playGameLoop(ws, gameId) {
  console.log(`Playing game ${gameId}`);
  let currentState = null;

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'state' || msg.type === 'turn') {
      currentState = msg;
      // Update dashboard dengan state terbaru
      updateDashboardFromView(msg);
    }

    if (msg.yourTurn === true || (msg.type === 'turn' && msg.playerId)) {
      if (!currentState) {
        ws.send(JSON.stringify({ type: 'action', action: 'defend' }));
        return;
      }
      const actions = decideActions(currentState, true);
      for (const action of actions) {
        ws.send(JSON.stringify(action));
      }
    } else if (msg.type === 'game_ended') {
      const rewards = msg.rewards || {};
      gameStats.totalWins += msg.isWinner ? 1 : 0;
      gameStats.totalSmoltz += rewards.sMoltz || 0;
      gameStats.totalMoltz += rewards.Moltz || 0;
      dashboardState.updateAgent(currentAgentId, gameStats);
      dashboardState.addLog(currentAgentId, `Game ended. Winner: ${msg.winnerId}`);
      ws.close();
      delayAndRetry(5000);
    }
  });

  ws.on('close', (code) => { console.log(`Game WS closed (${code})`); delayAndRetry(5000); });
}

function playGameViaAgentSocket(gameId) {
  const ws = new WebSocket(WS_AGENT, { headers: HEADERS });
  ws.on('open', () => playGameLoop(ws, gameId));
  ws.on('error', (e) => console.error('Agent WS error:', e.message));
}

// Jalankan
init().then(() => {
  // Mulai dashboard server (port dari env atau 3000)
  const port = process.env.PORT || 3000;
  startDashboard(port);
  dashboardState.addLog('system', 'Bot started');
  main();
});