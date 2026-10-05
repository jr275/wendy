/**
 * WENDY CLIENT APPLICATION & AG-UI INTERFACE PROTOCOL
 */

let appState = null;
let eventSource = null;

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  await fetchState();
  initSseStream();
}

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    appState = await res.json();
    renderDossier();
    renderMemoryView();
    renderAuditLedger();
  } catch (err) {
    console.error('Failed to load state from server:', err);
  }
}

function initSseStream() {
  eventSource = new EventSource('/api/stream');
  
  eventSource.addEventListener('AGUI_TOOL_PROGRESS', (e) => {
    const data = JSON.parse(e.data);
    appendToolProgressCard(data);
  });

  eventSource.addEventListener('AGUI_STREAM_TOKEN', (e) => {
    const data = JSON.parse(e.data);
    appendStreamToken(data.token);
  });

  eventSource.addEventListener('ACTION_VERIFIED_BROADCAST', (e) => {
    const data = JSON.parse(e.data);
    onActionVerifiedBroadcast(data);
  });
}

function renderDossier() {
  if (!appState || !appState.dossier) return;
  const d = appState.dossier;
  document.getElementById('dossier-timestamp').innerText = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} Sync`;
}

function switchView(viewName) {
  document.getElementById('view-workspace').classList.toggle('hidden', viewName !== 'workspace');
  document.getElementById('view-memory').classList.toggle('hidden', viewName !== 'memory');
  document.getElementById('view-audit').classList.toggle('hidden', viewName !== 'audit');

  ['workspace', 'memory', 'audit'].forEach(v => {
    const btn = document.getElementById(`btn-view-${v}`);
    if (v === viewName) {
      btn.className = 'px-3 py-1.5 rounded text-xs font-mono-code font-medium bg-[#22252a] text-white border border-[#32363d] transition-colors';
    } else {
      btn.className = 'px-3 py-1.5 rounded text-xs font-mono-code font-medium text-[#8e969f] hover:text-white transition-colors';
    }
  });

  if (viewName === 'audit') fetchAuditData();
  if (viewName === 'memory') fetchState();
}

// --- Chat & Agentic Streaming ---
async function handleUserMessage(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  // Append user message
  appendChatMessage('João', message, false);
  input.value = '';

  // Show live Wendy progress
  const progressId = appendToolProgressCard({
    userFacingMessage: 'Consulting relationship trajectory and executive commitments...'
  });

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: message })
    });
    const data = await res.json();
    
    // Remove temporary tool progress card
    const pEl = document.getElementById(progressId);
    if (pEl) pEl.remove();

    appendChatMessage('Wendy', data.reply, true, data.epistemicBreakdown);
  } catch (err) {
    console.error('Chat error:', err);
  }
}

function appendChatMessage(sender, text, isWendy, epistemicList = []) {
  const container = document.getElementById('chat-stream');
  const msgWrapper = document.createElement('div');
  msgWrapper.className = 'space-y-2';

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let epistemicHtml = '';
  if (epistemicList && epistemicList.length > 0) {
    epistemicHtml = `
      <div class="mt-3 pt-2 border-t border-[#22252a] space-y-1 text-[11px] font-mono-code">
        ${epistemicList.map(item => `
          <div class="flex items-start gap-2">
            <span class="${item.type === 'FACT' ? 'badge-fact' : 'badge-recommendation'}">${item.type}</span>
            <span class="text-[#a3acb5]">${item.text}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  msgWrapper.innerHTML = `
    <div class="flex items-center justify-between text-xs text-[#727a83]">
      <span class="font-serif-editorial font-medium ${isWendy ? 'text-white' : 'text-stone-300'} text-sm">${sender}</span>
      <span class="font-mono-code text-[10px]">${timeStr}</span>
    </div>
    <div class="p-4 rounded-xl border ${isWendy ? 'border-[#22252a] bg-[#141619]' : 'border-[#2a2e36] bg-[#1a1d22]'} text-[#ededed] font-serif-editorial text-[14px] leading-relaxed">
      <div class="whitespace-pre-wrap">${formatMarkdown(text)}</div>
      ${epistemicHtml}
    </div>
  `;

  container.appendChild(msgWrapper);
  container.scrollTop = container.scrollHeight;
}

function appendToolProgressCard(data) {
  const container = document.getElementById('chat-stream');
  const card = document.createElement('div');
  const id = `tool-prog-${Date.now()}`;
  card.id = id;
  card.className = 'p-3 rounded-lg border border-[#22252a] bg-[#141618] text-xs font-mono-code text-indigo-400 flex items-center gap-2 animate-pulse';
  card.innerHTML = `
    <span class="animate-spin">●</span>
    <span>${data.userFacingMessage}</span>
  `;
  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
  return id;
}

function formatMarkdown(text) {
  // Simple markdown bold formatting for web preview
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
}

// --- Action Authorization & Verification ---
async function syncDraftState(actionId, newBody) {
  try {
    await fetch('/api/action/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId, modifiedBody: newBody })
    });
  } catch (err) {
    console.warn('Sync failed:', err);
  }
}

async function authorizeAction(actionId) {
  const btn = document.getElementById('btn-auth-mariana');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="animate-spin">●</span><span>Dispatching & Verifying...</span>`;

  const modifiedBody = document.getElementById('draft-mariana-body').value;

  try {
    const res = await fetch('/api/action/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId, modifiedBody })
    });
    const result = await res.json();

    if (result.success) {
      btn.classList.add('hidden');
      const banner = document.getElementById('verified-banner-mariana');
      banner.classList.remove('hidden');
      document.getElementById('verified-receipt-text').innerText = 
        `Message queued • SMTP: ${result.verification.smtpResponse} • Hash: ${result.auditEntry.entryHash.slice(0, 16)}...`;

      document.getElementById('staging-counter').innerText = '0 Actions Awaiting Approval';
      document.getElementById('staging-counter').className = 'px-2 py-0.5 rounded text-[11px] font-mono-code bg-stone-800 text-stone-400 border border-stone-700';

      // Append confirmation to chat
      appendChatMessage('Wendy', `Action authorized: Mariana's birthday greeting has been signed, queued for tomorrow 08:30 (BST), and verified against the downstream mail server. Recorded to your episodic memory and cryptographic audit ledger.`, true, [
        { type: 'FACT', text: `Verified dispatch via SMTP gateway. MessageId: ${result.verification.messageId}` }
      ]);
    }
  } catch (err) {
    console.error('Authorization error:', err);
    btn.disabled = false;
    btn.innerHTML = originalText;
    alert('Authorization failed: ' + err.message);
  }
}

