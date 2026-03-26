'use strict';

// ---- State ----
const state = {
  recording: false,
  muted: false,
  speakers: {}, // id -> { name, color }
  segments: [], // ordered live transcript segments
  autoScroll: true,
};

const SPEAKER_COLORS = [
  '#6c63ff', '#63b3ed', '#68d391', '#f6ad55',
  '#fc8181', '#b794f4', '#76e4f7', '#fbd38d',
];

// ---- Tauri bridge ----
function invoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

async function connectTauri() {
  await window.__TAURI__.event.listen('pipeline-event', (event) => {
    handleMessage(event.payload);
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'segment':
      addSegment(msg);
      break;
    case 'final_summary':
      if (currentPage() === 'debrief') showDebrief(msg);
      break;
    case 'speaker_update':
      updateSpeakerName(msg.speaker_id, msg.name);
      break;
    case 'progress':
      if (currentPage() === 'debrief') handleProgress(msg);
      break;
    case 'enrollment_data':
      handleEnrollmentData(msg);
      break;
    case 'status':
      if (msg.state === 'ready') {
        setPipelineReady(true);
      } else if (msg.state === 'recording') {
        setRecordingState(true);
      } else if (msg.state === 'session_ended') {
        if (currentPage() === 'debrief') {
          if (_enrollmentData && _enrollmentData.length) {
            openEnrollmentModal();
          } else {
            showChoiceUI();
          }
        }
      } else if (msg.state === 'stopped') {
        setRecordingState(false);
        setPipelineReady(false);  // Python is exiting and will restart — wait for next 'ready'
      }
      break;
    default:
      console.log('[Tauri] unknown msg type', msg.type, msg);
  }
}

// ---- Transcript ----
function addSegment(msg) {
  const existing = state.segments.find(s => s.id === msg.id);
  if (existing) {
    existing.text = msg.text;
    const el = document.getElementById(`seg-${msg.id}`);
    if (el) el.querySelector('.segment-text').textContent = msg.text;
    return;
  }

  state.segments.push(msg);
  ensureSpeaker(msg.speaker_id);

  const container = document.getElementById('transcript');
  const spk = state.speakers[msg.speaker_id] || { name: msg.speaker_id, color: '#888' };
  const time = formatTime(msg.start_us);
  const sourceClass = msg.source === 'mic' ? 'source-mic' : 'source-loopback';
  const sourceLabel = msg.source === 'mic' ? 'MIC' : 'OUT';

  const el = document.createElement('div');
  el.className = 'segment new';
  el.id = `seg-${msg.id}`;
  el.innerHTML = `
    <div class="segment-header">
      <span class="speaker-dot" style="background:${spk.color}"></span>
      <span class="segment-speaker" style="color:${spk.color}">${escHtml(spk.name)}</span>
      <span class="source-tag ${sourceClass}">${sourceLabel}</span>
      <span class="segment-time">${time}</span>
    </div>
    <div class="segment-text">${escHtml(msg.text)}</div>
  `;
  container.appendChild(el);

  setTimeout(() => el.classList.remove('new'), 500);

  if (state.autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function clearTranscript() {
  state.segments = [];
  document.getElementById('transcript').innerHTML = '';
}

// ---- Debrief page ----
let _summaryText = '';

function showChoiceUI() {
  document.getElementById('debrief-choice').classList.remove('hidden');
  document.getElementById('debrief-progress').classList.add('hidden');
  document.getElementById('debrief-body').innerHTML = '';
  document.getElementById('btn-copy').style.display = 'none';
  // Transcript tab stays empty until we have the final transcript
  const el = document.getElementById('transcript-tab-body');
  if (el) el.innerHTML = '<p class="tab-empty">Waiting for transcript…</p>';
}

async function choosePipelineMode(mode) {
  document.getElementById('debrief-choice').classList.add('hidden');
  document.getElementById('debrief-progress').classList.remove('hidden');
  setOverallProgress(0, mode === 'retranscribe' ? 'Starting re-transcription…' : 'Building summary…');
  try {
    await invoke('set_pipeline_mode', { mode });
  } catch (e) {
    console.error('set_pipeline_mode failed', e);
  }
}

function handleProgress(msg) {
  // Map two-stage pipeline onto a single 0-100 bar:
  // retranscribe: 0-60, summarize: 60-100 (or 0-100 if no retranscription)
  let overall;
  if (msg.stage === 'retranscribe') {
    overall = Math.round(msg.pct * 0.6);
  } else {
    overall = 60 + Math.round(msg.pct * 0.4);
  }
  setOverallProgress(overall, msg.label || '');
}

function setOverallProgress(pct, label) {
  const fill = document.getElementById('debrief-progress-fill');
  const pctEl = document.getElementById('debrief-progress-pct');
  const labelEl = document.getElementById('debrief-progress-label');
  if (fill) fill.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + '%';
  if (labelEl) labelEl.textContent = label;
}

function populateTranscriptTab(segments) {
  const el = document.getElementById('transcript-tab-body');
  if (!el) return;
  if (!segments || !segments.length) {
    el.innerHTML = '<p class="tab-empty">No transcript recorded.</p>';
    return;
  }
  // Segments may come from live state (have speaker_id) or re-transcribed (have speaker string)
  el.innerHTML = segments.map(seg => {
    const isLive = seg.speaker_id !== undefined;
    const spkName = isLive
      ? ((state.speakers[seg.speaker_id] || {}).name || seg.speaker_name || seg.speaker_id)
      : (seg.speaker || 'Unknown');
    const color = isLive
      ? ((state.speakers[seg.speaker_id] || {}).color || '#888')
      : nameToColor(spkName);
    const time = formatTime(seg.start_us || 0);
    return `<div class="tx-seg">
      <div class="tx-seg-header">
        <span class="tx-spk" style="color:${color}">${escHtml(spkName)}</span>
        <span class="tx-time">${time}</span>
      </div>
      <div class="tx-text">${escHtml(seg.text)}</div>
    </div>`;
  }).join('');
}

function nameToColor(name) {
  // Deterministic color from name string
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff;
  return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length];
}

function switchTab(tabId) {
  document.querySelectorAll('.debrief-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.debrief-tab-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById(tabId).classList.add('active');
  document.getElementById(tabId + '-panel').classList.remove('hidden');
  document.getElementById('btn-copy').style.display =
    (tabId === 'debrief-tab' && _summaryText) ? '' : 'none';
}

function showDebrief(msg) {
  const text = typeof msg === 'string' ? msg : (msg.text || '');
  const transcriptSegs = (typeof msg === 'object' && msg.transcript) ? msg.transcript : null;

  _summaryText = text;
  document.getElementById('debrief-choice').classList.add('hidden');
  document.getElementById('debrief-progress').classList.add('hidden');
  document.getElementById('debrief-body').innerHTML = text
    ? marked.parse(text)
    : '<p class="tab-empty">No debrief available — conversation too short or Ollama unreachable.</p>';

  // Populate transcript tab: prefer re-transcribed segments, fall back to live segments
  if (transcriptSegs && transcriptSegs.length > 0) {
    populateTranscriptTab(transcriptSegs);
  } else {
    populateTranscriptTab(state.segments);
  }

  switchTab('debrief-tab');
}

function newSession() {
  state.segments = [];
  state.speakers = {};
  _summaryText = '';
  _enrollmentData = null;
  _enrollmentResult = {};
  setMuteState(false);
  document.getElementById('transcript').innerHTML = '';
  document.getElementById('speakers-list').innerHTML = '';
  document.getElementById('debrief-choice').classList.add('hidden');
  document.getElementById('debrief-progress').classList.add('hidden');
  document.getElementById('debrief-body').innerHTML = '';
  const txBody = document.getElementById('transcript-tab-body');
  if (txBody) txBody.innerHTML = '';
  showPage('landing');
}

async function copySummary() {
  if (!_summaryText) return;
  try {
    await navigator.clipboard.writeText(_summaryText);
    const btn = document.getElementById('btn-copy');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
  } catch (e) {
    console.error('copy failed', e);
  }
}

// ---- Speakers ----
function ensureSpeaker(id) {
  if (state.speakers[id]) return;
  const idx = Object.keys(state.speakers).length % SPEAKER_COLORS.length;
  state.speakers[id] = { name: id, color: SPEAKER_COLORS[idx] };
  renderSpeakerRow(id);
}

function renderSpeakerRow(id) {
  const spk = state.speakers[id];
  const list = document.getElementById('speakers-list');
  const row = document.createElement('div');
  row.className = 'speaker-row';
  row.id = `spk-row-${id}`;
  row.innerHTML = `
    <span class="speaker-dot" style="background:${spk.color}"></span>
    <input
      class="speaker-name-input"
      value="${escHtml(spk.name)}"
      placeholder="Speaker name"
      onchange="renameSpeaker('${id}', this.value)"
      onkeydown="if(event.key==='Enter') this.blur()"
    />
  `;
  list.appendChild(row);
}

function updateSpeakerName(id, name) {
  ensureSpeaker(id);
  state.speakers[id].name = name;

  const input = document.querySelector(`#spk-row-${id} input`);
  if (input && document.activeElement !== input) input.value = name;

  document.querySelectorAll(`[id^="seg-"]`).forEach(el => {
    const seg = state.segments.find(s => `seg-${s.id}` === el.id);
    if (seg && seg.speaker_id === id) {
      el.querySelector('.segment-speaker').textContent = name;
    }
  });
}

async function renameSpeaker(id, name) {
  state.speakers[id].name = name;
  try {
    await invoke('update_speaker', { speaker_id: id, name });
  } catch (e) {
    console.error('rename failed', e);
  }
}

// ---- Speaker enrollment ----
let _enrollmentData = null;   // speakers array from enrollment_data event
let _enrollmentIdx = 0;       // current carousel page
let _enrollmentResult = {};   // session_id → { person_id, name, embedding }
let _knownPersons = [];       // fetched from get_speaker_database

async function handleEnrollmentData(msg) {
  if (!msg.speakers || !msg.speakers.length) return;
  _enrollmentData = msg.speakers;
  _enrollmentIdx = 0;
  _enrollmentResult = {};
  try {
    const db = await invoke('get_speaker_database');
    _knownPersons = Object.entries(db.persons || {}).map(([id, p]) => ({ id, name: p.name }));
  } catch (e) {
    _knownPersons = [];
  }
}

function openEnrollmentModal() {
  if (!_enrollmentData || !_enrollmentData.length) {
    showChoiceUI();
    return;
  }
  renderEnrollmentPage(_enrollmentIdx);
  document.getElementById('enrollment-modal').classList.remove('hidden');
}

// _enrollmentResult: { session_id: [ { discarded, person_id, name, embedding } | null, ... ] }
// One entry per clip index; null = unassigned (will be ignored on submit)

function renderEnrollmentPage(idx) {
  const spk = _enrollmentData[idx];
  const carousel = document.getElementById('enrollment-carousel');
  document.getElementById('enrollment-page-label').textContent = `${idx + 1} / ${_enrollmentData.length}`;

  if (!_enrollmentResult[spk.session_id]) {
    _enrollmentResult[spk.session_id] = spk.clips.map(() => null);
  }
  const clipStates = _enrollmentResult[spk.session_id];

  const clipsHtml = spk.clips.map((clip, i) => {
    const st = clipStates[i];
    const discarded = st && st.discarded;
    const currentVal = (st && !st.discarded && st.name) ? escHtml(st.name) : '';
    const embJson = JSON.stringify(clip.embedding);

    return `<div class="enrollment-clip-row${discarded ? ' discarded' : ''}" id="cliprow-${idx}-${i}">
      <div class="enrollment-clip-header">
        <button class="enrollment-clip-btn${discarded ? ' discarded' : ''}"
          onclick="playEnrollmentClip(this,'${escHtml(clip.audio)}')" ${discarded ? 'disabled' : ''}>
          ▶ Clip ${i + 1}
        </button>
        <button class="enrollment-clip-discard${discarded ? ' active' : ''}"
          onclick="toggleDiscardClip('${escHtml(spk.session_id)}',${i})">
          ${discarded ? '↩ Restore' : '✕ Discard'}
        </button>
      </div>
      ${discarded ? '' : `<div class="enrollment-clip-assign">
        <input class="enrollment-combo-input"
          id="combo-${idx}-${i}"
          list="persons-datalist"
          placeholder="Type name or pick from list…"
          value="${currentVal}"
          oninput="onComboInput('${escHtml(spk.session_id)}',${i},this.value)"
          data-embedding='${embJson}'
        />
      </div>`}
    </div>`;
  }).join('');

  carousel.innerHTML = `
    <datalist id="persons-datalist">
      ${_knownPersons.map(p => `<option value="${escHtml(p.name)}"></option>`).join('')}
    </datalist>
    <div class="enrollment-speaker active">
      <div class="enrollment-speaker-label">UNKNOWN — detected as "${escHtml(spk.name)}" · label each clip individually</div>
      ${clipsHtml}
    </div>`;
}

function playEnrollmentClip(btn, b64) {
  document.querySelectorAll('.enrollment-clip-btn.playing').forEach(b => b.classList.remove('playing'));
  btn.classList.add('playing');
  const audio = new Audio('data:audio/wav;base64,' + b64);
  audio.onended = () => btn.classList.remove('playing');
  audio.play();
}

function toggleDiscardClip(sessionId, clipIdx) {
  const states = _enrollmentResult[sessionId];
  const cur = states[clipIdx];
  states[clipIdx] = cur && cur.discarded ? null : { discarded: true };
  renderEnrollmentPage(_enrollmentIdx);
}

function onComboInput(sessionId, clipIdx, value) {
  const states = _enrollmentResult[sessionId];
  if (!states) return;
  const input = document.getElementById(`combo-${_enrollmentIdx}-${clipIdx}`);
  const embedding = input ? JSON.parse(input.dataset.embedding || '[]') : [];
  if (!value.trim()) {
    states[clipIdx] = null;
    return;
  }
  const known = _knownPersons.find(p => p.name.toLowerCase() === value.trim().toLowerCase());
  states[clipIdx] = {
    person_id: known ? known.id : null,
    name: known ? known.name : value.trim(),
    embedding,
  };
}

function enrollPrev() {
  if (_enrollmentIdx > 0) { _enrollmentIdx--; renderEnrollmentPage(_enrollmentIdx); }
}

function enrollNext() {
  if (_enrollmentIdx < _enrollmentData.length - 1) { _enrollmentIdx++; renderEnrollmentPage(_enrollmentIdx); }
}

async function submitEnrollment() {
  // Persist each non-discarded, assigned clip to the DB
  // Track new person name → assigned id within this submission to group clips for the same new person
  const newPersonIds = {};
  for (const [, clipStates] of Object.entries(_enrollmentResult)) {
    for (const st of clipStates) {
      if (!st || st.discarded || !st.name || !st.embedding || !st.embedding.length) continue;
      try {
        // For new persons (no person_id), reuse the id created in this batch
        const existingNewId = !st.person_id ? newPersonIds[st.name] : null;
        const result = await invoke('enroll_speaker', {
          name: st.name,
          personId: st.person_id || existingNewId || null,
          embedding: st.embedding,
        });
        if (!st.person_id && result.person_id) newPersonIds[st.name] = result.person_id;
      } catch (e) {
        console.error('enroll_speaker failed', e);
      }
    }
  }
  closeEnrollmentModal();
}

function skipEnrollment() {
  closeEnrollmentModal();
}

function closeEnrollmentModal() {
  document.getElementById('enrollment-modal').classList.add('hidden');
  _enrollmentData = null;
  showChoiceUI();
}

// ---- Voice database management ----
async function openVoicesModal() {
  await refreshVoicesList();
  document.getElementById('voices-modal').classList.remove('hidden');
}

function closeVoicesModal() {
  document.getElementById('voices-modal').classList.add('hidden');
}

async function refreshVoicesList() {
  const el = document.getElementById('voices-list');
  let db;
  try { db = await invoke('get_speaker_database'); } catch (e) { el.innerHTML = '<p class="voices-empty">Error loading database.</p>'; return; }
  const persons = Object.entries(db.persons || {});
  if (!persons.length) { el.innerHTML = '<p class="voices-empty">No speakers enrolled yet.</p>'; return; }
  el.innerHTML = persons.map(([id, p]) => `
    <div class="voice-row" id="vrow-${escHtml(id)}">
      <input class="voice-name-input" value="${escHtml(p.name)}"
        onchange="renameVoice('${escHtml(id)}', this.value)"
        onkeydown="if(event.key==='Enter') this.blur()" />
      <span class="voice-count">${p.embeddings ? p.embeddings.length : 0} sample${(p.embeddings || []).length !== 1 ? 's' : ''}</span>
      <button class="voice-delete-btn" onclick="deleteVoice('${escHtml(id)}')">DELETE</button>
    </div>
  `).join('');
}

async function renameVoice(personId, name) {
  if (!name.trim()) return;
  try { await invoke('rename_speaker', { personId, name }); } catch (e) { console.error('rename_speaker failed', e); }
}

async function deleteVoice(personId) {
  try {
    await invoke('delete_speaker', { personId });
    document.getElementById(`vrow-${personId}`)?.remove();
    const el = document.getElementById('voices-list');
    if (!el.children.length) el.innerHTML = '<p class="voices-empty">No speakers enrolled yet.</p>';
  } catch (e) { console.error('delete_speaker failed', e); }
}

// ---- Controls ----
async function toggleMute() {
  const next = !state.muted;
  try {
    await invoke('set_mute', { muted: next });
    setMuteState(next);
  } catch (e) {
    console.error('set_mute failed', e);
  }
}

function setMuteState(muted) {
  state.muted = muted;
  const btn = document.getElementById('btn-mute');
  if (!btn) return;
  btn.textContent = muted ? 'MIC MUTED' : 'MIC ON';
  btn.classList.toggle('muted', muted);
}

async function startRecording() {
  try {
    await invoke('start_recording');
    setRecordingState(true);
  } catch (e) {
    alert(`Start error: ${e}`);
  }
}

async function stopRecording() {
  // Navigate to debrief BEFORE the async invoke so that pipeline events
  // (enrollment_data, session_ended) which may arrive during the await are
  // processed on the correct page instead of being silently dropped.
  setRecordingState(false);
  _enrollmentData = null;
  _enrollmentResult = {};
  showPage('debrief');
  switchTab('debrief-tab');
  document.getElementById('debrief-body').innerHTML =
    '<div class="debrief-loader"><div class="debrief-loader-row"><div class="spinner"></div>' +
    '<span>Session ended — processing…</span></div></div>';
  try {
    await invoke('stop_recording');
  } catch (e) {
    alert(`Stop error: ${e}`);
  }
}

function currentPage() {
  for (const id of ['landing', 'workspace', 'debrief']) {
    if (!document.getElementById(id).classList.contains('hidden')) return id;
  }
  return 'landing';
}

function showPage(page) {
  ['landing', 'workspace', 'debrief'].forEach(id => {
    document.getElementById(id).classList.toggle('hidden', id !== page);
  });
}

function setPipelineReady(ready) {
  const btn = document.getElementById('btn-start');
  if (!btn) return;
  btn.disabled = !ready;
  btn.textContent = ready ? 'START SESSION' : 'LOADING...';
}

function setRecordingState(recording) {
  state.recording = recording;
  if (recording) {
    showPage('workspace');
  } else if (currentPage() === 'workspace') {
    showPage('landing');
  }
  const recDot = document.getElementById('rec-dot');
  if (recDot) recDot.className = `dot ${recording ? 'dot-rec' : ''}`;
}

// ---- Helpers ----
function formatTime(us) {
  const s = Math.floor(us / 1_000_000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Auto-scroll toggle on manual scroll
document.addEventListener('DOMContentLoaded', () => {
  const transcript = document.getElementById('transcript');
  transcript.addEventListener('scroll', () => {
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    state.autoScroll = atBottom;
  });

  invoke('get_status')
    .then(d => { setRecordingState(d.recording); setMuteState(d.muted ?? false); })
    .catch(() => {});

  connectTauri();
});
