/**
 * WENDY LEGACY PROTOTYPE CLIENT (frozen UI)
 * Renders only server state. All server-provided text is HTML-escaped.
 */

let appState = null;

document.addEventListener('DOMContentLoaded', () => {
  fetchState();
  const events = new EventSource('/api/stream');
  events.addEventListener('PROACTIVE_INSIGHT_GENERATED', () => fetchState());
  events.addEventListener('ACTION_APPROVAL_RECORDED', () => fetchState());
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    appState = await res.json();
    document.getElementById('dossier-timestamp').innerText = `Loaded ${new Date().toLocaleTimeString()}`;
    renderStagedActions();
    renderMemoryView();
  } catch (err) {
    console.error('Failed to load state from server:', err);
  }
}

function renderStagedActions() {
  const actions = Object.values(appState?.dossier?.stagedActions || {});
  const pending = actions.filter(a => a.state === 'AWAITING_APPROVAL' || a.state === 'PROPOSED');

  const counter = document.getElementById('staging-counter');
  counter.innerText = `${pending.length} Action${pending.length === 1 ? '' : 's'} Awaiting Approval`;

  const container = document.getElementById('staged-actions-container');
  if (actions.length === 0) {
    container.innerHTML = `<div class="p-4 rounded-xl border border-[#22252a] bg-[#141619] text-xs font-mono-code text-[#a3acb5]">No persisted actions.</div>`;
    return;
  }

  container.innerHTML = actions.map(a => {
    const id = escapeHtml(a.actionId);
    const editable = a.state === 'AWAITING_APPROVAL';
    return `
      <div class="p-5 rounded-xl border border-[#22252a] bg-[#16181b] space-y-3" data-action-id="${id}">
        <div class="flex items-center justify-between text-[10px] font-mono-code">
          <span class="text-amber-300">LEVEL ${escapeHtml(a.authorizationLevel)} — ${escapeHtml(a.actionType)}</span>
          <span class="text-[#a3acb5]">${escapeHtml(a.state)}</span>
        </div>
        <h3 class="text-sm text-white">${escapeHtml(a.headline || a.actionId)}</h3>
        <p class="text-[11px] font-mono-code text-[#727a83]">Recipient: ${escapeHtml(a.preview?.recipient || '-')}</p>
        <textarea rows="6" class="w-full bg-[#0d0e10] border border-[#272a30] text-[#ededed] p-3 rounded text-xs" ${editable ? '' : 'disabled'}
          oninput="syncDraftState('${id}', this.value)">${escapeHtml(a.preview?.body || '')}</textarea>
        ${editable ? `
        <div class="flex gap-2">
          <button onclick="authorizeAction('${id}', this)" class="flex-1 py-2 rounded-lg text-xs font-mono-code bg-emerald-900 text-white">Approve</button>
          <button onclick="rejectAction('${id}')" class="px-4 py-2 rounded-lg text-xs font-mono-code border border-[#2b2f36] text-white">Dismiss</button>
        </div>` : ''}
        ${a.rejectionReason ? `<p class="text-[11px] text-rose-300">Rejected: ${escapeHtml(a.rejectionReason)}</p>` : ''}
      </div>`;
  }).join('');
}

function switchView(viewName) {
  document.getElementById('view-workspace').classList.toggle('hidden', viewName !== 'workspace');
  document.getElementById('view-memory').classList.toggle('hidden', viewName !== 'memory');
  document.getElementById('view-audit').classList.toggle('hidden', viewName !== 'audit');

  ['workspace', 'memory', 'audit'].forEach(v => {
    const btn = document.getElementById(`btn-view-${v}`);
    btn.className = v === viewName
      ? 'px-3 py-1.5 rounded text-xs font-mono-code font-medium bg-[#22252a] text-white border border-[#32363d] transition-colors'
      : 'px-3 py-1.5 rounded text-xs font-mono-code font-medium text-[#8e969f] hover:text-white transition-colors';
  });

  if (viewName === 'audit') fetchAuditData();
  if (viewName === 'memory') fetchState();
}

async function handleUserMessage(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  appendChatMessage('You', message);
  input.value = '';
  try {
    const data = await postJson('/api/chat', { query: message });
    appendChatMessage('Legacy retrieval', data.reply, data.epistemicBreakdown);
  } catch (err) {
    appendChatMessage('Error', err.message);
  }
}

function appendChatMessage(sender, text, records = []) {
  const container = document.getElementById('chat-stream');
  const wrapper = document.createElement('div');
  wrapper.className = 'space-y-2';
  const recordsHtml = (records || []).map(r =>
    `<div class="text-[11px] font-mono-code text-[#a3acb5]">[${escapeHtml(r.type)}] ${escapeHtml(r.text)}</div>`
  ).join('');
  wrapper.innerHTML = `
    <div class="text-xs text-[#727a83]">${escapeHtml(sender)} • ${new Date().toLocaleTimeString()}</div>
    <div class="p-4 rounded-xl border border-[#22252a] bg-[#141619] text-[#ededed] text-[14px]">
      <div class="whitespace-pre-wrap">${escapeHtml(text)}</div>
      ${recordsHtml ? `<div class="mt-3 pt-2 border-t border-[#22252a] space-y-1">${recordsHtml}</div>` : ''}
    </div>`;
  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
}

