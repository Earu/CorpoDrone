'use strict';

// ---- State ----
const state = {
  ws: null,
  recording: false,
  speakers: {}, // id -> { name, color }
  segments: [], // ordered transcript segments
  autoScroll: true,
};

const SPEAKER_COLORS = [
  '#6c63ff', '#63b3ed', '#68d391', '#f6ad55',
  '#fc8181', '#b794f4', '#76e4f7', '#fbd38d',
];

// ---- WebSocket ----
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    setWsBadge(true);
    console.log('[WS] connected');
  };

  ws.onclose = () => {
    setWsBadge(false);
    console.log('[WS] disconnected, reconnecting in 2s...');
    setTimeout(connectWS, 2000);
  };

  ws.onerror = (e) => console.error('[WS] error', e);

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    } catch (err) {
      console.error('[WS] bad JSON', e.data, err);
    }
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'segment':
      addSegment(msg);
      break;
    case 'summary':
      updateSummary(msg.text);
      break;
    case 'speaker_update':
      updateSpeakerName(msg.speaker_id, msg.name);
      break;
    case 'status':
      setRecordingState(msg.state === 'recording');
      break;
    default:
      console.log('[WS] unknown msg type', msg.type, msg);
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

// ---- Summary ----
function updateSummary(text) {
  const el = document.getElementById('summary');
  el.textContent = text;
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
    await fetch('/api/speakers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speaker_id: id, name }),
    });
  } catch (e) {
    console.error('rename failed', e);
  }
}

// ---- Controls ----
async function startRecording() {
  try {
    const res = await fetch('/api/start', { method: 'POST' });
    if (!res.ok) {
      const text = await res.text();
      alert(`Start failed: ${text}`);
      return;
    }
    setRecordingState(true);
  } catch (e) {
    alert(`Start error: ${e}`);
  }
}

async function stopRecording() {
  try {
    const res = await fetch('/api/stop', { method: 'POST' });
    if (!res.ok) {
      const text = await res.text();
      alert(`Stop failed: ${text}`);
      return;
    }
    setRecordingState(false);
  } catch (e) {
    alert(`Stop error: ${e}`);
  }
}

function setRecordingState(recording) {
  state.recording = recording;
  document.getElementById('btn-start').disabled = recording;
  document.getElementById('btn-stop').disabled = !recording;
  const badge = document.getElementById('status-badge');
  badge.textContent = recording ? 'Recording' : 'Idle';
  badge.className = `badge ${recording ? 'badge-recording' : 'badge-idle'}`;
}

// ---- Helpers ----
function setWsBadge(connected) {
  const badge = document.getElementById('ws-badge');
  badge.className = `badge ${connected ? 'badge-connected' : 'badge-disconnected'}`;
  badge.textContent = connected ? 'Connected' : 'Disconnected';
}

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
  fetch('/api/status')
    .then(r => r.json())
    .then(d => setRecordingState(d.recording))
    .catch(() => {});

  connectWS();
});
