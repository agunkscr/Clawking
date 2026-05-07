const ws = new WebSocket(`ws://${location.host}/ws`);

function updateStats(data) {
  document.getElementById('totalWins').textContent = data.global.totalWins || 0;
  document.getElementById('totalSmoltz').textContent = data.global.totalSmoltz || 0;
  document.getElementById('totalMoltz').textContent = data.global.totalMoltz || 0;
  document.getElementById('botsRunning').textContent = data.global.botsRunning || 0;
}

function renderAgents(agents) {
  const container = document.getElementById('agentContainer');
  container.innerHTML = '';
  for (const [id, agent] of Object.entries(agents)) {
    const row = document.createElement('div');
    row.className = 'agent-row';
    row.innerHTML = `
      <span class="agent-name">${agent.name || id}</span>
      <span>HP: <span class="agent-hp">${agent.hp ?? '?'}</span></span>
      <span>EP: ${agent.ep ?? '?'}</span>
      <span class="agent-status">${agent.status || 'idle'}</span>
      <span class="agent-rewards">sMoltz: ${agent.rewards?.sMoltz || 0}</span>
    `;
    container.appendChild(row);
  }
}

function renderLogs(logs) {
  const container = document.getElementById('logContainer');
  container.innerHTML = logs.slice(-10).map(l => {
    const time = new Date(l.time).toLocaleTimeString();
    return `<div class="log-entry">[${time}] ${l.message}</div>`;
  }).join('');
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'snapshot') {
    const data = msg.data;
    updateStats(data);
    renderAgents(data.agents);
    renderLogs(data.logs);
  }
};