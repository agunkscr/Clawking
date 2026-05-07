import { ethers } from 'ethers';
import fetch from 'node-fetch';
import WebSocket from 'ws';

/**
 * ClawKingClient – menghandle koneksi wallet, join lobby, dan gameplay.
 */
export class ClawKingClient {
  constructor({ privateKey, entryType = 'free', onGameLoop, onDashboardUpdate }) {
    this.privateKey = privateKey;
    this.entryType = entryType;
    this.onGameLoop = onGameLoop;
    this.onDashboardUpdate = onDashboardUpdate;
    this.signer = new ethers.Wallet(privateKey);
    this.address = this.signer.address;
    this.ws = null;
    this.session = null;
  }

  async start() {
    console.log(`🦞 ClawKing Bot started. Wallet: ${this.address}`);
    console.log(`Entry type: ${this.entryType}`);

    // Fetch SKILL.md untuk mendapatkan endpoint terbaru (opsional)
    try {
      const skillRes = await fetch('https://clawking.cc/skill/SKILL.md');
      if (skillRes.ok) {
        const text = await skillRes.text();
        // Cari URL WebSocket di dalam SKILL.md (asumsi format: `wss://api.clawking.cc/ws`)
        const wsMatch = text.match(/wss?:\/\/[^\s"'\)]+/);
        if (wsMatch) this.wsUrl = wsMatch[0].replace(/\/$/, '');
      }
    } catch (e) {
      console.warn('Could not fetch SKILL.md, using default WS URL');
    }

    if (!this.wsUrl) this.wsUrl = 'wss://api.clawking.cc/ws';

    // Mulai join
    await this.join();
  }

  async join() {
    // WebSocket ke endpoint join
    this.ws = new WebSocket(`${this.wsUrl}/join`);

    this.ws.on('open', () => {
      console.log('🦞 WebSocket /ws/join opened');
      // Kirim hello dengan wallet signature
      this.sendHello();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log('📩 MSG:', msg.type);
        this.handleMessage(msg);
      } catch (e) {
        console.error('Failed to parse message', e);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`🔌 WS closed (${code}) ${reason?.toString() || ''}`);
      if (this.onGameLoop && this.session) {
        // Sudah dalam game, mungkin koneksi putus, biarkan main loop handle
      } else {
        // Retry setelah 5 detik
        setTimeout(() => this.join(), 5000);
      }
    });

    this.ws.on('error', (e) => console.error('WS error:', e.message));
  }

  async sendHello() {
    // Tanda tangani pesan untuk autentikasi (contoh: "login:ClawKing:timestamp")
    const timestamp = Date.now();
    const message = `login:ClawKing:${timestamp}`;
    const signature = await this.signer.signMessage(message);

    this.ws.send(JSON.stringify({
      type: 'hello',
      entryType: this.entryType,
      mode: 'offchain', // asumsikan offchain dulu (free)
      wallet: this.address,
      signature,
      timestamp,
      message
    }));
    console.log('👋 Hello sent with signature');
  }

  handleMessage(msg) {
    if (msg.type === 'welcome') {
      console.log(`Decision: ${msg.decision}`);
      if (msg.decision === 'BLOCKED') {
        console.error('Access blocked:', msg.readiness);
        process.exit(1);
      } else if (msg.decision === 'PAID_ONLY' && this.entryType === 'free') {
        console.error('Paid lobby required but we are free. Exiting.');
        process.exit(0);
      } else if (msg.decision === 'FREE_ONLY' && this.entryType === 'paid') {
        console.warn('Server only accepts free, falling back.');
        this.entryType = 'free';
        this.sendHello(); // kirim ulang hello dengan entryType gratis?
        // Seharusnya server sudah tahu, tapi kita bisa kirim lagi
      }
      // Jika ASK_ENTRY_TYPE atau sesuai, kita tidak perlu kirim apa-apa lagi
    } else if (msg.type === 'signature_required') {
      // Tanda tangan tambahan untuk EIP-712
      this.handleSignatureRequest(msg);
    } else if (msg.type === 'game_started') {
      console.log(`🎮 Game started: ${msg.gameId}`);
      this.session = { gameId: msg.gameId, ws: this.ws };
      // Serahkan kontrol ke game loop
      if (this.onGameLoop) {
        this.onGameLoop(this.ws, msg.gameId, this);
      }
    } else if (msg.type === 'error') {
      console.error('Error from server:', msg.error);
    }
  }

  async handleSignatureRequest(msg) {
    try {
      const payload = msg.data?.signaturePayload;
      if (!payload) throw new Error('No payload');
      const signature = await this.signer.signMessage(payload);
      this.ws.send(JSON.stringify({
        type: 'signature',
        data: { signature }
      }));
      console.log('✍️ Signature sent');
    } catch (e) {
      console.error('Signature failed:', e.message);
    }
  }
}