async function rejectAction(actionId) {
  if (!confirm('Are you sure you want to dismiss this prepared action? Wendy will record your preference.')) return;
  const card = document.getElementById('card-mariana-birthday');
  if (card) card.remove();
  document.getElementById('staging-counter').innerText = '0 Actions Awaiting Approval';
}

function onActionVerifiedBroadcast(data) {
  console.log('Action verified via SSE:', data);
}

// --- Provenance & Modal Viewers ---
const provenanceDatabase = {
  urgent: {
    title: 'Evidence Chain: Carlos Drummond Meeting (14:00)',
    entity: 'Carlos Drummond (General Partner, Horizon Capital • Tier 1)',
    evidence: [
      'Calendar Event: Today at 14:00 "Strategic Partnership & Pricing Review" (Source: Google Calendar UID #83921)',
      'Email Received: Yesterday 23:42 from carlos@horizoncap.com: "João, I have concerns on Clause 4 pricing before our Thursday committee..."',
      'Historical Commitment: Dinner note 14 days ago stating João would revisit pricing structure',
      'Closeness Score: 0.92 (High Trust, 2 shared portfolio boards)'
    ],
    hash: '8f4c2e61a90d8173429bc01837e41982b67d5e182390a427181c098234ea7193'
  },
  relationship: {
    title: 'Evidence Chain: Mariana Vance Birthday',
    entity: 'Mariana Vance (Managing Director, Apex Bio • Tier 1)',
    evidence: [
      'Contact Profile: Birthday verified for tomorrow in structured contact ledger',
      'Episodic Memory: Sent personal message on birthday last year referencing European market expansion',
      'Outcome Log: Mariana replied within 2 hours with high personal warmth',
      'Tone Constraint: Rule #1 applied (Direct, authentic, zero corporate boilerplate)'
    ],
    hash: 'b194f2c790a827183e910294871928374a019283740192837401928374019283'
  },
  commitment: {
    title: 'Evidence Chain: Financial Numbers Commitment',
    entity: 'Commitment to Carlos Drummond',
    evidence: [
      'Episodic Memory: Tuesday email agreement: "Will send revised pricing sensitivities by end of week"',
      'Drive Telemetry: Pricing_Sensitivity_Matrix_Q4.xlsx created yesterday at 18:20',
      'Status: Unsent. Deadline elapsed threshold approaching (Due today 17:00)'
    ],
    hash: 'd827103984719283740192837401928374019283740192837401928374019283'
  }
};

function inspectProvenance(type) {
  const data = provenanceDatabase[type];
  if (!data) return;

  document.getElementById('modal-prov-title').innerText = data.title;
  document.getElementById('modal-prov-entity').innerText = data.entity;
  
  const ul = document.getElementById('modal-prov-evidence');
  ul.innerHTML = data.evidence.map(e => `<li>• ${e}</li>`).join('');

  document.getElementById('modal-prov-hash').innerText = data.hash;
  document.getElementById('modal-provenance').classList.remove('hidden');
}