async function syncDraftState(actionId, newBody) {
  try {
    await postJson('/api/action/sync', { actionId, modifiedBody: newBody });
  } catch (err) {
    console.warn('Draft sync failed:', err.message);
  }
}

async function authorizeAction(actionId, button) {
  button.disabled = true;
  const card = document.querySelector(`[data-action-id="${CSS.escape(actionId)}"]`);
  const modifiedBody = card?.querySelector('textarea')?.value;
  try {
    const result = await postJson('/api/action/authorize', { actionId, modifiedBody });
    const d = result.dispatch;
    appendChatMessage('System', `Approval recorded (audit block #${result.auditEntry.sequenceNumber}). Dispatch status: ${d.status}${d.result?.detail ? ` — ${d.result.detail}` : ''}`);
  } catch (err) {
    appendChatMessage('Error', `Approval failed: ${err.message}`);
  }
  await fetchState();
}

async function rejectAction(actionId) {
  const reason = prompt('Reason for dismissing this action (optional):');
  if (reason === null) return;
  try {
    await postJson('/api/action/reject', { actionId, reason: reason || null });
  } catch (err) {
    appendChatMessage('Error', `Dismiss failed: ${err.message}`);
  }
  await fetchState();
}

function closeProvenanceModal() {
  document.getElementById('modal-provenance').classList.add('hidden');
}

function renderMemoryView() {
  const container = document.getElementById('memory-cards-container');
  if (!container || !appState) return;
  const people = Object.values(appState.memory.people || {});
  const preferences = appState.memory.preferences || [];
  const episodic = appState.memory.recentEpisodic || [];
  const card = (title, items) => `
    <div class="p-5 rounded-xl border border-[#22252a] bg-[#141619] space-y-3">
      <h3 class="text-sm font-semibold text-white font-mono-code uppercase">${escapeHtml(title)}</h3>
      <div class="space-y-2 text-xs">${items.join('')}</div>
    </div>`;
  const row = (head, body) => `<div class="p-3 rounded bg-[#0d0e10] border border-[#22252a]"><div class="text-white">${head}</div><div class="text-[#a3acb5] text-[11px] mt-1">${body}</div></div>`;
  container.innerHTML =
    card(`Persisted people (${people.length})`, people.map(p => row(escapeHtml(p.fullName), `${escapeHtml(p.title || '')} • source: ${escapeHtml(p.provenance?.sourceType || 'unlabeled')}`))) +
    card(`Episodic records (${episodic.length})`, episodic.map(e => row(escapeHtml(e.interactionType), escapeHtml(e.summary)))) +
    card(`Preferences (${preferences.length})`, preferences.map(p => row(escapeHtml(p.domain), escapeHtml(p.rule))));
}

async function fetchAuditData() {
  try {
    const res = await fetch('/api/audit');
    const { integrity, blocks } = await res.json();
    const banner = document.getElementById('audit-integrity-status');
    banner.innerHTML = integrity.valid
      ? `<span class="text-emerald-400">Chain verified (${escapeHtml(integrity.blockCount)} blocks)</span>`
      : `<span class="text-rose-400 font-bold">INTEGRITY FAILURE: ${escapeHtml(integrity.error)}</span>`;
    const tbody = document.getElementById('audit-table-body');
    tbody.innerHTML = blocks.length === 0
      ? `<tr><td colspan="7" class="p-4 text-center text-[#727a83]">No audit blocks yet.</td></tr>`
      : blocks.map(e => `
        <tr>
          <td class="p-3 text-[#727a83]">#${escapeHtml(e.sequenceNumber)}</td>
          <td class="p-3 text-[#a3acb5]">${escapeHtml(new Date(e.timestamp).toLocaleTimeString())}</td>
          <td class="p-3 text-white">${escapeHtml(e.eventType)}</td>
          <td class="p-3">Level ${escapeHtml(e.authorizationLevel)}</td>
          <td class="p-3 text-[#a3acb5]">${escapeHtml(e.actorId)}</td>
          <td class="p-3">${escapeHtml(e.verificationStatus)}</td>
          <td class="p-3 text-emerald-400 font-mono-code">${escapeHtml(e.entryHash.slice(0, 20))}...</td>
        </tr>`).join('');
  } catch (err) {
    console.error('Audit fetch error:', err);
  }
}

function openEventSimulator() {
  document.getElementById('modal-simulator').classList.remove('hidden');
}

function closeEventSimulator() {
  document.getElementById('modal-simulator').classList.add('hidden');
}

async function injectSimulatedEvent() {
  const scenario = document.getElementById('sim-scenario').value;
  closeEventSimulator();
  try {
    const { pipelineOutput: o } = await postJson('/api/events/simulate', { scenario });
    appendChatMessage('Legacy pipeline (DEV FIXTURE)', `${o.epistemicQuad.observation.statement}\n\nInterpretation / anticipation / recommendation: NOT IMPLEMENTED in the legacy prototype.`);
  } catch (err) {
    appendChatMessage('Error', err.message);
  }
  fetchState();
}
