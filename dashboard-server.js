import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dashboardState from './state-bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startDashboard(port = 3000) {
  const app = express();
  // Sajikan folder dashboard sebagai statis
  app.use(express.static(path.join(__dirname, 'dashboard')));

  // REST endpoint untuk snapshot (opsional)
  app.get('/api/state', (req, res) => {
    res.json(dashboardState.getSnapshot());
  });

  const server = http.createServer(app);

  // WebSocket server
  const wss = new WebSocketServer({ server });
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    // Kirim snapshot awal
    ws.send(JSON.stringify({ type: 'snapshot', data: dashboardState.getSnapshot() }));

    ws.on('close', () => clients.delete(ws));
  });

  // Push loop: kirim snapshot ke semua klien setiap 1.5 detik
  const pushInterval = setInterval(() => {
    const snapshot = JSON.stringify({ type: 'snapshot', data: dashboardState.getSnapshot() });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(snapshot);
      }
    }
  }, 1500);

  // Bersihkan interval saat server berhenti (tidak perlu di bot long-running)

  server.listen(port, () => {
    console.log(`📊 Dashboard berjalan di http://localhost:${port}`);
  });

  return { server, wss, pushInterval };
}