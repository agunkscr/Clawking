import 'dotenv/config';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import { decideActions } from './strategy-clawking.js';
import dashboardState from './state-bridge.js';
import { startDashboard } from './dashboard-server.js';

const BASE = 'https://api.clawking.cc/api';
const WS_JOIN = 'wss://api.clawking.cc/ws/join';
const WS_AGENT = 'wss://api.clawking.cc/ws/agent';

let VERSION = '1.6.0';   // fallback
let HEADERS = {};
let currentAgentId = 'primary';
let gameStats = { totalWins: 0, totalBnb: 0 };  // BNB sebagai hadiah

// ── Fungsi bantu ────────────────────────────────────────────────
function updateDashboardFromView(view) {
  const self = view.self || {};
  const hp = self.hp ?? 100;
  const ep = self.ep ?? 10;
  const status = self.isAlive ? 'alive' : 'dead';
  const rewards = {
    BNB: self.rewards?.BNB || 0,
  };
  dashboardState.updateAgent(currentAgentId, {
    name: 'ClawKingBot',
    hp, ep, status, rewards,
    inventory: self.inventory || [],
  });
}

// ── Wallet ─────────────────────────────────────────────────────
let signer = null;
let walletAddress = null;
try {
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (pk && ethers.isHexString(pk, 32)) {
    signer = new ethers.Wallet(pk);
    walletAddress = signer.address;
    console.log(`Wallet EOA: ${walletAddress}`);
  } else {
    console.warn('No valid WALLET_PRIVATE_KEY. Paid lobby disabled.');
  }
} catch (e) {
  console.warn('Signer error:', e.message);
}

// ── Main loop dengan State Router ─────────────────────────────
async function main() {
  console.log('=== ClawKing Bot ===');
  try {
    const meRes = await fetch(`${BASE}/accounts/me`, { headers: HEADERS });
    if (!meRes.ok) {
      if (meRes.status === 401) {
        console.error('Invalid API Key');
        process.exit(1);
      }
      console.error(`/accounts/me error ${meRes.status}`);
      return delayAndRetry(60000);
    }
    const me = (await meRes.json()).data;
    console.log(`Identity: ${me.readiness.erc8004Id ? 'OK' : 'MISSING'}`);
    console.log(`Paid Ready: ${me.readiness.paidReady}`);
    console.log(`Balance: ${me.balance ?? '?'} (BNB)`);

    if (!me.readiness.erc8004Id) {
      console.error('No ERC-8004 identity. Exiting.');
      process.exit(0);
    }

    // Update stats (ClawKing mungkin tidak punya stats global, tapi kita siapkan)
    if (me.stats) {
      gameStats.totalWins = me.stats.totalWins || 0;
      gameStats.totalBnb = me.stats.bnb || 0;
      dashboardState.updateAgent(currentAgentId, gameStats);
    }

    // State Router
    if (me.currentGames && me.currentGames.length > 0) {
      const game = me.currentGames[0];
      console.log(`Melanjutkan game: ${game.gameId}`);
      return playGameViaAgentSocket(game.gameId);
    }

    if (me.readiness.paidReady) {
      if (!signer) {
        console.error('PAID lobby ready but no private key. Exiting.');
        process.exit(0);
      }
      // Biaya masuk ClawKing: 0.001 BNB (asumsikan dari dokumentasi)
      const feeBnb = 0.001;
      const balanceBnb = me.balance || 0;
      if (balanceBnb >= feeBnb) {
        console.log(`Balance ${balanceBnb} BNB >= ${feeBnb} BNB. Joining PAID lobby.`);
        return joinPaid('offchain');  // atau 'onchain'? ClawKing mungkin hanya onchain.
      } else {
        console.warn(`Insufficient BNB (${balanceBnb}/${feeBnb}). Cannot enter paid lobby.`);
        console.log('Falling back to free lobby.');
        return joinFree();
      }
    }

    console.log('Mencoba join free lobby...');
    return joinFree();
  } catch (error) {
    console.error('Main loop error:', error);
    delayAndRetry(30000);
  }
}

function delayAndRetry(ms) {
  setTimeout(main, ms);
}

// ── Free lobby join ────────────────────────────────────────────
function joinFree() {
  const ws = new WebSocket(WS_JOIN, { headers: HEADERS });
  ws.on('open', () => console.log('/ws/join (free) opened'));

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Free join msg:', msg.type);
    if (msg.type === 'welcome') {
      const decision = msg.decision;
      console.log(`Decision: ${decision}`);
      if (decision === 'FREE_ONLY' || decision === 'ASK_ENTRY_TYPE') {
        ws.send(JSON.stringify({ type: 'hello', entryType: 'free' }));
      } else if (decision === 'PAID_ONLY') {
        console.error('Server requires PAID lobby. Exiting.');
        ws.close();
        process.exit(0);
      } else if (decision === 'BLOCKED') {
        console.error('Blocked:', msg.readiness);
        ws.close();
        process.exit(0);
      }
    } else if (msg.type === 'game_started') {
      dashboardState.addLog(currentAgentId, `Game started: ${msg.gameId}`);
      playGameLoop(ws, msg.gameId);
    } else if (msg.type === 'error') {
      console.error('Join error:', msg.error);
    }
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason?.toString() || '';
    console.log(`Join closed (${code}) ${reasonStr}`);
    if (code === 4503 || reasonStr.includes('MAINTENANCE')) {
      console.warn('Server maintenance, retrying in 5 minutes.');
      dashboardState.addLog('system', 'Server maintenance, retrying in 5 min');
      setTimeout(main, 300000);
    } else {
      delayAndRetry(5000);
    }
  });

  ws.on('error', (e) => console.error('WS join error:', e.message));
}

