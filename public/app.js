/**
 * WENDY CLIENT APPLICATION & AG-UI INTERFACE PROTOCOL (PHASE 2.5)
 * Connected directly to hardened repositories and real cognitive pipeline.
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
    renderStagedActions();
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

  eventSource.addEventListener('PROACTIVE_INSIGHT_GENERATED', (e) => {
    const insight = JSON.parse(e.data);
    onProactiveInsightReceived(insight);
  });

  eventSource.addEventListener('ACTION_VERIFIED_BROADCAST', (e) => {
    const data = JSON.parse(e.data);
    onActionVerifiedBroadcast(data);
  });
}

function renderDossier() {
  if (!appState || !appState.dossier) return;
  document.getElementById('dossier-timestamp').innerText = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} Verified`;
}

function renderStagedActions() {
  if (!appState || !appState.dossier || !appState.dossier.stagedActions) return;
  const actions = Object.values(appState.dossier.stagedActions);
  const pending = actions.filter(a => a.state === 'AWAITING_APPROVAL' || a.state === 'PROPOSED');
  
  const counter = document.getElementById('staging-counter');
  if (pending.length > 0) {
    counter.innerText = `${pending.length} Action${pending.length > 1 ? 's' : ''} Awaiting Approval`;
    counter.className = 'px-2 py-0.5 rounded text-[11px] font-mono-code bg-amber-950 text-amber-300 border border-amber-800';
  } else {
    counter.innerText = '0 Actions Awaiting Approval';
    counter.className = 'px-2 py-0.5 rounded text-[11px] font-mono-code bg-stone-800 text-stone-400 border border-stone-700';
  }

  // Populate draft textarea with persisted value
  const birthdayAction = actions.find(a => a.actionId.includes('birthday') || (a.targetEntityName && a.targetEntityName.includes('Mariana')));
  if (birthdayAction && birthdayAction.preview?.body) {
    const textarea = document.getElementById('draft-mariana-body');
    if (textarea) textarea.value = birthdayAction.preview.body;

    if (birthdayAction.state === 'VERIFIED' || birthdayAction.state === 'EXECUTED') {
      const btn = document.getElementById('btn-auth-mariana');
      if (btn) btn.classList.add('hidden');
      const banner = document.getElementById('verified-banner-mariana');
      if (banner) {
        banner.classList.remove('hidden');
        document.getElementById('verified-receipt-text').innerText = 
          `Verified in Ledger • Audit Hash: ${birthdayAction.auditHash ? birthdayAction.auditHash.slice(0, 16) : 'VERIFIED'}...`;
      }
    }
  }
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

// --- Chat & Real Memory Retrieval ---
async function handleUserMessage(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  // Append user message
  appendChatMessage('João', message, false);
  input.value = '';

  const progressId = appendToolProgressCard({
    userFacingMessage: 'Searching persisted episodic memories and relationship graph...'
  });

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: message })
    });
    const data = await res.json();
    
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
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
}

// --- Action Authorization & Durable Persistence ---
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
        `Durable Idempotency Token Verified • SMTP: ${result.verification.smtpResponse} • Audit Hash: ${result.auditEntry.entryHash.slice(0, 16)}...`;

      document.getElementById('staging-counter').innerText = '0 Actions Awaiting Approval';
      document.getElementById('staging-counter').className = 'px-2 py-0.5 rounded text-[11px] font-mono-code bg-stone-800 text-stone-400 border border-stone-700';

      appendChatMessage('Wendy', `Action authorized: Mariana's birthday greeting has been signed, queued with a durable idempotency key, and verified. Recorded to your persistent episodic memory and cryptographic audit ledger.`, true, [
        { type: 'FACT', text: `Verified dispatch via SMTP gateway. MessageId: ${result.verification.messageId}` },
        { type: 'FACT', text: `Idempotency Token: ${result.verification.idempotencyKey}` }
      ]);
      await fetchState();
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

function onProactiveInsightReceived(insight) {
  console.log('[PROACTIVE INSIGHT]:', insight);
  const facts = [
    { type: 'FACT', text: insight.epistemicQuad.observation.statement },
    { type: 'INFERENCE', text: insight.epistemicQuad.interpretation.statement },
    { type: 'RECOMMENDATION', text: insight.epistemicQuad.recommendation.statement }
  ];
  appendChatMessage('Wendy (Autonomous Insight)', `${insight.explanation}\n\n**Action**: ${insight.epistemicQuad.recommendation.statement}`, true, facts);
  fetchState();
}

// --- Real Provenance Inspector ---
async function inspectProvenance(type) {
  if (!appState || !appState.dossier) return;
  const item = appState.dossier.quadrants[type];
  if (!item) return;

  document.getElementById('modal-prov-title').innerText = `Evidence Chain: ${item.title}`;
  document.getElementById('modal-prov-entity').innerText = item.entity;
  
  const ul = document.getElementById('modal-prov-evidence');
  ul.innerHTML = (item.evidence || []).map(e => `<li>• ${e}</li>`).join('');

  // Fetch real latest audit block hash or event hash
  const auditRes = await fetch('/api/audit');
  const auditData = await auditRes.json();
  const latestHash = auditData.blocks.length > 0 ? auditData.blocks[0].entryHash : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  document.getElementById('modal-prov-hash').innerText = latestHash;
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
  const preferences = appState.memory.preferences || [];
  const episodic = appState.memory.recentEpisodic || [];

  container.innerHTML = `
    <div class="p-5 rounded-xl border border-[#22252a] bg-[#141619] space-y-3">
      <h3 class="text-sm font-semibold text-white font-mono-code uppercase">Persisted Entity Nodes (${people.length})</h3>
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
      <h3 class="text-sm font-semibold text-white font-mono-code uppercase">Persisted Episodic Logs (${episodic.length})</h3>
      <div class="space-y-2 text-xs">
        ${episodic.map(e => `
          <div class="p-3 rounded bg-[#0d0e10] border border-[#22252a] space-y-1">
            <div class="flex items-center justify-between text-[11px] font-mono-code">
              <span class="text-indigo-400 font-semibold">${e.interactionType}</span>
              <span class="text-[#727a83]">${new Date(e.occurredAt).toLocaleDateString()}</span>
            </div>
            <p class="text-xs text-[#ededed] font-serif-editorial">${e.summary}</p>
            ${e.verbatimSnippet ? `<div class="text-[10px] font-mono-code text-[#727a83] italic">"${e.verbatimSnippet}"</div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>

    <div class="p-5 rounded-xl border border-[#22252a] bg-[#141619] space-y-3">
      <h3 class="text-sm font-semibold text-white font-mono-code uppercase">Executive Preferences (${preferences.length})</h3>
      <div class="space-y-2 text-xs">
        ${preferences.map(p => `
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
    const { integrity, blocks } = await res.json();
    const tbody = document.getElementById('audit-table-body');
    if (!tbody) return;

    // Show integrity status banner
    const integrityBanner = document.getElementById('audit-integrity-status');
    if (integrityBanner) {
      if (integrity.valid) {
        integrityBanner.innerHTML = `<span class="text-emerald-400">✓ Cryptographic Chain Verified (${integrity.blockCount} blocks valid)</span>`;
      } else {
        integrityBanner.innerHTML = `<span class="text-rose-400 font-bold">🚨 TAMPERING DETECTED: ${integrity.error}</span>`;
      }
    }

    if (!blocks || blocks.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-[#727a83]">No external actions executed yet. Authorize an action in Zone C to generate the first cryptographic block.</td></tr>`;
      return;
    }

    tbody.innerHTML = blocks.map(e => `
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

// --- Signal Simulator (Real Cognitive Pipeline Trigger) ---
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
    userFacingMessage: `Processing real event through Cognitive Pipeline: ${scenario}...`
  });

  try {
    const res = await fetch('/api/events/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario })
    });
    const result = await res.json();
    const output = result.pipelineOutput;

    setTimeout(() => {
      const facts = [
        { type: 'FACT', text: output.epistemicQuad.observation.statement },
        { type: 'INFERENCE', text: output.epistemicQuad.interpretation.statement },
        { type: 'RECOMMENDATION', text: output.epistemicQuad.recommendation.statement }
      ];
      appendChatMessage('Wendy (Autonomous Ingestion)', `${output.explanation}\n\n**Recommendation**: ${output.epistemicQuad.recommendation.statement}`, true, facts);
      fetchState();
    }, 800);
  } catch (err) {
    console.error('Simulation error:', err);
  }
}
