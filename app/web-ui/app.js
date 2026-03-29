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
  await window.__TAURI__.event.listen('log-line', (event) => {
    appendLogLine(event.payload.process, event.payload.line);
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'segment':
      addSegment(msg);
      break;
    case 'final_summary':
      if (!_ignoredProcessing && currentPage() === 'debrief') showDebrief(msg);
      break;
    case 'speaker_update':
      updateSpeakerName(msg.speaker_id, msg.name);
      break;
    case 'speaker_merge':
      mergeSpeaker(msg.from_id, msg.into_id, msg.name);
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
        if (_ignoredProcessing) break;
        const modal = document.getElementById('end-session-modal');
        if (!modal.classList.contains('hidden')) {
          modal.classList.add('hidden');
          _enterDebrief();
        }
        _sessionEnded = true;
        if (currentPage() === 'debrief') {
          if (_enrollmentReady && _enrollmentData && _enrollmentData.length) {
            openEnrollmentModal();
          } else if (!_enrollmentData) {
            // No enrollment data coming — go straight to choice UI
            showChoiceUI();
          }
          // else: enrollment data is still being fetched — handleEnrollmentData will open modal
        }
      } else if (msg.state === 'pipeline_crashed') {
        setPipelineReady(false);
        if (!_ignoredProcessing && currentPage() === 'debrief') {
          document.getElementById('debrief-choice').classList.add('hidden');
          document.getElementById('debrief-progress').classList.add('hidden');
          document.getElementById('debrief-body').innerHTML =
            '<p class="tab-empty">Pipeline stopped — live transcript preserved in the Transcript tab.</p>';
          populateTranscriptTab(state.segments);
          switchTab('transcript-tab');
        }
      } else if (msg.state === 'stopped') {
        setRecordingState(false);
        setPipelineReady(false);  // Python process is exiting (app closing)
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
let _transcriptSegs = [];
let _pipelineActive = false;   // true while audio-capture is running
let _ignoredProcessing = false; // true after user clicked "Ignore and continue"

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
  // For modes that produce a summary, verify Ollama is available first.
  let ollamaCfg = null;
  try {
    ollamaCfg = await invoke('get_ollama_config');
  } catch (e) {
    console.error('get_ollama_config failed', e);
  }

  if (ollamaCfg && ollamaCfg.summarize) {
    let status = { running: false, has_model: false };
    try {
      status = await invoke('check_ollama_status');
    } catch (e) {
      console.error('check_ollama_status failed', e);
    }
    if (!status.running) {
      openOllamaModal(mode, ollamaCfg, false);
      return;
    }
    if (!status.has_model) {
      openOllamaModal(mode, ollamaCfg, true);
      return;
    }
  }

  _proceedWithMode(mode);
}

async function _proceedWithMode(mode) {
  document.getElementById('debrief-choice').classList.add('hidden');
  document.getElementById('debrief-progress').classList.remove('hidden');
  setOverallProgress(0, mode === 'retranscribe' ? 'Starting re-transcription…' : 'Building summary…');
  try {
    await invoke('set_pipeline_mode', { mode });
  } catch (e) {
    console.error('set_pipeline_mode failed', e);
  }
}

// ---- Ollama modal ----
let _ollamaMode = null;       // pending pipeline mode to proceed with
let _ollamaCfg = null;        // { host, model }
let _ollamaTimer = null;      // setInterval polling handle
let _ollamaTimeout = null;    // setTimeout 30s handle

function openOllamaModal(mode, cfg, needsPull = false) {
  _ollamaMode = mode;
  _ollamaCfg = cfg;

  const sub = document.getElementById('ollama-modal-sub');
  const startBtn = document.getElementById('ollama-start-btn');
  const startingRow = document.getElementById('ollama-starting-row');
  const statusLabel = document.getElementById('ollama-status-label');
  const timeoutMsg = document.getElementById('ollama-timeout-msg');

  if (needsPull) {
    sub.textContent = `Model "${cfg.model}" is not downloaded yet`;
    startBtn.textContent = `Pull ${cfg.model}`;
    statusLabel.textContent = `Downloading ${cfg.model}…`;
  } else {
    sub.textContent = 'Ollama is required to generate a debrief summary';
    startBtn.textContent = 'Start Ollama';
    statusLabel.textContent = 'Starting Ollama…';
  }

  startBtn.disabled = false;
  startingRow.classList.add('hidden');
  timeoutMsg.classList.add('hidden');
  document.getElementById('ollama-desc').classList.remove('hidden');

  document.getElementById('ollama-modal').classList.remove('hidden');
}

async function startOllama() {
  const startBtn = document.getElementById('ollama-start-btn');
  const skipBtn = document.getElementById('ollama-skip-btn');
  const startingRow = document.getElementById('ollama-starting-row');
  const timeoutMsg = document.getElementById('ollama-timeout-msg');

  startBtn.disabled = true;
  skipBtn.disabled = true;
  document.getElementById('ollama-desc').classList.add('hidden');
  startingRow.classList.remove('hidden');
  timeoutMsg.classList.add('hidden');

  // Spawn ollama serve — check immediately if the binary was found
  let spawnResult = { ok: false, error: 'unknown' };
  try {
    spawnResult = await invoke('start_ollama_service');
  } catch (e) {
    spawnResult = { ok: false, error: String(e) };
  }

  if (!spawnResult.ok) {
    _clearOllamaTimers();
    startBtn.disabled = false;
    skipBtn.disabled = false;
    startingRow.classList.add('hidden');
    document.getElementById('ollama-desc').classList.remove('hidden');
    timeoutMsg.innerHTML =
      'Ollama is not installed. <a class="btn-inline-link" href="https://ollama.com" target="_blank">Download it from ollama.com</a> and restart.';
    timeoutMsg.classList.remove('hidden');
    return;
  }

  _clearOllamaTimers();

  // Poll every 2s, 30s total timeout
  _ollamaTimer = setInterval(async () => {
    let status = { running: false, has_model: false };
    try { status = await invoke('check_ollama_status'); } catch {}
    if (!status.running) return;
    if (status.has_model) {
      _clearOllamaTimers();
      closeOllamaModal();
      _proceedWithMode(_ollamaMode);
    } else {
      // Ollama is up but still pulling — update the label
      document.getElementById('ollama-status-label').textContent = `Downloading ${_ollamaCfg.model}…`;
    }
  }, 2000);

  _ollamaTimeout = setTimeout(() => {
    _clearOllamaTimers();
    startBtn.disabled = false;
    skipBtn.disabled = false;
    startingRow.classList.add('hidden');
    timeoutMsg.classList.remove('hidden');
    document.getElementById('ollama-desc').classList.add('hidden');
  }, 30000);
}

function retryOllama() {
  startOllama();
}

function skipOllama() {
  _clearOllamaTimers();
  closeOllamaModal();
  // No debrief — show transcript only
  document.getElementById('debrief-choice').classList.add('hidden');
  document.getElementById('debrief-body').innerHTML =
    '<p class="tab-empty">Debrief skipped — Ollama not started.</p>';
  populateTranscriptTab(state.segments);
  switchTab('transcript-tab');
}

function closeOllamaModal() {
  document.getElementById('ollama-modal').classList.add('hidden');
}

function _clearOllamaTimers() {
  if (_ollamaTimer) { clearInterval(_ollamaTimer); _ollamaTimer = null; }
  if (_ollamaTimeout) { clearTimeout(_ollamaTimeout); _ollamaTimeout = null; }
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
  _transcriptSegs = segments || [];
  const el = document.getElementById('transcript-tab-body');
  if (!el) return;
  if (!_transcriptSegs.length) {
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
  const showCopy = (tabId === 'debrief-tab' && !!_summaryText) ||
                   (tabId === 'transcript-tab' && _transcriptSegs.length > 0);
  document.getElementById('btn-copy').style.display = showCopy ? '' : 'none';
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

async function confirmEndSession() {
  _pipelineActive = false;
  document.getElementById('end-session-modal').classList.remove('hidden');
  try {
    await invoke('stop_recording');
  } catch (e) {
    _enterDebrief();
  }
}

async function ignoreAndContinue() {
  _ignoredProcessing = true;
  document.getElementById('end-session-modal').classList.add('hidden');
  try { await invoke('kill_pipeline'); } catch (_) {}
  // Show debrief tab with fallback message and populate transcript with live segments
  state.recording = false;
  const recDot = document.getElementById('rec-dot');
  if (recDot) recDot.className = 'dot';
  showPage('debrief');
  switchTab('debrief-tab');
  document.getElementById('debrief-body').innerHTML =
    '<p class="tab-empty">Debrief unavailable — session was ended before processing completed.</p>';
  populateTranscriptTab(state.segments);
}

function _enterDebrief() {
  state.recording = false;
  const recDot = document.getElementById('rec-dot');
  if (recDot) recDot.className = 'dot';
  // Don't clear _enrollmentData here — handleEnrollmentData may have already set it
  // and its async DB fetch is still in progress. It gets cleared by closeEnrollmentModal()
  // or newSession().
  showPage('debrief');
  switchTab('debrief-tab');
  document.getElementById('debrief-body').innerHTML =
    '<div class="debrief-loader"><div class="debrief-loader-row"><div class="spinner"></div>' +
    '<span>Session ended — processing…</span></div></div>';
}

function newSession() {
  state.segments = [];
  state.speakers = {};
  _summaryText = '';
  _transcriptSegs = [];
  _ignoredProcessing = false;
  _enrollmentData = null;
  _enrollmentResult = {};
  _enrollmentReady = false;
  _sessionEnded = false;
  _clearOllamaTimers();
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

// ---- Settings ----

async function openSettings() {
  const s = await invoke('get_settings');

  // Populate selects and inputs
  const set = (id, val) => {
    const el = document.getElementById('s-' + id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val ?? '';
  };

  set('whisper_model',              s.whisper_model);
  set('whisper_device',             s.whisper_device);
  set('whisper_compute_type',       s.whisper_compute_type);
  set('window_seconds',             s.window_seconds);
  set('step_seconds',               s.step_seconds);
  set('diarize',                    s.diarize);
  set('hf_token',                   s.hf_token);
  set('min_speakers',               s.min_speakers);
  set('max_speakers',               s.max_speakers);
  set('speaker_enroll',             s.speaker_enroll);
  set('speaker_identify_threshold', s.speaker_identify_threshold);
  set('summarize',                  s.summarize);
  set('ollama_model',               s.ollama_model);
  set('ollama_host',                s.ollama_host);

  // Sync dependent row visibility
  _syncSettingsDependents('diarize');
  _syncSettingsDependents('speaker_enroll');
  _syncSettingsDependents('summarize');

  showPage('settings');
}

function closeSettings() {
  showPage('landing');
}

function settingsToggle(key) {
  _syncSettingsDependents(key);
}

function toggleTokenReveal() {
  const input = document.getElementById('s-hf_token');
  const eyeOn  = document.getElementById('icon-eye');
  const eyeOff = document.getElementById('icon-eye-off');
  const revealing = input.type === 'password';
  input.type = revealing ? 'text' : 'password';
  eyeOn.style.display  = revealing ? 'none'  : '';
  eyeOff.style.display = revealing ? ''      : 'none';
}

function _syncSettingsDependents(key) {
  const checked = document.getElementById('s-' + key)?.checked ?? false;
  document.querySelectorAll(`.settings-dependent[data-depends="${key}"]`).forEach(row => {
    row.classList.toggle('settings-disabled', !checked);
  });
}

async function saveSettings() {
  const get = (id) => {
    const el = document.getElementById('s-' + id);
    if (!el) return undefined;
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number')   return parseFloat(el.value);
    return el.value;
  };

  const settings = {
    whisper_model:               get('whisper_model'),
    whisper_device:              get('whisper_device'),
    whisper_compute_type:        get('whisper_compute_type'),
    window_seconds:              get('window_seconds'),
    step_seconds:                get('step_seconds'),
    diarize:                     get('diarize'),
    hf_token:                    get('hf_token'),
    min_speakers:                Math.round(get('min_speakers')),
    max_speakers:                Math.round(get('max_speakers')),
    speaker_enroll:              get('speaker_enroll'),
    speaker_identify_threshold:  get('speaker_identify_threshold'),
    summarize:                   get('summarize'),
    ollama_model:                get('ollama_model'),
    ollama_host:                 get('ollama_host'),
  };

  try {
    await invoke('save_settings', { settings });
    showPage('landing');
  } catch (e) {
    alert('Failed to save settings: ' + e);
  }
}

async function copySummary() {
  const activeTab = document.querySelector('.debrief-tab.active')?.id;
  let text;
  if (activeTab === 'transcript-tab') {
    text = _transcriptSegs.map(seg => {
      const isLive = seg.speaker_id !== undefined;
      const spkName = isLive
        ? ((state.speakers[seg.speaker_id] || {}).name || seg.speaker_name || seg.speaker_id)
        : (seg.speaker || 'Unknown');
      return `${spkName}: ${seg.text}`;
    }).join('\n');
  } else {
    text = _summaryText;
  }
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
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

function mergeSpeaker(fromId, intoId, name) {
  ensureSpeaker(intoId);
  updateSpeakerName(intoId, name);
  const intoSpk = state.speakers[intoId];
  // Reassign all segments from the duplicate to the canonical speaker
  state.segments.forEach(seg => {
    if (seg.speaker_id !== fromId) return;
    seg.speaker_id = intoId;
    const el = document.getElementById(`seg-${seg.id}`);
    if (el) {
      const dot = el.querySelector('.speaker-dot');
      const label = el.querySelector('.segment-speaker');
      if (dot) dot.style.background = intoSpk.color;
      if (label) { label.textContent = name; label.style.color = intoSpk.color; }
    }
  });
  // Remove the duplicate speaker row
  delete state.speakers[fromId];
  const row = document.getElementById(`spk-row-${fromId}`);
  if (row) row.remove();
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
let _enrollmentReady = false; // DB fetch completed and data is ready
let _sessionEnded = false;    // session_ended status received

async function handleEnrollmentData(msg) {
  if (!msg.speakers || !msg.speakers.length) return;
  _enrollmentData = msg.speakers;
  _enrollmentIdx = 0;
  _enrollmentResult = {};
  _enrollmentReady = false;
  try {
    const db = await invoke('get_speaker_database');
    _knownPersons = Object.entries(db.persons || {}).map(([id, p]) => ({ id, name: p.name }));
  } catch (e) {
    _knownPersons = [];
  }
  _enrollmentReady = true;
  // If session_ended already arrived while we were fetching the DB, open now
  if (_sessionEnded && currentPage() === 'debrief') {
    openEnrollmentModal();
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

// ---- App picker (macOS loopback source selection) ----
async function startRecording() {
  // On macOS, show the app picker — user must select at least one app.
  // On Windows list_loopback_apps returns [], so we skip straight to recording.
  let apps = [];
  try {
    apps = await invoke('list_loopback_apps');
  } catch (e) {
    console.warn('list_loopback_apps failed:', e);
  }

  if (!apps || apps.length === 0) {
    await _doStartRecording([]);
    return;
  }

  _renderAppPickerList(apps);
  document.getElementById('app-picker-modal').classList.remove('hidden');
}

function _renderAppPickerList(apps) {
  const list = document.getElementById('app-picker-list');
  const confirmBtn = document.getElementById('app-picker-confirm');

  list.innerHTML = apps.map(a => `
    <label class="app-picker-app-row">
      <input type="checkbox" class="app-picker-check" value="${escHtml(a.bundle_id)}">
      <span>${escHtml(a.name)}</span>
    </label>
  `).join('');

  // Enable confirm only when at least one app is checked
  list.addEventListener('change', () => {
    const anyChecked = list.querySelector('.app-picker-check:checked') !== null;
    confirmBtn.disabled = !anyChecked;
  });
}

function cancelAppPicker() {
  document.getElementById('app-picker-modal').classList.add('hidden');
}

async function confirmAppPicker() {
  const selectedIds = [...document.querySelectorAll('.app-picker-check:checked')]
    .map(cb => cb.value);
  document.getElementById('app-picker-modal').classList.add('hidden');
  await _doStartRecording(selectedIds);
}

async function _doStartRecording(loopbackApps) {
  try {
    await invoke('start_recording', { loopbackApps });
    _pipelineActive = true;
    setRecordingState(true);
  } catch (e) {
    alert(`Start error: ${e}`);
  }
}


function currentPage() {
  for (const id of ['landing', 'workspace', 'debrief', 'settings']) {
    if (!document.getElementById(id).classList.contains('hidden')) return id;
  }
  return 'landing';
}

function showPage(page) {
  ['landing', 'workspace', 'debrief', 'settings'].forEach(id => {
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

// ---- Debug log drawer ----
const LOG_MAX_LINES = 500;
let _logTab = 'pipeline';

function toggleLog() {
  const drawer = document.getElementById('log-drawer');
  const open = drawer.classList.toggle('open');
  document.getElementById('log-handle-label').textContent = open ? '▼ LOG' : '▲ LOG';
  if (open) {
    const pane = document.getElementById(`log-pane-${_logTab}`);
    if (pane) pane.scrollTop = pane.scrollHeight;
  }
}

function switchLogTab(tab) {
  _logTab = tab;
  document.querySelectorAll('.log-tab').forEach(b => b.classList.remove('active'));
  const btn = [...document.querySelectorAll('.log-tab')].find(b => b.textContent.toLowerCase() === tab);
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.log-pane').forEach(p => p.classList.add('hidden'));
  const pane = document.getElementById(`log-pane-${tab}`);
  if (pane) {
    pane.classList.remove('hidden');
    pane.scrollTop = pane.scrollHeight;
  }
}

function clearCurrentLogTab() {
  const pane = document.getElementById(`log-pane-${_logTab}`);
  if (pane) pane.innerHTML = '';
}

const LOG_LEVEL_STYLES = {
  debug:    'color:#636d83',
  info:     'color:#c8ff00',
  warning:  'color:#e5c07b',
  error:    'color:#e06c75',
  critical: 'color:#e06c75;font-weight:bold',
};

const ANSI_STYLES = {
  '1': 'font-weight:bold', '2': 'opacity:0.55', '3': 'font-style:italic',
  '31': 'color:#e06c75', '32': 'color:#98c379', '33': 'color:#e5c07b',
  '34': 'color:#61afef', '35': 'color:#c678dd', '36': 'color:#56b6c2',
  '37': 'color:#abb2bf', '90': 'color:#636d83', '91': 'color:#e06c75',
  '92': 'color:#98c379', '93': 'color:#e5c07b', '94': 'color:#61afef',
  '95': 'color:#c678dd', '96': 'color:#56b6c2', '97': 'color:#ffffff',
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ansiToHtml(text) {
  const parts = esc(text).split(/\x1b\[([0-9;]*)m/);
  let html = '';
  let openSpans = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      html += parts[i];
    } else {
      const code = parts[i];
      if (code === '' || code === '0') {
        while (openSpans > 0) { html += '</span>'; openSpans--; }
      } else {
        const styles = code.split(';').map(c => ANSI_STYLES[c]).filter(Boolean);
        if (styles.length) { html += `<span style="${styles.join(';')}">`;  openSpans++; }
      }
    }
  }
  while (openSpans > 0) { html += '</span>'; openSpans--; }
  return html;
}

function renderStructuredLog(level, ts, event, extras) {
  const levelStyle = LOG_LEVEL_STYLES[level.toLowerCase()] || '';
  const tsShort = ts.length > 8 ? ts.slice(11, 19) : ts; // ISO → HH:MM:SS
  const kvs = Object.entries(extras)
    .map(([k, v]) => `<span style="color:#636d83">${esc(k)}</span>=<span style="color:#abb2bf">${esc(v)}</span>`)
    .join(' ');
  return `<span style="color:#636d83">${esc(tsShort)}</span> ` +
         `[<span style="${levelStyle}">${esc(level.toLowerCase())}</span>] ` +
         `<span style="color:#e0e0e0;font-weight:bold">${esc(event)}</span>` +
         (kvs ? ` ${kvs}` : '');
}

function formatLogLine(process, line) {
  try {
    const obj = JSON.parse(line);
    // tracing-subscriber JSON: { timestamp, level, target, fields: { message, ...} }
    if (obj.fields) {
      const { message, ...extras } = obj.fields;
      return renderStructuredLog(obj.level || 'info', obj.timestamp || '', message || '', extras);
    }
    // structlog JSON: { level, timestamp, event, ...extras }
    if (obj.event !== undefined || obj.level !== undefined) {
      const { level, timestamp, event, ...extras } = obj;
      return renderStructuredLog(level || 'info', timestamp || '', event || '', extras);
    }
  } catch (_) { /* not JSON */ }
  // Fallback: parse ANSI codes
  return ansiToHtml(line);
}

function appendLogLine(process, line) {
  const pane = document.getElementById(`log-pane-${process}`);
  if (!pane) return;

  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 20;

  const el = document.createElement('div');
  el.className = 'log-line';
  el.innerHTML = formatLogLine(process, line);
  pane.appendChild(el);

  // Trim oldest lines when over the limit
  while (pane.childElementCount > LOG_MAX_LINES) {
    pane.removeChild(pane.firstChild);
  }

  if (atBottom) pane.scrollTop = pane.scrollHeight;
}