// ── Paid lobby join ────────────────────────────────────────────
function joinPaid(mode = 'offchain') {
  const ws = new WebSocket(WS_JOIN, { headers: HEADERS });
  ws.on('open', () => console.log(`/ws/join (paid, ${mode}) opened`));

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Paid join msg:', msg.type);
    if (msg.type === 'welcome') {
      const decision = msg.decision;
      console.log(`Decision: ${decision}`);
      if (decision === 'PAID_ONLY' || decision === 'ASK_ENTRY_TYPE') {
        ws.send(JSON.stringify({ type: 'hello', entryType: 'paid', mode }));
      } else if (decision === 'FREE_ONLY') {
        console.warn('Server only accepts free. Falling back.');
        ws.close();
        delayAndRetry(5000);
      } else if (decision === 'BLOCKED') {
        console.error('Blocked from paid:', msg.readiness);
        process.exit(0);
      }
    } else if (msg.type === 'signature_required') {
      console.log('Server requests signature...');
      try {
        const payload = msg.data?.signaturePayload;
        if (!payload) throw new Error('No payload');
        const signature = await signer.signMessage(payload);
        ws.send(JSON.stringify({ type: 'signature', data: { signature } }));
        console.log('Signature sent');
      } catch (e) {
        console.error('Signature failed:', e.message);
        ws.close();
      }
    } else if (msg.type === 'game_started') {
      dashboardState.addLog(currentAgentId, `Paid game started: ${msg.gameId}`);
      playGameLoop(ws, msg.gameId);
    } else if (msg.type === 'error') {
      console.error('Paid join error:', msg.error);
      ws.close();
    }
  });

  ws.on('close', (code) => {
    console.log(`Paid join closed (${code})`);
    delayAndRetry(5000);
  });
  ws.on('error', (e) => console.error('WS paid error:', e.message));
}

// ── Gameplay loop ──────────────────────────────────────────────
function playGameLoop(ws, gameId) {
  console.log(`Playing game ${gameId}`);
  let currentState = null;

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'state' || msg.type === 'turn') {
      currentState = msg;
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
      gameStats.totalBnb += rewards.BNB || 0;
      dashboardState.updateAgent(currentAgentId, gameStats);
      dashboardState.addLog(currentAgentId, `Game ended. Winner: ${msg.winnerId}`);
      ws.close();
      delayAndRetry(5000);
    }
  });

  ws.on('close', (code) => {
    console.log(`Game WS closed (${code})`);
    delayAndRetry(5000);
  });
}

function playGameViaAgentSocket(gameId) {
  const ws = new WebSocket(WS_AGENT, { headers: HEADERS });
  ws.on('open', () => playGameLoop(ws, gameId));
  ws.on('error', (e) => console.error('Agent WS error:', e.message));
}

// ── Inisialisasi & autentikasi awal ────────────────────────────
async function init() {
  const rawKey = process.env.API_KEY || '';

  // Ambil versi server (ClawKing mungkin pakai X-Version juga)
  try {
    const vRes = await fetch(`${BASE}/version`, {
      headers: { 'X-Version': '1.6.0' }
    });
    if (vRes.ok) {
      const vData = await vRes.json();
      if (vData.success && vData.data?.version) {
        VERSION = vData.data.version;
        console.log(`Server version: ${VERSION}`);
      } else {
        console.warn('Could not parse version, using 1.6.0');
      }
    } else if (vRes.status === 426) {
      console.error('VERSION_MISMATCH');
      process.exit(1);
    }
  } catch (e) {
    console.warn('Version fetch failed, using 1.6.0');
  }

  // Autentikasi: ClawKing menggunakan ck-auth
  const methods = [
    {
      name: 'ck-auth',
      headers: () => ({
        'X-Version': VERSION,
        'Content-Type': 'application/json',
        'Authorization': `ck-auth ${rawKey}`
      })
    },
    {
      name: 'x-api-key',
      headers: () => ({
        'X-Version': VERSION,
        'Content-Type': 'application/json',
        'X-API-Key': rawKey
      })
    }
  ];

  for (const method of methods) {
    try {
      const hdrs = method.headers();
      const res = await fetch(`${BASE}/accounts/me`, { headers: hdrs });
      const body = await res.json().catch(() => ({}));
      console.log(`Auth ${method.name} → ${res.status} ${JSON.stringify(body).slice(0,100)}`);
      if (res.ok && body.success) {
        HEADERS = hdrs;
        console.log(`✅ Authenticated via ${method.name}`);
        return;
      }
    } catch (err) {
      console.warn(`Auth ${method.name} error: ${err.message}`);
    }
  }

  console.error('❌ All auth methods failed.');
  process.exit(1);
}

// ── Mulai ──────────────────────────────────────────────────────
init().then(() => {
  const port = process.env.PORT || 3000;
  startDashboard(port);
  dashboardState.addLog('system', 'Bot started');
  main();
});