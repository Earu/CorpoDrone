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

/** Maps to pipeline speech_gate_* keys; “Custom” uses the three number inputs */
const SPEECH_GATE_PRESETS = {
  balanced: { rms: -50, frac: 0.12, thr: 0.5 },
  stronger: { rms: -44, frac: 0.2, thr: 0.62 },
  gentler: { rms: -56, frac: 0.07, thr: 0.35 },
};

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
    case 'file_import_error':
      if (!_ignoredProcessing) showFileImportError(msg.error || 'Unknown error');
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

  _resetPendingBar();

  // Insert into state in chronological order
  let insertIdx = state.segments.length;
  for (let i = state.segments.length - 1; i >= 0; i--) {
    if (state.segments[i].start_us <= msg.start_us) break;
    insertIdx = i;
  }
  state.segments.splice(insertIdx, 0, msg);
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

  // Insert DOM element in chronological order, keeping pending box last
  const pendingBox = document.getElementById('transcript-pending');
  const nextSeg = insertIdx < state.segments.length - 1
    ? document.getElementById(`seg-${state.segments[insertIdx + 1].id}`)
    : null;
  container.insertBefore(el, nextSeg || pendingBox || null);
  if (pendingBox) container.appendChild(pendingBox);

  setTimeout(() => el.classList.remove('new'), 500);

  if (state.autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function clearTranscript() {
  const pendingBox = document.getElementById('transcript-pending');
  state.segments = [];
  document.getElementById('transcript').innerHTML = '';
  if (pendingBox) document.getElementById('transcript').appendChild(pendingBox);
}

// ---- Debrief page ----
let _summaryText = '';
let _transcriptSegs = [];
let _pipelineActive = false;      // true while audio-capture is running
let _ignoredProcessing = false;   // true after user clicked "Ignore and continue"
let _debriefModeChosen = false;   // true once user has picked a debrief mode

function showChoiceUI() {
  document.getElementById('debrief-choice').classList.remove('hidden');
  document.getElementById('debrief-progress').classList.add('hidden');
  document.getElementById('debrief-body').innerHTML = '';
  document.getElementById('btn-copy').style.display = 'none';
  // Show live transcript immediately; re-transcribe will replace this after processing
  populateTranscriptTab(state.segments);
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
  _debriefModeChosen = true;
  document.getElementById('debrief-choice').classList.add('hidden');
  document.getElementById('debrief-progress').classList.remove('hidden');

  if (_pendingFileImportPath) {
    const path = _pendingFileImportPath;
    _pendingFileImportPath = null;
    setOverallProgress(0, 'Loading audio file…');
    try {
      await invoke('import_audio_file', { path });
    } catch (e) {
      console.error('import_audio_file failed', e);
    }
    return;
  }

  if (mode === 'retranscribe') {
    _transcriptSegs = [];
    const txEl = document.getElementById('transcript-tab-body');
    if (txEl) txEl.innerHTML = '<p class="tab-empty">Re-transcribing audio…</p>';
    const active = document.querySelector('.debrief-tab.active');
    if (active && active.id === 'transcript-tab') {
      document.getElementById('btn-copy').style.display = 'none';
    }
  }

  setOverallProgress(0, mode === 'retranscribe' ? 'Starting re-transcription…' : 'Building summary…');
  try {
    await invoke('set_pipeline_mode', { mode });
  } catch (e) {
    console.error('set_pipeline_mode failed', e);
  }
}

// ---- Ollama modal ----
let _ollamaMode = null;           // pending pipeline mode to proceed with
let _ollamaCfg = null;            // { host, model }
let _pendingFileImportPath = null; // set when file import is waiting for Ollama
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
  // Pending file import: still run Whisper transcription; debrief summary needs Ollama only.
  if (_pendingFileImportPath) {
    _proceedWithMode(_ollamaMode);
    return;
  }
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

function showFileImportError(message) {
  _clearOllamaTimers();
  closeOllamaModal();
  _pendingFileImportPath = null;
  _debriefModeChosen = false;
  _sessionEnded = false;
  _summaryText = '';
  _transcriptSegs = [];
  const txBody = document.getElementById('transcript-tab-body');
  if (txBody) txBody.innerHTML = '';
  document.getElementById('debrief-choice').classList.add('hidden');
  document.getElementById('debrief-progress').classList.add('hidden');
  document.getElementById('debrief-body').innerHTML = '';
  setOverallProgress(0, '');
  document.getElementById('btn-copy').style.display = 'none';
  const errEl = document.getElementById('file-import-error-text');
  if (errEl) errEl.textContent = message;
  document.getElementById('file-import-error-modal').classList.remove('hidden');
  showPage('landing');
}

function closeFileImportErrorModal() {
  document.getElementById('file-import-error-modal').classList.add('hidden');
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

  // If enrollment was deferred while debrief was processing, open it now
  if (_deferEnrollment && _enrollmentData && _enrollmentData.length) {
    _deferEnrollment = false;
    openEnrollmentModal();
  }
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
  document.getElementById('debrief-body').innerHTML = '';
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
  _deferEnrollment = false;
  _debriefModeChosen = false;
  _pendingFileImportPath = null;
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

function fillAudioDeviceSelect(sel, devices, preferred) {
  if (!sel) return;
  const first = document.createElement('option');
  first.value = '';
  first.textContent = 'Default (system)';
  sel.innerHTML = '';
  sel.appendChild(first);
  for (const d of devices || []) {
    const id = d.id || d.name;
    if (!id) continue;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = d.name || id;
    sel.appendChild(opt);
  }
  if (preferred && [...sel.options].some(o => o.value === preferred)) {
    sel.value = preferred;
  } else {
    sel.value = '';
  }
}

/** Repopulate mic dropdown. Pass preserved value after `get_settings` so Save doesn’t reset the pick. */
async function refreshAudioDevices(preserveIn) {
  const inSel = document.getElementById('s-audio_input_device');
  const hint = document.getElementById('audio-device-platform-hint');
  let data;
  try {
    data = await invoke('list_audio_devices');
  } catch (e) {
    console.warn('list_audio_devices failed', e);
    if (hint) {
      hint.textContent = 'Could not list devices — ensure audio-capture is built and next to the app.';
    }
    return;
  }
  const pi = preserveIn !== undefined ? preserveIn : (inSel?.value ?? '');
  fillAudioDeviceSelect(inSel, data.inputs, pi);
  if (hint) hint.textContent = '';
}

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
  set('speech_gate_enabled',        s.speech_gate_enabled !== false);
  set('speech_gate_rms_db_floor',     s.speech_gate_rms_db_floor ?? -50);
  set('speech_gate_min_speech_fraction', s.speech_gate_min_speech_fraction ?? 0.12);
  set('speech_gate_silero_threshold', s.speech_gate_silero_threshold ?? 0.5);
  const sgRms = Number(s.speech_gate_rms_db_floor ?? -50);
  const sgFrac = Number(s.speech_gate_min_speech_fraction ?? 0.12);
  const sgThr = Number(s.speech_gate_silero_threshold ?? 0.5);
  const sgPreset = inferSpeechGatePreset(sgRms, sgFrac, sgThr);
  const presetEl = document.getElementById('s-speech_gate_preset');
  if (presetEl) presetEl.value = sgPreset;
  set('diarize',                    s.diarize);
  set('hf_token',                   s.hf_token);
  set('min_speakers',               s.min_speakers);
  set('max_speakers',               s.max_speakers);
  set('speaker_enroll',             s.speaker_enroll);
  set('speaker_identify_threshold', s.speaker_identify_threshold);
  set('summarize',                  s.summarize);
  set('ollama_model',               s.ollama_model);
  set('ollama_host',                s.ollama_host);

  const savedIn = s.audio_input_device || '';
  await refreshAudioDevices(savedIn);

  // Sync dependent row visibility
  _syncSettingsDependents('speech_gate_enabled');
  _syncSettingsDependents('diarize');
  _syncSettingsDependents('speaker_enroll');
  _syncSettingsDependents('summarize');
  syncSpeechGateUi();

  showPage('settings');
}

function closeSettings() {
  showPage('landing');
}

function settingsToggle(key) {
  _syncSettingsDependents(key);
}

function inferSpeechGatePreset(rms, frac, thr) {
  const tolR = 2.5;
  const tolF = 0.035;
  const tolT = 0.09;
  for (const [name, p] of Object.entries(SPEECH_GATE_PRESETS)) {
    if (
      Math.abs(rms - p.rms) <= tolR &&
      Math.abs(frac - p.frac) <= tolF &&
      Math.abs(thr - p.thr) <= tolT
    ) {
      return name;
    }
  }
  return 'custom';
}

function applySpeechGatePreset(presetKey) {
  if (presetKey === 'custom' || !SPEECH_GATE_PRESETS[presetKey]) return;
  const p = SPEECH_GATE_PRESETS[presetKey];
  const set = (id, val) => {
    const el = document.getElementById('s-' + id);
    if (el) el.value = val;
  };
  set('speech_gate_rms_db_floor', p.rms);
  set('speech_gate_min_speech_fraction', p.frac);
  set('speech_gate_silero_threshold', p.thr);
}

function syncSpeechGateUi() {
  const enabled = document.getElementById('s-speech_gate_enabled')?.checked ?? false;
  const preset = document.getElementById('s-speech_gate_preset')?.value ?? 'balanced';
  const details = document.getElementById('speech-gate-custom-details');
  if (details) {
    const showExpert = enabled && preset === 'custom';
    details.style.display = showExpert ? '' : 'none';
    details.open = showExpert;
  }
}

function onSpeechGatePresetChange() {
  const preset = document.getElementById('s-speech_gate_preset')?.value ?? 'balanced';
  if (preset !== 'custom') applySpeechGatePreset(preset);
  syncSpeechGateUi();
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

  const sgOn = get('speech_gate_enabled');
  const sgPreset = document.getElementById('s-speech_gate_preset')?.value ?? 'balanced';
  let sgRms;
  let sgFrac;
  let sgThr;
  if (sgOn && sgPreset !== 'custom' && SPEECH_GATE_PRESETS[sgPreset]) {
    const p = SPEECH_GATE_PRESETS[sgPreset];
    sgRms = p.rms;
    sgFrac = p.frac;
    sgThr = p.thr;
  } else {
    sgRms = get('speech_gate_rms_db_floor');
    sgFrac = get('speech_gate_min_speech_fraction');
    sgThr = get('speech_gate_silero_threshold');
  }

  const settings = {
    whisper_model:               get('whisper_model'),
    whisper_device:              get('whisper_device'),
    whisper_compute_type:        get('whisper_compute_type'),
    window_seconds:              get('window_seconds'),
    step_seconds:                get('step_seconds'),
    speech_gate_enabled:         sgOn,
    speech_gate_rms_db_floor:    sgRms,
    speech_gate_min_speech_fraction: sgFrac,
    speech_gate_silero_threshold: sgThr,
    diarize:                     get('diarize'),
    hf_token:                    get('hf_token'),
    min_speakers:                Math.round(get('min_speakers')),
    max_speakers:                Math.round(get('max_speakers')),
    speaker_enroll:              get('speaker_enroll'),
    speaker_identify_threshold:  get('speaker_identify_threshold'),
    summarize:                   get('summarize'),
    ollama_model:                get('ollama_model'),
    ollama_host:                 get('ollama_host'),
    audio_input_device:          get('audio_input_device'),
  };

  try {
    await invoke('save_settings', { settings });
    try { await invoke('kill_pipeline'); } catch (_) {}
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
let _enrollmentReady = false;   // DB fetch completed and data is ready
let _sessionEnded = false;      // session_ended status received
let _deferEnrollment = false;   // enrollment arrived during active debrief processing — open after

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
  // If debrief is actively processing, defer until showDebrief() fires
  const debriefProgress = document.getElementById('debrief-progress');
  if (debriefProgress && !debriefProgress.classList.contains('hidden')) {
    _deferEnrollment = true;
    return;
  }
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
  // Only reset to choice UI if the user hasn't already picked a debrief mode
  if (!_debriefModeChosen) {
    showChoiceUI();
  }
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

// ---- App picker (macOS only — per-app ScreenCaptureKit loopback sources) ----
async function startRecording() {
  // macOS: picker when list_loopback_apps returns apps. Linux/Windows: full mix, no picker.
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
  const importBtn = document.getElementById('btn-import');
  if (importBtn) importBtn.disabled = !ready;
}

async function importAudioFile() {
  let path;
  try {
    path = await invoke('pick_audio_file');
  } catch (e) {
    console.error('pick_audio_file failed', e);
    return;
  }
  if (!path) return; // user cancelled

  _enterDebrief('Processing audio file…');
  _sessionEnded = true;

  // Reuse the same Ollama availability check as a normal debrief mode
  let ollamaCfg = null;
  try { ollamaCfg = await invoke('get_ollama_config'); } catch (e) {}

  if (ollamaCfg && ollamaCfg.summarize) {
    let status = { running: false, has_model: false };
    try { status = await invoke('check_ollama_status'); } catch (e) {}
    if (!status.running) {
      _pendingFileImportPath = path;
      openOllamaModal('retranscribe', ollamaCfg, false);
      return;
    }
    if (!status.has_model) {
      _pendingFileImportPath = path;
      openOllamaModal('retranscribe', ollamaCfg, true);
      return;
    }
  }

  // Ollama is ready — fire immediately
  _pendingFileImportPath = path;
  await _proceedWithMode('retranscribe');
}

function _resetPendingBar() {
  const bar = document.querySelector('#transcript-pending .transcript-pending-bar');
  if (!bar) return;
  bar.style.animation = 'none';
  void bar.offsetWidth;
  bar.style.animation = '';
}

function setRecordingState(recording) {
  state.recording = recording;
  const pending = document.getElementById('transcript-pending');
  if (pending) {
    pending.classList.toggle('hidden', !recording);
    if (recording) _resetPendingBar();
  }
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

// ── Setup wizard ─────────────────────────────────────────────────────────

const SETUP_STEP_META = [
  { title: 'PYTHON',       sub: 'Checking for Python 3.11 or 3.12' },
  { title: 'DEPENDENCIES', sub: 'Installing Python packages' },
  { title: 'HUGGING FACE', sub: 'Speaker diarization token (optional)' },
  { title: 'OLLAMA',       sub: 'Local LLM for meeting summaries (optional)' },
];

let _setupStep = 0;
let _setupLogUnlisten = null;

async function checkAndShowSetup() {
  try {
    const needed = await invoke('check_setup_needed');
    if (needed) {
      document.getElementById('setup-modal').classList.remove('hidden');
      await renderSetupStep(0);
    }
  } catch (e) {
    console.warn('check_setup_needed failed', e);
  }
}

function _updateSetupHeader(step) {
  _setupStep = step;
  const meta = SETUP_STEP_META[step];
  document.getElementById('setup-modal-title').textContent = meta.title;
  document.getElementById('setup-modal-sub').textContent   = meta.sub;
  document.querySelectorAll('.setup-step-pip').forEach((pip, i) => {
    pip.classList.toggle('done',   i < step);
    pip.classList.toggle('active', i === step);
  });
}

function _setSetupFooter(html) {
  document.getElementById('setup-modal-footer').innerHTML = html;
}

async function renderSetupStep(step) {
  _updateSetupHeader(step);
  const body = document.getElementById('setup-modal-body');
  switch (step) {
    case 0: await _setupStepPython(body); break;
    case 1: await _setupStepDeps(body);   break;
    case 2: await _setupStepHF(body);     break;
    case 3: await _setupStepOllama(body); break;
  }
}

// Step 0 — Python check
async function _setupStepPython(body) {
  body.innerHTML = `<div class="setup-checking"><div class="spinner"></div><span>Checking for Python 3.11 or 3.12…</span></div>`;
  _setSetupFooter('');
  try {
    const r = await invoke('check_python');
    if (r.found) {
      body.innerHTML = `
        <div class="setup-status">
          <span class="setup-icon setup-icon-ok">✓</span>
          <div>
            <div class="setup-status-title">${escHtml(r.version)}</div>
            <div class="setup-status-sub">Detected at: <code>${escHtml(r.executable)}</code></div>
          </div>
        </div>`;
      _setSetupFooter(`<button class="btn-modal-primary" onclick="renderSetupStep(1)">Next →</button>`);
    } else {
      body.innerHTML = `
        <div class="setup-status">
          <span class="setup-icon setup-icon-err">✗</span>
          <div>
            <div class="setup-status-title">Python 3.11 or 3.12 not found</div>
            <div class="setup-status-sub">
              Download and install Python from
              <a href="#" onclick="openUrl('https://www.python.org/downloads/')">python.org/downloads</a>.<br>
              During installation, make sure to check <strong>"Add Python to PATH"</strong>.<br>
              Then restart CorpoDrone and run setup again.
            </div>
          </div>
        </div>`;
      _setSetupFooter(`<button class="btn-ghost" onclick="renderSetupStep(0)">Retry</button>`);
    }
  } catch (e) {
    body.innerHTML = `<div class="setup-status"><span class="setup-icon setup-icon-err">✗</span><div class="setup-status-sub">Check failed: ${escHtml(String(e))}</div></div>`;
    _setSetupFooter(`<button class="btn-ghost" onclick="renderSetupStep(0)">Retry</button>`);
  }
}

function openUrl(url) {
  try { window.__TAURI__.shell.open(url); } catch (_) {}
}

// Step 1 — Install deps
async function _setupStepDeps(body) {
  body.innerHTML = `
    <div class="setup-install-row">
      <div class="setup-install-desc">
        This will create a Python virtual environment and install all required packages:<br>
        PyTorch, Whisper, pyannote diarization, and other pipeline dependencies.<br>
        <strong>This may take 10–30 minutes</strong> depending on your connection.
      </div>
    </div>`;
  _setSetupFooter(`<button class="btn-modal-primary" onclick="_runSetupInstall()">Install</button>`);
}

async function _runSetupInstall() {
  const body = document.getElementById('setup-modal-body');
  body.innerHTML = `
    <div class="setup-install-row">
      <div class="setup-checking"><div class="spinner"></div><span>Installing… do not close this window.</span></div>
      <div class="setup-console" id="setup-console"></div>
    </div>`;
  _setSetupFooter('');

  // Subscribe to streaming log lines
  if (_setupLogUnlisten) { _setupLogUnlisten(); _setupLogUnlisten = null; }
  _setupLogUnlisten = await window.__TAURI__.event.listen('setup-log', (event) => {
    _appendSetupLog(event.payload.line);
  });

  try {
    await invoke('run_setup');
    if (_setupLogUnlisten) { _setupLogUnlisten(); _setupLogUnlisten = null; }
    body.innerHTML = `
      <div class="setup-status">
        <span class="setup-icon setup-icon-ok">✓</span>
        <div>
          <div class="setup-status-title">Dependencies installed successfully</div>
          <div class="setup-status-sub">All Python packages are ready.</div>
        </div>
      </div>`;
    _setSetupFooter(`<button class="btn-modal-primary" onclick="renderSetupStep(2)">Next →</button>`);
  } catch (err) {
    if (_setupLogUnlisten) { _setupLogUnlisten(); _setupLogUnlisten = null; }
    const console_el = document.getElementById('setup-console');
    const logHtml = console_el ? console_el.innerHTML : '';
    body.innerHTML = `
      <div class="setup-status" style="margin-bottom:12px">
        <span class="setup-icon setup-icon-err">✗</span>
        <div>
          <div class="setup-status-title">Installation failed</div>
          <div class="setup-status-sub">${escHtml(String(err))}</div>
        </div>
      </div>
      <div class="setup-console">${logHtml}</div>`;
    _setSetupFooter(`<button class="btn-ghost" onclick="renderSetupStep(1)">Retry</button>`);
  }
}

function _appendSetupLog(line) {
  const el = document.getElementById('setup-console');
  if (!el) return;
  const span = document.createElement('span');
  span.className = 'setup-console-line' +
    (line.startsWith('===') || line.startsWith('✓') ? ' ok' : '') +
    (line.toLowerCase().includes('error') || line.toLowerCase().includes('failed') ? ' err' : '');
  span.textContent = line + '\n';
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

// Step 2 — HuggingFace token
async function _setupStepHF(body) {
  // Pre-fill if token already set
  let existingToken = '';
  try {
    const s = await invoke('get_settings');
    if (s.hf_token && s.hf_token.startsWith('hf_')) existingToken = s.hf_token;
  } catch (_) {}

  if (existingToken) {
    body.innerHTML = `
      <div class="setup-status">
        <span class="setup-icon setup-icon-ok">✓</span>
        <div>
          <div class="setup-status-title">Token already configured</div>
          <div class="setup-status-sub">Your HuggingFace token is saved. Speaker diarization is enabled.</div>
        </div>
      </div>`;
    _setSetupFooter(`<button class="btn-ghost" onclick="renderSetupStep(3)">Skip</button><button class="btn-modal-primary" onclick="renderSetupStep(3)">Next →</button>`);
    return;
  }

  body.innerHTML = `
    <div class="setup-status" style="margin-bottom:14px">
      <span class="setup-icon setup-icon-warn">⚠</span>
      <div>
        <div class="setup-status-title">HuggingFace token required for diarization</div>
        <div class="setup-status-sub">Speaker identification requires a free HuggingFace account and token. You can skip this and add it later in Settings.</div>
      </div>
    </div>
    <div class="setup-token-input-group">
      <ul class="setup-steps-list">
        <li>Create a free account at <a href="#" onclick="openUrl('https://huggingface.co')">huggingface.co</a></li>
        <li>Accept model terms at <a href="#" onclick="openUrl('https://huggingface.co/pyannote/speaker-diarization-3.1')">pyannote/speaker-diarization-3.1</a></li>
        <li>Generate a token at <a href="#" onclick="openUrl('https://huggingface.co/settings/tokens')">huggingface.co/settings/tokens</a></li>
      </ul>
      <input class="setup-token-input" id="setup-hf-input" type="password" placeholder="hf_…" autocomplete="off">
    </div>`;
  _setSetupFooter(`
    <button class="btn-ghost" onclick="renderSetupStep(3)">Skip</button>
    <button class="btn-modal-primary" onclick="_saveSetupHFToken()">Save &amp; Next →</button>`);
}

async function _saveSetupHFToken() {
  const input = document.getElementById('setup-hf-input');
  const token = input ? input.value.trim() : '';
  if (!token.startsWith('hf_')) {
    input.style.borderColor = 'var(--danger)';
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
    return;
  }
  try {
    await invoke('save_hf_token', { token });
  } catch (e) {
    console.warn('save_hf_token failed', e);
  }
  await renderSetupStep(3);
}

// Step 3 — Ollama
async function _setupStepOllama(body) {
  body.innerHTML = `<div class="setup-checking"><div class="spinner"></div><span>Checking for Ollama…</span></div>`;
  _setSetupFooter('');
  try {
    const r = await invoke('check_ollama_installed');
    if (r.installed) {
      body.innerHTML = `
        <div class="setup-status">
          <span class="setup-icon setup-icon-ok">✓</span>
          <div>
            <div class="setup-status-title">Ollama detected</div>
            <div class="setup-status-sub">${escHtml(r.version) || 'Ollama is installed.'} Meeting summaries will be available.</div>
          </div>
        </div>`;
    } else {
      body.innerHTML = `
        <div class="setup-status">
          <span class="setup-icon setup-icon-warn">⚠</span>
          <div>
            <div class="setup-status-title">Ollama not found</div>
            <div class="setup-status-sub">
              Ollama powers the AI meeting debrief summaries. You can install it later — transcription and diarization work without it.<br><br>
              Download from <a href="#" onclick="openUrl('https://ollama.com')">ollama.com</a>, then pull a model:<br>
              <code>ollama pull mistral</code>
            </div>
          </div>
        </div>`;
    }
  } catch (e) {
    body.innerHTML = `<div class="setup-status"><span class="setup-icon setup-icon-warn">⚠</span><div class="setup-status-sub">Could not check Ollama: ${escHtml(String(e))}</div></div>`;
  }
  _setSetupFooter(`<button class="btn-modal-primary" onclick="_finishSetup()">Finish Setup</button>`);
}

async function _finishSetup() {
  document.getElementById('setup-modal').classList.add('hidden');
  // Start the Python pipeline now that setup is complete
  try {
    await invoke('launch_pipeline');
  } catch (e) {
    console.warn('launch_pipeline failed', e);
  }
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
  checkAndShowSetup();
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
