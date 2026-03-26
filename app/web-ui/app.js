'use strict';

// ---- State ----
const state = {
  recording: false,
  speakers: {}, // id -> { name, color }
  segments: [], // ordered transcript segments
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
      showDebrief(msg.text);
      break;
    case 'speaker_update':
      updateSpeakerName(msg.speaker_id, msg.name);
      break;
    case 'status':
      if (msg.state === 'ready') {
        setPipelineReady(true);
      } else if (msg.state === 'recording') {
        setRecordingState(true);
      } else if (msg.state === 'stopped') {
        setRecordingState(false);
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
    // Update existing (partial transcription updated)
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

  // Remove 'new' glow after animation
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

function showDebriefLoading() {
  _summaryText = '';
  document.getElementById('btn-copy').style.display = 'none';
  document.getElementById('debrief-body').innerHTML =
    '<div class="debrief-loader">' +
    '<div class="debrief-loader-row"><div class="spinner"></div><span>Re-transcribing session audio…</span></div>' +
    '<div class="debrief-loader-sub">Generating debrief — this may take a moment</div>' +
    '</div>';
  // Populate transcript tab now (segments are complete at this point)
  populateTranscriptTab();
  showPage('debrief');
  switchTab('debrief-tab');
}

function populateTranscriptTab() {
  const el = document.getElementById('transcript-tab-body');
  if (!el) return;
  if (!state.segments.length) {
    el.innerHTML = '<p class="tab-empty">No transcript recorded.</p>';
    return;
  }
  el.innerHTML = state.segments.map(seg => {
    const spk = (state.speakers[seg.speaker_id] || {}).name || seg.speaker_name || seg.speaker_id;
    const color = (state.speakers[seg.speaker_id] || {}).color || '#888';
    const time = formatTime(seg.start_us);
    return `<div class="tx-seg">
      <div class="tx-seg-header">
        <span class="tx-spk" style="color:${color}">${escHtml(spk)}</span>
        <span class="tx-time">${time}</span>
      </div>
      <div class="tx-text">${escHtml(seg.text)}</div>
    </div>`;
  }).join('');
}

function switchTab(tabId) {
  document.querySelectorAll('.debrief-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.debrief-tab-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById(tabId).classList.add('active');
  document.getElementById(tabId + '-panel').classList.remove('hidden');
  // Copy button only relevant on debrief tab
  document.getElementById('btn-copy').style.display =
    (tabId === 'debrief-tab' && _summaryText) ? '' : 'none';
}

function showDebrief(text) {
  _summaryText = text;
  document.getElementById('debrief-body').innerHTML = text
    ? marked.parse(text)
    : '<p class="tab-empty">No debrief available — conversation too short or Ollama unreachable.</p>';
  // Show copy button and switch to debrief tab
  switchTab('debrief-tab');
}

function newSession() {
  state.segments = [];
  state.speakers = {};
  document.getElementById('transcript').innerHTML = '';
  document.getElementById('speakers-list').innerHTML = '';
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

  // Update input
  const input = document.querySelector(`#spk-row-${id} input`);
  if (input && document.activeElement !== input) input.value = name;

  // Update all transcript segments for this speaker
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

// ---- Controls ----
async function startRecording() {
  try {
    await invoke('start_recording');
    setRecordingState(true);
  } catch (e) {
    alert(`Start error: ${e}`);
  }
}

async function stopRecording() {
  try {
    await invoke('stop_recording');
    setRecordingState(false);
    showDebriefLoading();
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
    // Only navigate away from workspace (not from debrief which is already showing)
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

  // Fetch initial status
  invoke('get_status')
    .then(d => setRecordingState(d.recording))
    .catch(() => {});

  connectTauri();
});