function closeProvenanceModal() {
  document.getElementById('modal-provenance').classList.add('hidden');
}

// --- Memory & Audit Views ---
function renderMemoryView() {
  if (!appState) return;
  const container = document.getElementById('memory-cards-container');
  if (!container) return;

  const people = Object.values(appState.memory.people || {});
  const rels = Object.values(appState.memory.relationships || {});

  container.innerHTML = `
    <div class="p-5 rounded-xl border border-[#22252a] bg-[#141619] space-y-3">
      <h3 class="text-sm font-semibold text-white font-mono-code uppercase">Entity Nodes (${people.length})</h3>
      <div class="space-y-2 text-xs">
        ${people.map(p => `
          <div class="p-3 rounded bg-[#0d0e10] border border-[#22252a]">
            <div class="flex items-center justify-between text-white font-medium">
              <span>${p.fullName}</span>
              <span class="badge-fact">Tier ${p.tier}</span>
            </div>
            <div class="text-[#727a83] text-[11px] font-mono-code mt-0.5">${p.title || 'Executive'}</div>
            <div class="text-[#a3acb5] text-[11px] mt-1">${p.notesSummary || ''}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="p-5 rounded-xl border border-[#22252a] bg-[#141619] space-y-3">
      <h3 class="text-sm font-semibold text-white font-mono-code uppercase">Relationship Edges (${rels.length})</h3>
      <div class="space-y-2 text-xs">
        ${rels.map(r => `
          <div class="p-3 rounded bg-[#0d0e10] border border-[#22252a] space-y-1 font-mono-code text-[11px]">
            <div class="flex items-center justify-between text-white">
              <span>${r.relationshipType}</span>
              <span class="text-emerald-400">Closeness: ${r.closenessScore}</span>
            </div>
            <div class="text-[#8e969f]">Velocity: ${r.velocity} • Cadence: ${r.interactionCadenceDays}d</div>
            <div class="text-[#727a83] text-[10px]">Notes: ${r.historicalNotes ? r.historicalNotes[0] : 'None'}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="p-5 rounded-xl border border-[#22252a] bg-[#141619] space-y-3">
      <h3 class="text-sm font-semibold text-white font-mono-code uppercase">Executive Preferences (3)</h3>
      <div class="space-y-2 text-xs">
        ${(appState.memory.preferences || []).map(p => `
          <div class="p-3 rounded bg-[#0d0e10] border border-[#22252a] space-y-1">
            <div class="flex items-center justify-between text-[11px] font-mono-code">
              <span class="text-purple-400">${p.domain}</span>
              <span class="text-[#727a83]">${p.strength}</span>
            </div>
            <p class="text-xs text-[#ededed] font-serif-editorial">${p.rule}</p>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

async function fetchAuditData() {
  try {
    const res = await fetch('/api/audit');
    const entries = await res.json();
    const tbody = document.getElementById('audit-table-body');
    if (!tbody) return;

    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-[#727a83]">No external actions executed yet. Authorize Mariana's greeting in Zone C to generate the first cryptographic block.</td></tr>`;
      return;
    }

    tbody.innerHTML = entries.map(e => `
      <tr class="hover:bg-[#181a1d] transition-colors">
        <td class="p-3 text-[#727a83] font-bold">#${e.sequenceNumber}</td>
        <td class="p-3 text-[#a3acb5]">${new Date(e.timestamp).toLocaleTimeString()}</td>
        <td class="p-3 text-white font-semibold">${e.eventType}</td>
        <td class="p-3"><span class="badge-level3">Level ${e.authorizationLevel}</span></td>
        <td class="p-3 text-[#a3acb5]">${e.actorId}</td>
        <td class="p-3"><span class="badge-fact">${e.verificationStatus}</span></td>
        <td class="p-3 text-emerald-400 font-mono-code">${e.entryHash.slice(0, 20)}...</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Audit fetch error:', err);
  }
}

// --- Signal Simulator ---
function openEventSimulator() {
  document.getElementById('modal-simulator').classList.remove('hidden');
}

function closeEventSimulator() {
  document.getElementById('modal-simulator').classList.add('hidden');
}

async function injectSimulatedEvent() {
  const scenario = document.getElementById('sim-scenario').value;
  closeEventSimulator();

  appendToolProgressCard({
    userFacingMessage: `Ingesting external signal: ${scenario}...`
  });

  try {
    const res = await fetch('/api/events/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario })
    });
    const result = await res.json();

    setTimeout(() => {
      appendChatMessage('Wendy', result.summary, true, [
        { type: 'FACT', text: `Inbound signal processed via Reactive Event Bus. Salience: ${result.salience}` }
      ]);
    }, 1000);
  } catch (err) {
    console.error('Simulation error:', err);
  }
}
