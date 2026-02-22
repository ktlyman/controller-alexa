/* ==========================================================================
   Alexa Controller — Frontend Application
   ========================================================================== */

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

async function api(action) {
  const res = await fetch('/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  devices: [],
  deviceStates: {},
  routines: [],
  liveEvents: [],
  pushStatus: { connected: false, state: 'disconnected', eventCount: 0 },
  cookieStatus: { hasCookie: false },
  livePaused: false,
  liveEventCount: 0,
  autoPoll: { enabled: false, intervalMinutes: 10 },
  // Logs pagination
  eventsNextCursor: null,
  eventsPrevCursors: [],
  activityNextToken: null,
  activityPrevTokens: [],
  pushEventsOffset: 0,
  // Custom device grouping (localStorage-backed)
  customGroups: { groups: [], assignments: {} },
  editMode: false,
  selectedDeviceIds: new Set(),
};

// ---------------------------------------------------------------------------
// Custom Groups (localStorage persistence)
// ---------------------------------------------------------------------------

const CUSTOM_GROUPS_KEY = 'alexa-controller-custom-groups';

function loadCustomGroups() {
  try {
    const stored = localStorage.getItem(CUSTOM_GROUPS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      state.customGroups = {
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        assignments: (parsed.assignments && typeof parsed.assignments === 'object') ? parsed.assignments : {},
      };
    }
  } catch (e) {
    console.warn('Failed to load custom groups:', e);
  }
}

function saveCustomGroups() {
  try {
    localStorage.setItem(CUSTOM_GROUPS_KEY, JSON.stringify(state.customGroups));
  } catch (e) {
    console.warn('Failed to save custom groups:', e);
  }
}

/** Get the effective group for a device (custom assignment > API group > null). */
function getEffectiveGroup(device) {
  const custom = state.customGroups.assignments[device.id];
  if (custom) return custom;
  return (device.groups || [])[0] || null;
}

function addCustomGroup(name) {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (state.customGroups.groups.includes(trimmed)) {
    showToast('Room already exists', 'error');
    return false;
  }
  state.customGroups.groups.push(trimmed);
  saveCustomGroups();
  return true;
}

function deleteCustomGroup(name) {
  state.customGroups.groups = state.customGroups.groups.filter(g => g !== name);
  for (const deviceId of Object.keys(state.customGroups.assignments)) {
    if (state.customGroups.assignments[deviceId] === name) {
      delete state.customGroups.assignments[deviceId];
    }
  }
  saveCustomGroups();
}

function assignDevicesToGroup(deviceIds, groupName) {
  for (const id of deviceIds) {
    if (groupName === null) {
      delete state.customGroups.assignments[id];
    } else {
      state.customGroups.assignments[id] = groupName;
    }
  }
  saveCustomGroups();
}

// ---------------------------------------------------------------------------
// Edit Mode
// ---------------------------------------------------------------------------

function toggleEditMode() {
  state.editMode = !state.editMode;
  state.selectedDeviceIds.clear();

  const btn = document.getElementById('device-edit-btn');
  if (state.editMode) {
    btn.textContent = 'Done';
    btn.className = 'btn btn-success';
    document.getElementById('tab-devices').classList.add('edit-mode');
  } else {
    btn.textContent = '\u270F\uFE0F Edit';
    btn.className = 'btn btn-secondary';
    document.getElementById('tab-devices').classList.remove('edit-mode');
  }

  renderDeviceGrid();
}

function toggleDeviceSelection(deviceId, event) {
  if (event) event.stopPropagation();
  if (state.selectedDeviceIds.has(deviceId)) {
    state.selectedDeviceIds.delete(deviceId);
  } else {
    state.selectedDeviceIds.add(deviceId);
  }
  // Update just the visual state of the card — no full re-render needed
  const card = document.querySelector('[data-device-id="' + deviceId + '"]');
  if (card) {
    card.classList.toggle('device-selected', state.selectedDeviceIds.has(deviceId));
    const cb = card.querySelector('.device-select-checkbox');
    if (cb) cb.checked = state.selectedDeviceIds.has(deviceId);
  }
  // Update the selection count in the edit toolbar
  updateSelectionCount();
}

function updateSelectionCount() {
  const el = document.getElementById('selection-actions');
  if (!el) return;
  if (state.selectedDeviceIds.size > 0) {
    el.innerHTML = '<span class="text-muted">' + state.selectedDeviceIds.size + ' selected</span>'
      + '<button class="btn btn-sm btn-secondary" onclick="state.selectedDeviceIds.clear(); renderDeviceGrid();">Clear</button>';
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Drag & Drop for Device Grouping
// ---------------------------------------------------------------------------

function onDeviceDragStart(event, deviceId) {
  // If dragging a selected device, drag all selected; otherwise drag just this one
  const draggedIds = state.selectedDeviceIds.has(deviceId)
    ? [...state.selectedDeviceIds]
    : [deviceId];

  event.dataTransfer.setData('application/x-device-ids', JSON.stringify(draggedIds));
  event.dataTransfer.effectAllowed = 'move';

  // Set a drag image count badge if multiple
  if (draggedIds.length > 1) {
    const badge = document.createElement('div');
    badge.className = 'drag-badge';
    badge.textContent = draggedIds.length + ' devices';
    badge.style.cssText = 'position:fixed;top:-100px;left:-100px;background:var(--accent);color:#000;padding:4px 12px;border-radius:12px;font-size:0.85rem;font-weight:600;';
    document.body.appendChild(badge);
    event.dataTransfer.setDragImage(badge, 40, 16);
    setTimeout(() => badge.remove(), 0);
  }

  // Highlight all drop targets
  requestAnimationFrame(() => {
    document.querySelectorAll('.device-group-section.drop-target').forEach(el => {
      el.classList.add('drag-active');
    });
  });
}

function onGroupDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drag-over');
}

function onGroupDragLeave(event) {
  const section = event.currentTarget;
  if (!section.contains(event.relatedTarget)) {
    section.classList.remove('drag-over');
  }
}

function onGroupDrop(event, groupName) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over');
  document.querySelectorAll('.drag-active').forEach(el => el.classList.remove('drag-active'));

  try {
    const deviceIds = JSON.parse(event.dataTransfer.getData('application/x-device-ids'));
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) return;

    assignDevicesToGroup(deviceIds, groupName);
    state.selectedDeviceIds.clear();
    renderDeviceGrid();
    populateGroupFilter();

    const count = deviceIds.length;
    const target = groupName || 'Ungrouped';
    showToast('Moved ' + count + ' device' + (count > 1 ? 's' : '') + ' to ' + target, 'success');
  } catch (e) {
    console.warn('Drop failed:', e);
  }
}

// Clean up highlights on cancelled drops
document.addEventListener('dragend', () => {
  document.querySelectorAll('.drag-active, .drag-over').forEach(el => {
    el.classList.remove('drag-active', 'drag-over');
  });
});

// ---------------------------------------------------------------------------
// Group Management
// ---------------------------------------------------------------------------

function handleAddGroup() {
  const input = document.getElementById('new-group-name');
  if (!input) return;
  const name = input.value.trim();
  if (addCustomGroup(name)) {
    input.value = '';
    renderDeviceGrid();
    populateGroupFilter();
    showToast('Created room "' + name + '"', 'success');
  }
}

function handleDeleteGroup(groupName) {
  if (!confirm('Delete room "' + groupName + '"? Devices will become ungrouped.')) return;
  deleteCustomGroup(groupName);
  renderDeviceGrid();
  populateGroupFilter();
  showToast('Deleted room "' + groupName + '"', 'info');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(isoString) {
  if (!isoString) return 'Never';
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 0) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function formatDateTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Format a capability state value for display in the raw state table.
 *  Handles nested objects, stringified JSON, and simple scalars. */
function formatStateValue(value) {
  if (value === null || value === undefined) return '<span class="text-muted">null</span>';

  // If it's a string that looks like JSON, try to parse it first
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        return escapeHtml(value);
      }
    } else {
      return escapeHtml(value);
    }
  }

  // Simple scalars
  if (typeof value === 'boolean') return `<span class="state-value-bool">${value}</span>`;
  if (typeof value === 'number') return `<span class="state-value-num">${value}</span>`;

  // Objects — render as a key-value mini-table
  if (typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    // Simple single-value wrapper like {"value": "OK"} — unwrap it
    if (entries.length === 1 && typeof entries[0][1] !== 'object') {
      return escapeHtml(String(entries[0][1]));
    }
    // Render as key-value pairs
    return `<div class="state-value-obj">${entries.map(([k, v]) => {
      const vStr = (v && typeof v === 'object') ? JSON.stringify(v) : String(v ?? '');
      return `<div class="state-kv"><span class="state-kv-key">${escapeHtml(k)}:</span> <span class="state-kv-val">${escapeHtml(vStr)}</span></div>`;
    }).join('')}</div>`;
  }

  // Arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="text-muted">[]</span>';
    return escapeHtml(JSON.stringify(value));
  }

  return escapeHtml(String(value));
}

/** Convert a temperature value to Fahrenheit for display.
 *  If already in Fahrenheit, returns as-is. */
function toFahrenheit(tempObj) {
  if (!tempObj || tempObj.value === undefined) return tempObj;
  if (tempObj.scale === 'FAHRENHEIT') return tempObj;
  if (tempObj.scale === 'CELSIUS') {
    return { value: Math.round(tempObj.value * 9 / 5 + 32), scale: 'FAHRENHEIT' };
  }
  // KELVIN
  return { value: Math.round((tempObj.value - 273.15) * 9 / 5 + 32), scale: 'FAHRENHEIT' };
}

/** Format a temperature value for display, always in Fahrenheit. */
function formatTemp(tempObj) {
  const f = toFahrenheit(tempObj);
  return `${f.value}\u00B0F`;
}

/** Format timeOfSample as a short freshness label (e.g., "2m ago", "1h ago"). */
function formatSampleAge(timeOfSample) {
  if (!timeOfSample) return '';
  const seconds = Math.floor((Date.now() - new Date(timeOfSample).getTime()) / 1000);
  if (seconds < 0 || seconds > 86400 * 7) return ''; // invalid or too old
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Get the freshest timeOfSample from all capabilities in a snapshot. */
function getSnapshotFreshness(snapshot) {
  if (!snapshot || !snapshot.capabilities) return '';
  let newest = '';
  for (const cap of snapshot.capabilities) {
    if (cap.timeOfSample && cap.timeOfSample > newest) {
      newest = cap.timeOfSample;
    }
  }
  return newest;
}

function formatPayload(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

const ALEXA_LOGO_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg">'
  + '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c1.73 0 3.36-.44 4.78-1.22l.02-.01'
  + 'c.38-.21.52-.7.3-1.08a.806.806 0 0 0-1.06-.29c-1.18.64-2.52 1-3.94 1.01'
  + '-4.89.04-9.01-3.73-9.56-8.59C2.01 7.36 5.7 3.44 10.24 3.02'
  + 'c4.3-.4 8.1 2.52 9.14 6.52.52 2-.02 3.5-.76 3.97-.52.33-1.14.2-1.3-.45'
  + '-.05-.2-.08-.4-.08-.6V7.65a.8.8 0 0 0-.86-.79c-.4.03-.74.36-.74.76v.46'
  + 'A5.5 5.5 0 0 0 12 6.5a5.5 5.5 0 1 0 4.4 8.8c.42.76 1.18 1.2 2.02 1.2'
  + '.5 0 1-.16 1.48-.48 1.14-.76 1.83-2.3 1.72-4.04C21.26 7.02 17.12 2.76 12 2z'
  + 'M12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" fill="#31d8f5"/></svg>';

function deviceIcon(deviceType) {
  // Alexa hardware devices (Echo, Echo Show, Echo Flex, etc.) get the Alexa logo.
  // These are the device *family* values from the Echo REST API, not the display
  // categories — so 'ECHO' here means an actual Echo, not eero/FireTV/etc.
  const alexaDeviceFamilies = ['ECHO', 'KNIGHT', 'ROOK'];
  if (alexaDeviceFamilies.includes(deviceType?.toUpperCase())) {
    return ALEXA_LOGO_SVG;
  }

  const icons = {
    'LIGHT': '\u{1F4A1}',
    'SMARTPLUG': '\u{1F50C}',
    'THERMOSTAT': '\u{1F321}\uFE0F',
    'SMARTLOCK': '\u{1F512}',
    'CAMERA': '\u{1F4F7}',
    'SWITCH': '\u{1F4AB}',
    'FAN': '\u{1F32C}\uFE0F',
    'CONTACT_SENSOR': '\u{1F6AA}',
    'MOTION_SENSOR': '\u{1F440}',
    'TEMPERATURE_SENSOR': '\u{1F321}\uFE0F',
    'DOORBELL': '\u{1F514}',
    'HUB': '\u{1F310}',
    'SPEAKER': '\u{1F50A}',
    'TV': '\u{1F4FA}',
    'SCREEN': '\u{1F4FA}',
    'TABLET': '\u{1F4F1}',
    'FIRE_TV': '\u{1F4FA}',
    'EERO': '\u{1F4F6}',
    'SPENCER': '\u{1F373}',
    'ZEPHYR': '\u{1F576}\uFE0F',
    'PRINTER': '\u{1F5A8}\uFE0F',
    'REMOTE': '\u{1F579}\uFE0F',
    'SECURITY_PANEL': '\u{1F6E1}\uFE0F',
    'VACUUM_CLEANER': '\u{1F9F9}',
    'AIR_QUALITY_MONITOR': '\u{1F32B}\uFE0F',
    'WATER_LEAK_SENSOR': '\u{1F4A7}',
  };
  return icons[deviceType?.toUpperCase()] || '\u{1F4E6}';
}

function getTimeRange(range) {
  const now = Date.now();
  switch (range) {
    case '1h': return new Date(now - 3600000).toISOString();
    case '24h': return new Date(now - 86400000).toISOString();
    case '7d': return new Date(now - 604800000).toISOString();
    case '30d': return new Date(now - 2592000000).toISOString();
    case 'all': return undefined;
    default: return undefined;
  }
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const TABS = ['devices', 'routines', 'logs', 'live'];
let currentTab = 'devices';
let tabInitialized = {};

function navigateTab(tab) {
  if (!TABS.includes(tab)) tab = 'devices';

  // Update nav
  document.querySelectorAll('.tab-link').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });

  // Update panels
  document.querySelectorAll('.tab-panel').forEach(el => {
    el.classList.toggle('active', el.id === `tab-${tab}`);
  });

  currentTab = tab;

  // Initialize tab data on first visit
  if (!tabInitialized[tab]) {
    tabInitialized[tab] = true;
    switch (tab) {
      case 'devices': loadDevices(); break;
      case 'routines': loadRoutines(); break;
      case 'logs': loadEvents(); break;
      case 'live': break; // SSE handles this
    }
  }
}

window.addEventListener('hashchange', () => {
  navigateTab(window.location.hash.slice(1) || 'devices');
});

// ---------------------------------------------------------------------------
// SSE Manager
// ---------------------------------------------------------------------------

let eventSource = null;

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/events/stream');
  const sseStatus = document.getElementById('live-sse-status');

  eventSource.onopen = () => {
    if (sseStatus) {
      sseStatus.textContent = 'SSE: connected';
      sseStatus.className = 'sse-status connected';
    }
  };

  eventSource.addEventListener('event', (e) => {
    try {
      const event = JSON.parse(e.data);
      handleSSEEvent(event);
    } catch {}
  });

  eventSource.addEventListener('push-status', (e) => {
    try {
      state.pushStatus = JSON.parse(e.data);
      updatePushStatusBadge();
    } catch {}
  });

  eventSource.addEventListener('auto-poll', (e) => {
    try {
      const data = JSON.parse(e.data);
      // Re-fetch cached states to update the UI
      api({ type: 'get_cached_states' }).then(cached => {
        if (cached.success && cached.data.states) {
          for (const snap of cached.data.states) {
            state.deviceStates[snap.deviceId] = snap;
          }
          renderDeviceGrid();
        }
      });
    } catch {}
  });

  eventSource.onerror = () => {
    if (sseStatus) {
      sseStatus.textContent = 'SSE: reconnecting...';
      sseStatus.className = 'sse-status';
    }
  };
}

function handleSSEEvent(event) {
  // Check if it's a push-related event
  const isPushEvent = event.tags && event.tags.includes('push_event');
  const isStateChange = event.eventType === 'PushListenerStateChange';

  if (isPushEvent || isStateChange) {
    state.liveEventCount++;

    // Update badge
    if (currentTab !== 'live') {
      const badge = document.getElementById('live-count');
      if (badge) {
        badge.textContent = state.liveEventCount;
        badge.classList.remove('hidden');
      }
    }

    // Add to live feed
    if (!state.livePaused) {
      addLiveEvent(event);
    }
    state.liveEvents.unshift(event);
    if (state.liveEvents.length > 500) state.liveEvents.length = 500;
  }
}

// ---------------------------------------------------------------------------
// Status Indicators
// ---------------------------------------------------------------------------

async function checkCookieStatus() {
  try {
    const res = await fetch('/cookie-status');
    state.cookieStatus = await res.json();
  } catch {
    state.cookieStatus = { hasCookie: false };
  }
  updateCookieStatusBadge();
}

function updateCookieStatusBadge() {
  const el = document.getElementById('cookie-status');
  if (!el) return;
  const text = el.querySelector('.status-text');
  if (state.cookieStatus.hasCookie) {
    el.className = 'status-badge ok';
    text.textContent = 'Cookie Active';
    el.title = 'Alexa cookie is configured and valid';
  } else {
    el.className = 'status-badge warn';
    text.textContent = 'No Cookie';
    el.title = 'No cookie — go to /extract-cookie to set up';
  }
}

async function checkPushStatus() {
  try {
    const res = await fetch('/push-status');
    state.pushStatus = await res.json();
  } catch {
    state.pushStatus = { connected: false, state: 'disconnected', eventCount: 0 };
  }
  updatePushStatusBadge();
}

function updatePushStatusBadge() {
  const el = document.getElementById('push-status');
  if (!el) return;
  const text = el.querySelector('.status-text');
  if (state.pushStatus.connected) {
    el.className = 'status-badge connected';
    text.textContent = `Push: ${state.pushStatus.eventCount || 0}`;
    el.title = `Push listener connected (${state.pushStatus.state}). Events: ${state.pushStatus.eventCount}`;
  } else {
    el.className = 'status-badge';
    text.textContent = 'Push Off';
    el.title = `Push listener: ${state.pushStatus.state || 'disconnected'}`;
  }

  // Update the connect/disconnect button on Live tab
  const btn = document.getElementById('push-toggle-btn');
  if (btn) {
    if (state.pushStatus.connected) {
      btn.textContent = '\u{1F50C} Disconnect Listener';
      btn.className = 'btn btn-danger';
    } else {
      btn.textContent = '\u{1F50C} Connect Listener';
      btn.className = 'btn btn-primary';
    }
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Devices Tab
// ---------------------------------------------------------------------------

async function loadDevices() {
  const grid = document.getElementById('device-grid');
  grid.innerHTML = '<div class="loading-placeholder"><span class="loading-spinner"></span> Loading devices...</div>';

  const result = await api({ type: 'list_all_devices', source: 'all' });
  if (!result.success) {
    grid.innerHTML = `<div class="empty-state"><p>Failed to load devices</p><p class="text-muted">${escapeHtml(result.error)}</p></div>`;
    return;
  }

  state.devices = result.data.devices || [];
  loadCustomGroups();
  populateDeviceTypeFilter();
  renderDeviceGrid();

  document.getElementById('device-count').textContent = `${state.devices.length} devices`;

  // Refresh cookie status (cookie may have been lazily loaded from SQLite)
  checkCookieStatus();

  // Immediately fetch cached states from SQLite and render them —
  // this gives instant state display without waiting for a fresh poll.
  try {
    const cached = await api({ type: 'get_cached_states' });
    if (cached.success && cached.data.states && cached.data.states.length > 0) {
      for (const snap of cached.data.states) {
        state.deviceStates[snap.deviceId] = snap;
      }
      renderDeviceGrid();
      const age = cached.data.cachedAt ? formatAge(cached.data.cachedAt) : '';
      showToast(`Loaded ${cached.data.stateCount} cached states${age ? ' (' + age + ' old)' : ''}`, 'success');
    }
  } catch (e) {
    // Non-fatal — cached states are a nice-to-have
    console.warn('Failed to load cached states:', e);
  }

  // Then poll fresh states in the background and update the grid when done
  pollStatesInBackground();
}

/** Poll all device states in the background without blocking the UI. */
async function pollStatesInBackground() {
  const btn = document.getElementById('device-poll-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '\u{1F50D} Polling...';
  }

  try {
    const result = await api({ type: 'poll_all_states' });
    if (result.success && result.data.states) {
      for (const snap of result.data.states) {
        state.deviceStates[snap.deviceId] = snap;
      }
      renderDeviceGrid();
      const errCount = result.data.errorCount;
      const successCount = result.data.polledCount - errCount;
      const msg = errCount > 0
        ? `${successCount} devices polled, ${errCount} unreachable`
        : `${result.data.polledCount} devices polled`;
      showToast(msg, errCount > successCount ? 'error' : 'success');
    }
  } catch (e) {
    // Rate-limited or network error — not critical since we already have cached states
    console.warn('Background poll failed:', e);
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = '\u{1F50D} Poll States';
  }
}

/** Check auto-poll status from the server and update the UI. */
async function checkAutoPollStatus() {
  try {
    const res = await fetch('/auto-poll');
    const data = await res.json();
    state.autoPoll = { enabled: data.enabled, intervalMinutes: data.intervalMinutes || 10 };
    updateAutoPollUI();
  } catch (e) {
    console.warn('Failed to check auto-poll status:', e);
  }
}

/** Toggle auto-poll on/off. */
async function toggleAutoPoll() {
  try {
    const res = await fetch('/auto-poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: !state.autoPoll.enabled,
        intervalMinutes: state.autoPoll.intervalMinutes,
      }),
    });
    const data = await res.json();
    state.autoPoll = { enabled: data.enabled, intervalMinutes: data.intervalMinutes || 10 };
    updateAutoPollUI();
    showToast(state.autoPoll.enabled
      ? `Auto-poll enabled (every ${state.autoPoll.intervalMinutes}m)`
      : 'Auto-poll disabled', 'success');
  } catch (e) {
    showToast('Failed to toggle auto-poll', 'error');
  }
}

/** Update the auto-poll button appearance. */
function updateAutoPollUI() {
  const btn = document.getElementById('auto-poll-btn');
  if (!btn) return;
  if (state.autoPoll.enabled) {
    btn.textContent = `\u{23F1}\uFE0F ${state.autoPoll.intervalMinutes}m`;
    btn.className = 'btn btn-sm btn-success';
    btn.title = `Auto-polling every ${state.autoPoll.intervalMinutes} minutes (click to disable)`;
  } else {
    btn.textContent = '\u{23F1}\uFE0F Auto';
    btn.className = 'btn btn-sm btn-secondary';
    btn.title = 'Auto-poll disabled (click to enable)';
  }
}

/** Format an ISO timestamp as a human-readable age string (e.g. "3m ago", "2h ago"). */
function formatAge(isoTimestamp) {
  const seconds = Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function populateDeviceTypeFilter() {
  const types = [...new Set(state.devices.map(d => d.deviceType).filter(Boolean))].sort();
  const select = document.getElementById('device-type-filter');
  select.innerHTML = '<option value="">All Types</option>';
  types.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    select.appendChild(opt);
  });

  populateGroupFilter();
}

function populateGroupFilter() {
  const groups = new Set();
  // API groups
  state.devices.forEach(d => (d.groups || []).forEach(g => groups.add(g)));
  // Custom groups
  state.customGroups.groups.forEach(g => groups.add(g));

  const groupList = [...groups].sort();
  const groupSelect = document.getElementById('device-group-filter');
  const current = groupSelect.value;
  groupSelect.innerHTML = '<option value="">All Rooms</option>';
  groupList.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    if (g === current) opt.selected = true;
    groupSelect.appendChild(opt);
  });
}

function getFilteredDevices() {
  const search = document.getElementById('device-search').value.toLowerCase();
  const source = document.getElementById('device-source-filter').value;
  const type = document.getElementById('device-type-filter').value;
  const group = document.getElementById('device-group-filter').value;

  return state.devices.filter(d => {
    if (search && !d.name.toLowerCase().includes(search) && !d.id.toLowerCase().includes(search)) return false;
    if (source !== 'all' && d.source !== source) return false;
    if (type && d.deviceType !== type) return false;
    if (group && getEffectiveGroup(d) !== group) return false;
    return true;
  }).sort((a, b) => {
    // Unavailable devices (unreachable, offline, disabled) sort to the end
    const aUnavail = isDeviceUnavailable(a) ? 1 : 0;
    const bUnavail = isDeviceUnavailable(b) ? 1 : 0;
    if (aUnavail !== bUnavail) return aUnavail - bUnavail;
    // Then prioritize devices with controls (Echo devices, lights, plugs, speakers)
    const hasControls = (d) => {
      if (d.source === 'echo') return true;
      const caps = (d.capabilities || []).join(' ');
      return caps.includes('Power') || caps.includes('TurnOn') || caps.includes('Brightness')
        || caps.includes('Color') || caps.includes('Volume') || caps.includes('Speaker');
    };
    const aCtrl = hasControls(a) ? 0 : 1;
    const bCtrl = hasControls(b) ? 0 : 1;
    if (aCtrl !== bCtrl) return aCtrl - bCtrl;
    // Then by device type, then by name
    const typeCompare = (a.deviceType || '').localeCompare(b.deviceType || '');
    if (typeCompare !== 0) return typeCompare;
    return (a.name || '').localeCompare(b.name || '');
  });
}

/** Check if a device is unavailable (unreachable, offline, or disabled) based on polled state. */
function isDeviceUnavailable(d) {
  const snapshot = state.deviceStates[d.applianceId || d.id];
  if (!snapshot) return !d.online;
  if (snapshot.error) {
    return snapshot.error.includes('UNREACHABLE') || snapshot.error.includes('Disabled');
  }
  const conn = (snapshot.capabilities || []).find(c => c.namespace === 'Alexa.EndpointHealth' && c.name === 'connectivity');
  if (conn && conn.value) {
    const val = conn.value.value ?? conn.value;
    return val !== 'OK';
  }
  return !d.online;
}

function renderDeviceCard(d) {
  const snapshot = state.deviceStates[d.applianceId || d.id];

  // Determine online status: polled connectivity overrides the discovery-time flag
  const isOnline = !isDeviceUnavailable(d);

  const isSelected = state.selectedDeviceIds.has(d.id);
  const editCheckbox = state.editMode
    ? `<label class="device-select-overlay" onclick="event.stopPropagation()">
         <input type="checkbox" class="device-select-checkbox" ${isSelected ? 'checked' : ''}
           onchange="toggleDeviceSelection('${escapeHtml(d.id)}', event)">
       </label>`
    : '';

  const clickHandler = state.editMode
    ? `onclick="toggleDeviceSelection('${escapeHtml(d.id)}', event)"`
    : `onclick="openDeviceModal('${escapeHtml(d.id)}')"`;

  const dragAttrs = state.editMode
    ? `draggable="true" ondragstart="onDeviceDragStart(event, '${escapeHtml(d.id)}')"`
    : '';

  // Build inline controls and sensor data for the card
  const cardBody = renderCardBody(d, snapshot);

  return `<div class="device-card${!isOnline ? ' device-offline' : ''}${isSelected ? ' device-selected' : ''}"
    data-device-id="${escapeHtml(d.id)}" ${clickHandler} ${dragAttrs}>
    ${editCheckbox}
    <div class="device-card-header">
      <span class="device-icon">${deviceIcon(d.deviceType)}</span>
      <div style="flex:1;min-width:0">
        <div class="device-name"><span class="online-dot ${isOnline ? 'online' : 'offline'}" title="${isOnline ? 'Online' : 'Offline / Unreachable'}"></span> ${escapeHtml(d.name)}</div>
        <div class="device-meta">
          ${d.deviceType ? `<span class="device-type-badge">${escapeHtml(d.deviceType)}</span>` : ''}
        </div>
      </div>
    </div>
    ${cardBody}
  </div>`;
}

/** Map a RangeController instance name to a display icon, label, and unit. */
function rangeInstanceInfo(instLower, instRaw, friendlyName) {
  // First check the semantic friendlyName from discovery (Alexa asset IDs or text)
  // This is the most reliable since instance strings can be opaque numeric IDs
  if (friendlyName) {
    const fn = friendlyName.toLowerCase();
    if (fn.includes('humidity')) return { icon: '\u{1F4A7}', label: 'Humidity', unit: '%' };
    if (fn.includes('particulatematter') || fn.includes('particulate_matter') || fn.includes('particulate matter')) {
      // Distinguish PM2.5 from PM10 by checking semantics or unit
      if (fn.includes('pm10') || fn.includes('pm_10')) return { icon: '\u{1F32B}\uFE0F', label: 'PM10', unit: ' \u00B5g/m\u00B3' };
      return { icon: '\u{1F32B}\uFE0F', label: 'PM2.5', unit: ' \u00B5g/m\u00B3' };
    }
    if (fn.includes('pm10') || fn.includes('pm_10')) return { icon: '\u{1F32B}\uFE0F', label: 'PM10', unit: ' \u00B5g/m\u00B3' };
    if (fn.includes('pm2') || fn.includes('pm25') || fn.includes('pm_2')) return { icon: '\u{1F32B}\uFE0F', label: 'PM2.5', unit: ' \u00B5g/m\u00B3' };
    if (fn.includes('volatileorganiccompounds') || fn.includes('volatile_organic') || fn.includes('voc'))
      return { icon: '\u{1F343}', label: 'VOC', unit: ' idx' };
    if (fn.includes('carbondioxide') || fn.includes('carbon_dioxide') || fn.includes('co2'))
      return { icon: '\u{2601}\uFE0F', label: 'CO\u2082', unit: ' ppm' };
    if (fn.includes('carbonmonoxide') || fn.includes('carbon_monoxide'))
      return { icon: '\u{26A0}\uFE0F', label: 'CO', unit: ' ppm' };
    if (fn.includes('indoorairquality') || fn.includes('indoor_air_quality') || fn.includes('airquality') || fn.includes('air_quality') || fn.includes('iaq'))
      return { icon: '\u{1F3AF}', label: 'IAQ', unit: '' };
    if (fn.includes('temperature') || fn.includes('temp'))
      return { icon: '\u{1F321}\uFE0F', label: 'Temp', unit: '\u00B0' };
  }

  // Fall back to matching the instance string directly (for devices with descriptive instance names)
  if (instLower.includes('humidity')) return { icon: '\u{1F4A7}', label: 'Humidity', unit: '%' };
  if (instLower.includes('pm2') || instLower.includes('pm25') || instLower === 'pm2.5')
    return { icon: '\u{1F32B}\uFE0F', label: 'PM2.5', unit: ' \u00B5g/m\u00B3' };
  if (instLower.includes('pm10'))
    return { icon: '\u{1F32B}\uFE0F', label: 'PM10', unit: ' \u00B5g/m\u00B3' };
  if (instLower.includes('pm') || instLower.includes('particulate'))
    return { icon: '\u{1F32B}\uFE0F', label: 'PM', unit: ' \u00B5g/m\u00B3' };
  if (instLower.includes('voc'))
    return { icon: '\u{1F343}', label: 'VOC', unit: ' idx' };
  if (instLower.includes('co2') || instLower.includes('carbondioxide'))
    return { icon: '\u{2601}\uFE0F', label: 'CO\u2082', unit: ' ppm' };
  if (instLower.includes('co') || instLower.includes('carbonmonoxide'))
    return { icon: '\u{26A0}\uFE0F', label: 'CO', unit: ' ppm' };
  if (instLower.includes('iaq') || instLower.includes('airquality') || instLower.includes('air.quality'))
    return { icon: '\u{1F3AF}', label: 'IAQ', unit: '' };
  if (instLower.includes('temperature') || instLower.includes('temp'))
    return { icon: '\u{1F321}\uFE0F', label: 'Temp', unit: '\u00B0' };
  // Fallback: clean up instance name
  const label = instRaw.replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return { icon: '\u{1F4CA}', label, unit: '' };
}

/** Build the body of a device card: inline controls for actionable devices, prominent data for sensors. */
function renderCardBody(d, snapshot) {
  if (!snapshot) return '';
  if (snapshot.error) {
    return `<div class="device-state-summary"><span class="state-unreachable">${escapeHtml(friendlyError(snapshot.error))}</span></div>`;
  }

  const caps = snapshot.capabilities || [];
  if (caps.length === 0) return '';

  const dId = escapeHtml(d.id);
  const dType = escapeHtml(d.deviceType);
  const uid = dId.slice(-8); // unique suffix for element IDs on this card

  // --- Determine device category for rendering ---
  // Check if polled state has RangeController capabilities (e.g. Air Quality Monitors)
  const hasRangeState = caps.some(c => c.namespace === 'Alexa.RangeController');
  const isSensor = !hasInterface(d, 'Alexa.PowerController') && !isEchoSpeaker(d) &&
    (hasInterface(d, 'Alexa.ContactSensor') || hasInterface(d, 'Alexa.MotionSensor') ||
     hasInterface(d, 'Alexa.TemperatureSensor') || hasInterface(d, 'Alexa.InventoryLevelSensor') ||
     hasRangeState);

  const isLight = hasInterface(d, 'Alexa.PowerController') &&
    (hasInterface(d, 'Alexa.BrightnessController') || hasInterface(d, 'Alexa.ColorController'));

  const isSwitch = hasInterface(d, 'Alexa.PowerController') && !isLight;
  const isLock = hasInterface(d, 'Alexa.LockController');
  const echoSpeaker = isEchoSpeaker(d);

  // Helper to get a capability value
  const getCap = (ns, name) => caps.find(c => c.namespace === ns && c.name === name);

  let html = '';

  // ---- SENSOR CARDS: prominent data display ----
  if (isSensor) {
    const sensorItems = [];

    const contact = getCap('Alexa.ContactSensor', 'detectionState');
    if (contact) {
      const open = contact.value === 'DETECTED';
      sensorItems.push(`<div class="sensor-reading ${open ? 'sensor-alert' : ''}">
        <span class="sensor-icon">\u{1F6AA}</span>
        <span class="sensor-value">${open ? 'Open' : 'Closed'}</span>
      </div>`);
    }

    const motion = getCap('Alexa.MotionSensor', 'detectionState');
    if (motion) {
      const detected = motion.value === 'DETECTED';
      sensorItems.push(`<div class="sensor-reading ${detected ? 'sensor-alert' : ''}">
        <span class="sensor-icon">${detected ? '\u{1F3C3}' : '\u2714\uFE0F'}</span>
        <span class="sensor-value">${detected ? 'Motion' : 'Clear'}</span>
      </div>`);
    }

    const temp = getCap('Alexa.TemperatureSensor', 'temperature');
    if (temp && temp.value) {
      sensorItems.push(`<div class="sensor-reading">
        <span class="sensor-icon">\u{1F321}\uFE0F</span>
        <span class="sensor-value sensor-temp">${formatTemp(temp.value)}</span>
      </div>`);
    }

    // RangeController-based readings (Air Quality Monitors: humidity, VOC, PM, CO, IAQ, etc.)
    const rangeReadings = caps.filter(c => c.namespace === 'Alexa.RangeController' && c.instance);
    for (const rc of rangeReadings) {
      const inst = rc.instance.toLowerCase();
      const val = (rc.value !== null && rc.value !== undefined) ? rc.value : null;
      if (val === null) continue;
      // Get range config from the device discovery data for min/max context and friendlyName
      const rangeConfig = (d.rangeCapabilities || []).find(rc2 => rc2.instance === rc.instance);
      const info = rangeInstanceInfo(inst, rc.instance, rangeConfig && rangeConfig.friendlyName);
      const rangeHint = rangeConfig && rangeConfig.maximumValue != null
        ? ` <span class="sensor-range">/ ${rangeConfig.maximumValue}</span>` : '';
      sensorItems.push(`<div class="sensor-reading">
        <span class="sensor-icon">${info.icon}</span>
        <span class="sensor-value">${val}${rangeHint}${info.unit}</span>
        <span class="sensor-label">${escapeHtml(info.label)}</span>
      </div>`);
    }

    const battery = getCap('Alexa.InventoryLevelSensor', 'level');
    if (battery && battery.value) {
      const level = battery.value.value ?? battery.value;
      sensorItems.push(`<div class="sensor-reading">
        <span class="sensor-icon">\u{1F50B}</span>
        <span class="sensor-value">${level}%</span>
      </div>`);
    }

    if (sensorItems.length > 0) {
      // Show reading freshness from timeOfSample
      const freshness = getSnapshotFreshness(snapshot);
      const freshnessHtml = freshness
        ? `<span class="sensor-freshness" title="Reading taken ${new Date(freshness).toLocaleString()}">${formatSampleAge(freshness)}</span>`
        : '';
      html += `<div class="card-sensor-data">${sensorItems.join('')}${freshnessHtml}</div>`;
    }
    return html;
  }

  // ---- LOCK CARDS: lock state + buttons ----
  if (isLock) {
    const lockState = getCap('Alexa.LockController', 'lockState');
    const locked = lockState?.value === 'LOCKED';
    html += `<div class="card-inline-controls" onclick="event.stopPropagation()">
      <div class="card-state-row">
        <span class="${locked ? 'state-on' : 'state-off'}">${locked ? '\u{1F512} Locked' : '\u{1F513} Unlocked'}</span>
      </div>
      <div class="card-btn-row">
        <button class="card-ctrl-btn" onclick="controlDevice('${dId}','${dType}',{action:'lock'})" title="Lock">\u{1F512} Lock</button>
        <button class="card-ctrl-btn" onclick="controlDevice('${dId}','${dType}',{action:'unlock'})" title="Unlock">\u{1F513} Unlock</button>
      </div>
    </div>`;
    return html;
  }

  // ---- ECHO SPEAKER CARDS: volume slider + speak ----
  if (echoSpeaker) {
    const vol = getCap('Alexa.Speaker', 'volume');
    const volVal = vol?.value ?? 25;
    html += `<div class="card-inline-controls" onclick="event.stopPropagation()">
      <div class="card-slider-row">
        <span class="card-slider-label">\u{1F50A}</span>
        <input type="range" min="0" max="100" value="${volVal}" class="card-slider"
          id="cvol-${uid}"
          oninput="document.getElementById('cvol-v-${uid}').textContent=this.value"
          onchange="controlDevice('${dId}','${dType}',{action:'set_volume',volume:parseInt(this.value)})">
        <span class="card-slider-value" id="cvol-v-${uid}">${volVal}</span>
      </div>
      <div class="card-speak-row">
        <input type="text" class="card-speak-input" placeholder="Speak..."
          id="cspk-${uid}"
          onkeydown="if(event.key==='Enter'){event.preventDefault();controlDevice('${dId}','${dType}',{action:'speak',text:this.value});this.value='';}">
        <button class="card-ctrl-btn" onclick="const i=document.getElementById('cspk-${uid}');controlDevice('${dId}','${dType}',{action:'speak',text:i.value});i.value='';">\u{1F4AC}</button>
      </div>
    </div>`;
    return html;
  }

  // ---- LIGHT CARDS: on/off + brightness slider ----
  if (isLight) {
    const power = getCap('Alexa.PowerController', 'powerState');
    const isOn = power?.value === 'ON';
    const brightness = getCap('Alexa.BrightnessController', 'brightness');
    const bVal = brightness?.value ?? 50;

    html += `<div class="card-inline-controls" onclick="event.stopPropagation()">
      <div class="card-power-row">
        <button class="card-power-btn ${isOn ? 'active' : ''}" onclick="controlDevice('${dId}','${dType}',{action:'${isOn ? 'turn_off' : 'turn_on'}'})">${isOn ? '\u{2600}\uFE0F On' : 'Off'}</button>`;

    if (hasInterface(d, 'Alexa.BrightnessController')) {
      html += `
        <input type="range" min="0" max="100" value="${bVal}" class="card-slider card-slider-grow"
          id="cbri-${uid}"
          oninput="document.getElementById('cbri-v-${uid}').textContent=this.value+'%'"
          onchange="controlDevice('${dId}','${dType}',{action:'set_brightness',brightness:parseInt(this.value)})">
        <span class="card-slider-value" id="cbri-v-${uid}">${bVal}%</span>`;
    }

    html += `</div></div>`;
    return html;
  }

  // ---- SWITCH CARDS: on/off toggle ----
  if (isSwitch) {
    const power = getCap('Alexa.PowerController', 'powerState');
    const isOn = power?.value === 'ON';
    html += `<div class="card-inline-controls" onclick="event.stopPropagation()">
      <div class="card-power-row">
        <button class="card-power-btn ${isOn ? 'active' : ''}" onclick="controlDevice('${dId}','${dType}',{action:'${isOn ? 'turn_off' : 'turn_on'}'})">${isOn ? '\u26A1 On' : 'Off'}</button>
      </div>
    </div>`;
    return html;
  }

  // ---- FALLBACK: text state summary ----
  const stateHtml = renderDeviceStateSummary(snapshot, d);
  if (stateHtml) {
    return `<div class="device-state-summary">${stateHtml}</div>`;
  }

  return '';
}

function renderDeviceGrid() {
  const grid = document.getElementById('device-grid');
  const devices = getFilteredDevices();

  if (devices.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>No devices found</p><p class="text-muted">Try adjusting your filters or make sure your cookie is configured.</p></div>';
    document.getElementById('device-count').textContent = '0 devices';
    return;
  }

  document.getElementById('device-count').textContent =
    `${devices.length} device${devices.length !== 1 ? 's' : ''}` +
    (devices.length !== state.devices.length ? ` (of ${state.devices.length})` : '');

  const groupFilter = document.getElementById('device-group-filter').value;
  const hasCustomGroups = state.customGroups.groups.length > 0;
  const anyDeviceHasGroup = devices.some(d => getEffectiveGroup(d) !== null);

  // Edit mode toolbar (group creation + selection info)
  const editToolbarHtml = state.editMode ? `
    <div class="edit-mode-toolbar">
      <div class="add-group-row">
        <input type="text" id="new-group-name" class="form-input"
          placeholder="New room name..."
          onkeydown="if(event.key==='Enter'){event.preventDefault();handleAddGroup();}">
        <button id="add-group-btn" class="btn btn-primary btn-sm" onclick="handleAddGroup()">+ Add Room</button>
      </div>
      <div id="selection-actions" class="${state.selectedDeviceIds.size > 0 ? '' : 'hidden'}">
        <span class="text-muted">${state.selectedDeviceIds.size} selected</span>
        <button class="btn btn-sm btn-secondary" onclick="state.selectedDeviceIds.clear(); renderDeviceGrid();">Clear</button>
      </div>
    </div>
  ` : '';

  if (!groupFilter && (anyDeviceHasGroup || hasCustomGroups || state.editMode)) {
    // Build grouped sections using effective groups
    const grouped = new Map();
    const ungrouped = [];

    for (const d of devices) {
      const group = getEffectiveGroup(d);
      if (group) {
        if (!grouped.has(group)) grouped.set(group, []);
        grouped.get(group).push(d);
      } else {
        ungrouped.push(d);
      }
    }

    // Ensure all custom groups appear even if empty
    for (const g of state.customGroups.groups) {
      if (!grouped.has(g)) grouped.set(g, []);
    }

    // Sort: custom groups in creation order, then other groups alphabetically
    const customSet = new Set(state.customGroups.groups);
    const otherGroups = [...grouped.keys()].filter(k => !customSet.has(k)).sort();
    const orderedGroups = [...state.customGroups.groups.filter(g => grouped.has(g)), ...otherGroups];

    let html = editToolbarHtml;

    for (const groupName of orderedGroups) {
      const groupDevices = grouped.get(groupName) || [];
      const isCustom = customSet.has(groupName);
      const deleteBtn = (state.editMode && isCustom)
        ? `<button class="btn-icon btn-delete-group" title="Delete room"
            onclick="event.stopPropagation(); handleDeleteGroup('${escapeHtml(groupName)}')">&times;</button>`
        : '';

      const dropAttrs = state.editMode
        ? `ondragover="onGroupDragOver(event)" ondragleave="onGroupDragLeave(event)"
           ondrop="onGroupDrop(event, '${escapeHtml(groupName)}')"`
        : '';

      html += `<div class="device-group-section${state.editMode ? ' drop-target' : ''}"
        data-group-name="${escapeHtml(groupName)}" ${dropAttrs}>
        <div class="device-group-header">
          <h3 class="device-group-name">${escapeHtml(groupName)}</h3>
          <span class="device-group-count">${groupDevices.length}</span>
          ${deleteBtn}
        </div>
        <div class="device-group-grid${groupDevices.length === 0 ? ' empty-drop-zone' : ''}">
          ${groupDevices.length > 0
            ? groupDevices.map(renderDeviceCard).join('')
            : '<div class="drop-placeholder">Drag devices here</div>'}
        </div>
      </div>`;
    }

    // Ungrouped section — always visible in edit mode
    if (ungrouped.length > 0 || state.editMode) {
      const ungroupedDropAttrs = state.editMode
        ? `ondragover="onGroupDragOver(event)" ondragleave="onGroupDragLeave(event)"
           ondrop="onGroupDrop(event, null)"`
        : '';

      html += `<div class="device-group-section${state.editMode ? ' drop-target' : ''}"
        data-group-name="__ungrouped__" ${ungroupedDropAttrs}>
        <div class="device-group-header">
          <h3 class="device-group-name">Ungrouped</h3>
          <span class="device-group-count">${ungrouped.length}</span>
        </div>
        <div class="device-group-grid${ungrouped.length === 0 ? ' empty-drop-zone' : ''}">
          ${ungrouped.length > 0
            ? ungrouped.map(renderDeviceCard).join('')
            : '<div class="drop-placeholder">Drag devices here to remove from rooms</div>'}
        </div>
      </div>`;
    }

    grid.innerHTML = html;
  } else {
    // Flat grid (no grouping)
    grid.innerHTML = (state.editMode ? editToolbarHtml : '') + devices.map(renderDeviceCard).join('');
  }
}

/** Map phoenix API error codes to user-friendly messages */
function friendlyError(error) {
  if (!error) return '';
  if (error.includes('ENDPOINT_UNREACHABLE')) return 'Unreachable';
  if (error.includes('TargetApplianceDisabledException')) return 'Disabled';
  if (error.includes('TargetApplianceNotFoundException')) return 'Not found';
  if (error.includes('BRIDGE_UNREACHABLE')) return 'Hub offline';
  if (error.includes('Batch request failed')) return 'Request failed';
  return error.split(':')[0];
}

function renderDeviceStateSummary(snapshot, device) {
  if (!snapshot) return '';
  if (snapshot.error) {
    return `<span class="state-unreachable">${escapeHtml(friendlyError(snapshot.error))}</span>`;
  }
  const caps = snapshot.capabilities || [];
  if (caps.length === 0) return '';
  const parts = [];

  // Power state
  const power = caps.find(c => c.namespace === 'Alexa.PowerController' && c.name === 'powerState');
  if (power) {
    const isOn = power.value === 'ON';
    parts.push(`<span class="${isOn ? 'state-on' : 'state-off'}">${isOn ? 'On' : 'Off'}</span>`);
  }

  // Brightness
  const brightness = caps.find(c => c.namespace === 'Alexa.BrightnessController' && c.name === 'brightness');
  if (brightness && brightness.value !== undefined) {
    parts.push(`\u{2600}\uFE0F ${brightness.value}%`);
  }

  // Volume
  const volume = caps.find(c => c.namespace === 'Alexa.Speaker' && c.name === 'volume');
  if (volume && volume.value !== undefined) {
    parts.push(`\u{1F50A} ${volume.value}`);
  }

  // Color
  const color = caps.find(c => c.namespace === 'Alexa.ColorController' && c.name === 'color');
  if (color && color.value && color.value.hue !== undefined) {
    parts.push(`\u{1F3A8} H:${Math.round(color.value.hue)}`);
  }

  // Lock state
  const lock = caps.find(c => c.namespace === 'Alexa.LockController' && c.name === 'lockState');
  if (lock) {
    const locked = lock.value === 'LOCKED';
    parts.push(`${locked ? '\u{1F512}' : '\u{1F513}'} ${locked ? 'Locked' : 'Unlocked'}`);
  }

  // Contact sensor
  const contact = caps.find(c => c.namespace === 'Alexa.ContactSensor' && c.name === 'detectionState');
  if (contact) {
    const detected = contact.value === 'DETECTED';
    parts.push(`\u{1F6AA} ${detected ? 'Open' : 'Closed'}`);
  }

  // Motion sensor
  const motion = caps.find(c => c.namespace === 'Alexa.MotionSensor' && c.name === 'detectionState');
  if (motion) {
    const detected = motion.value === 'DETECTED';
    parts.push(`${detected ? '\u{1F3C3} Motion' : 'Clear'}`);
  }

  // Temperature
  const temp = caps.find(c => c.namespace === 'Alexa.TemperatureSensor' && c.name === 'temperature');
  if (temp && temp.value) {
    parts.push(`\u{1F321}\uFE0F ${formatTemp(temp.value)}`);
  }

  // Thermostat
  const thermostat = caps.find(c => c.namespace === 'Alexa.ThermostatController' && c.name === 'thermostatMode');
  if (thermostat && thermostat.value) {
    parts.push(`Mode: ${thermostat.value}`);
  }
  const targetTemp = caps.find(c => c.namespace === 'Alexa.ThermostatController' && c.name === 'targetSetpoint');
  if (targetTemp && targetTemp.value) {
    parts.push(`Target: ${formatTemp(targetTemp.value)}`);
  }

  // Fan / Percentage
  const pct = caps.find(c => c.namespace === 'Alexa.PercentageController' && c.name === 'percentage');
  if (pct && pct.value !== undefined) {
    parts.push(`Speed: ${pct.value}%`);
  }

  // Battery level (from InventoryLevelSensor)
  const battery = caps.find(c => c.namespace === 'Alexa.InventoryLevelSensor' && c.name === 'level');
  if (battery && battery.value) {
    const level = battery.value.value ?? battery.value;
    parts.push(`\u{1F50B} ${level}%`);
  }

  // Connectivity
  const conn = caps.find(c => c.namespace === 'Alexa.EndpointHealth' && c.name === 'connectivity');
  if (conn && conn.value && conn.value.value !== 'OK') {
    parts.push(`<span class="text-error">Unreachable</span>`);
  }

  return parts.join(' &middot; ');
}

async function pollAllStates() {
  await pollStatesInBackground();
}

// ---------------------------------------------------------------------------
// Device Control Modal
// ---------------------------------------------------------------------------

// Device families that support Echo speaker features (volume, media, speak)
const ECHO_SPEAKER_FAMILIES = ['ECHO', 'KNIGHT', 'ROOK', 'ZEPHYR', 'FIRE_TV'];

// Helper: check if device has a specific Alexa interface
function hasInterface(device, iface) {
  return (device.interfaces || []).some(i => i === iface);
}

// Helper: check if this is an Echo-family speaker (not eero, not microwave)
function isEchoSpeaker(device) {
  return device.source === 'echo' && ECHO_SPEAKER_FAMILIES.includes(device.deviceType);
}

function openDeviceModal(deviceId) {
  const device = state.devices.find(d => d.id === deviceId);
  if (!device) return;

  const modal = document.getElementById('device-modal');
  const nameEl = document.getElementById('modal-device-name');
  const infoEl = document.getElementById('modal-device-info');
  const controlsEl = document.getElementById('modal-controls');
  const stateEl = document.getElementById('modal-state');

  nameEl.textContent = device.name;
  const desc = device.description && device.description !== device.name ? device.description : '';

  // Build controls based on Alexa interfaces (not vague capability strings)
  const controls = [];
  const snap = state.deviceStates[device.applianceId || device.id];

  // Determine online status from polled state
  const modalOnline = !isDeviceUnavailable(device);

  // Info badges
  infoEl.innerHTML = `
    <span class="online-dot ${modalOnline ? 'online' : 'offline'}"></span>
    ${device.deviceType ? `<span class="device-type-badge">${escapeHtml(device.deviceType)}</span>` : ''}
    <span class="device-source-badge ${device.source}">${device.source}</span>
    ${desc ? `<span style="font-size:0.75rem;color:var(--text-muted)">${escapeHtml(desc)}</span>` : ''}
  `;
  const dId = escapeHtml(device.id);
  const dType = escapeHtml(device.deviceType);

  // Power control — only if device actually has PowerController interface
  if (hasInterface(device, 'Alexa.PowerController') || isEchoSpeaker(device)) {
    controls.push(`
      <div class="control-group">
        <div class="control-group-label">Power</div>
        <div class="power-toggle">
          <button class="power-btn on" onclick="controlDevice('${dId}', '${dType}', {action:'turn_on'})">On</button>
          <button class="power-btn off" onclick="controlDevice('${dId}', '${dType}', {action:'turn_off'})">Off</button>
        </div>
      </div>
    `);
  }

  // Brightness — only if BrightnessController
  if (hasInterface(device, 'Alexa.BrightnessController')) {
    const currentBrightness = snap?.capabilities?.find(c => c.namespace === 'Alexa.BrightnessController')?.value ?? 50;
    controls.push(`
      <div class="control-group">
        <div class="control-group-label">Brightness</div>
        <div class="control-row">
          <input type="range" min="0" max="100" value="${currentBrightness}" id="brightness-slider"
            oninput="document.getElementById('brightness-value').textContent=this.value+'%'">
          <span class="range-value" id="brightness-value">${currentBrightness}%</span>
          <button class="btn btn-sm btn-primary" onclick="controlDevice('${dId}', '${dType}', {action:'set_brightness', brightness: parseInt(document.getElementById('brightness-slider').value)})">Set</button>
        </div>
      </div>
    `);
  }

  // Volume — only for Echo speakers
  if (isEchoSpeaker(device)) {
    const currentVol = snap?.capabilities?.find(c => c.namespace === 'Alexa.Speaker' && c.name === 'volume')?.value ?? 25;
    controls.push(`
      <div class="control-group">
        <div class="control-group-label">Volume</div>
        <div class="control-row">
          <input type="range" min="0" max="100" value="${currentVol}" id="volume-slider"
            oninput="document.getElementById('volume-value').textContent=this.value">
          <span class="range-value" id="volume-value">${currentVol}</span>
          <button class="btn btn-sm btn-primary" onclick="controlDevice('${dId}', '${dType}', {action:'set_volume', volume: parseInt(document.getElementById('volume-slider').value)})">Set</button>
        </div>
      </div>
    `);
  }

  // Color — only if ColorController
  if (hasInterface(device, 'Alexa.ColorController')) {
    const colors = [
      { name: 'Red', h: 0, s: 1, b: 1, css: '#ff0000' },
      { name: 'Orange', h: 30, s: 1, b: 1, css: '#ff8800' },
      { name: 'Yellow', h: 60, s: 1, b: 1, css: '#ffff00' },
      { name: 'Green', h: 120, s: 1, b: 1, css: '#00ff00' },
      { name: 'Cyan', h: 180, s: 1, b: 1, css: '#00ffff' },
      { name: 'Blue', h: 240, s: 1, b: 1, css: '#0000ff' },
      { name: 'Purple', h: 280, s: 1, b: 1, css: '#8800ff' },
      { name: 'Pink', h: 320, s: 1, b: 1, css: '#ff00aa' },
      { name: 'White', h: 0, s: 0, b: 1, css: '#ffffff' },
    ];
    controls.push(`
      <div class="control-group">
        <div class="control-group-label">Color</div>
        <div class="color-presets">
          ${colors.map(c => `<button class="color-btn" style="background:${c.css}" title="${c.name}"
            onclick="controlDevice('${dId}', '${dType}', {action:'set_color', color:{hue:${c.h},saturation:${c.s},brightness:${c.b}}})"></button>`).join('')}
        </div>
      </div>
    `);
  }

  // Lock — only if LockController
  if (hasInterface(device, 'Alexa.LockController')) {
    const lockState = snap?.capabilities?.find(c => c.namespace === 'Alexa.LockController' && c.name === 'lockState')?.value;
    controls.push(`
      <div class="control-group">
        <div class="control-group-label">Lock ${lockState ? `<span class="text-muted">(${lockState})</span>` : ''}</div>
        <div class="power-toggle">
          <button class="power-btn on" onclick="controlDevice('${dId}', '${dType}', {action:'lock'})">Lock</button>
          <button class="power-btn off" onclick="controlDevice('${dId}', '${dType}', {action:'unlock'})">Unlock</button>
        </div>
      </div>
    `);
  }

  // Fan speed (PercentageController) — for fans
  if (hasInterface(device, 'Alexa.PercentageController')) {
    const currentPct = snap?.capabilities?.find(c => c.namespace === 'Alexa.PercentageController' && c.name === 'percentage')?.value ?? 50;
    controls.push(`
      <div class="control-group">
        <div class="control-group-label">Speed</div>
        <div class="control-row">
          <input type="range" min="0" max="100" value="${currentPct}" id="percentage-slider"
            oninput="document.getElementById('percentage-value').textContent=this.value+'%'">
          <span class="range-value" id="percentage-value">${currentPct}%</span>
          <button class="btn btn-sm btn-primary" onclick="controlDevice('${dId}', '${dType}', {action:'set_percentage', percentage: parseInt(document.getElementById('percentage-slider').value)})">Set</button>
        </div>
      </div>
    `);
  }

  // Media controls + Speak — only for Echo speakers
  if (isEchoSpeaker(device)) {
    controls.push(`
      <div class="control-group">
        <div class="control-group-label">Media</div>
        <div class="media-controls">
          <button class="media-btn" title="Previous" onclick="controlDevice('${dId}', '${dType}', {action:'previous'})">&#x23EE;</button>
          <button class="media-btn" title="Play" onclick="controlDevice('${dId}', '${dType}', {action:'play'})">&#x25B6;</button>
          <button class="media-btn" title="Pause" onclick="controlDevice('${dId}', '${dType}', {action:'pause'})">&#x23F8;</button>
          <button class="media-btn" title="Next" onclick="controlDevice('${dId}', '${dType}', {action:'next'})">&#x23ED;</button>
        </div>
      </div>
    `);

    controls.push(`
      <div class="control-group">
        <div class="control-group-label">Speak</div>
        <div class="speak-input">
          <input type="text" id="speak-text" placeholder="Type text to speak..." onkeydown="if(event.key==='Enter')document.getElementById('speak-send').click()">
          <button class="btn btn-sm btn-primary" id="speak-send" onclick="controlDevice('${dId}', '${dType}', {action:'speak', text: document.getElementById('speak-text').value})">Speak</button>
        </div>
      </div>
    `);
  }

  controlsEl.innerHTML = controls.length > 0
    ? controls.join('')
    : '<p class="text-muted" style="font-size:0.85rem">This device has no controllable actions.</p>';

  // Show current state — human-readable for key capabilities, then raw table
  const snapshot = state.deviceStates[device.applianceId || device.id];
  if (snapshot && snapshot.capabilities && snapshot.capabilities.length > 0) {
    const readableState = renderReadableState(snapshot, device);
    const rawRows = snapshot.capabilities.map(c => {
      const shortNs = c.namespace?.split('.').pop() || '';
      const instSuffix = c.instance ? ` [${c.instance}]` : '';
      const val = formatStateValue(c.value);
      return `<div class="state-row">
        <span class="state-key">${escapeHtml(shortNs)}.${escapeHtml(c.name)}${escapeHtml(instSuffix)}</span>
        <span class="state-value">${val}</span>
      </div>`;
    }).join('');

    stateEl.innerHTML = `
      ${readableState ? `<div class="readable-state">${readableState}</div>` : ''}
      <details class="state-details">
        <summary class="control-group-label" style="cursor:pointer;margin-bottom:8px">
          Raw State <span class="text-muted">(polled ${timeAgo(snapshot.polledAt)})</span>
        </summary>
        <div class="state-table">${rawRows}</div>
      </details>
    `;
  } else if (snapshot && snapshot.error) {
    stateEl.innerHTML = `<div class="state-error-box"><span class="text-error">${escapeHtml(friendlyError(snapshot.error))}</span><span class="text-muted" style="font-size:0.75rem">${escapeHtml(snapshot.error)}</span></div>`;
  } else {
    stateEl.innerHTML = '<p class="text-muted" style="font-size:0.8rem;margin-top:12px">No state data. Click "Poll States" to fetch current state.</p>';
  }

  modal.classList.remove('hidden');

  // Load historical data for sensor devices (async, non-blocking)
  loadDeviceHistory(device.applianceId || device.id, device);
}

/** Render human-readable state items for the modal */
function renderReadableState(snapshot, device) {
  const caps = snapshot.capabilities || [];
  const items = [];

  const power = caps.find(c => c.namespace === 'Alexa.PowerController' && c.name === 'powerState');
  if (power) {
    const on = power.value === 'ON';
    items.push(`<div class="readable-state-item"><span class="readable-label">Power</span><span class="${on ? 'state-on' : 'state-off'}">${on ? 'On' : 'Off'}</span></div>`);
  }

  const lock = caps.find(c => c.namespace === 'Alexa.LockController' && c.name === 'lockState');
  if (lock) {
    const locked = lock.value === 'LOCKED';
    items.push(`<div class="readable-state-item"><span class="readable-label">${locked ? '\u{1F512}' : '\u{1F513}'} Lock</span><span>${locked ? 'Locked' : 'Unlocked'}</span></div>`);
  }

  const contact = caps.find(c => c.namespace === 'Alexa.ContactSensor' && c.name === 'detectionState');
  if (contact) {
    const open = contact.value === 'DETECTED';
    items.push(`<div class="readable-state-item"><span class="readable-label">\u{1F6AA} Door</span><span>${open ? 'Open' : 'Closed'}</span></div>`);
  }

  const motion = caps.find(c => c.namespace === 'Alexa.MotionSensor' && c.name === 'detectionState');
  if (motion) {
    const detected = motion.value === 'DETECTED';
    items.push(`<div class="readable-state-item"><span class="readable-label">Motion</span><span>${detected ? '\u{1F3C3} Detected' : 'Clear'}</span></div>`);
  }

  const temp = caps.find(c => c.namespace === 'Alexa.TemperatureSensor' && c.name === 'temperature');
  if (temp && temp.value) {
    items.push(`<div class="readable-state-item"><span class="readable-label">\u{1F321}\uFE0F Temperature</span><span>${formatTemp(temp.value)}</span></div>`);
  }

  const brightness = caps.find(c => c.namespace === 'Alexa.BrightnessController' && c.name === 'brightness');
  if (brightness && brightness.value !== undefined) {
    items.push(`<div class="readable-state-item"><span class="readable-label">\u{2600}\uFE0F Brightness</span><span>${brightness.value}%</span></div>`);
  }

  const pct = caps.find(c => c.namespace === 'Alexa.PercentageController' && c.name === 'percentage');
  if (pct && pct.value !== undefined) {
    items.push(`<div class="readable-state-item"><span class="readable-label">Speed</span><span>${pct.value}%</span></div>`);
  }

  const thermoMode = caps.find(c => c.namespace === 'Alexa.ThermostatController' && c.name === 'thermostatMode');
  if (thermoMode) {
    items.push(`<div class="readable-state-item"><span class="readable-label">Mode</span><span>${thermoMode.value}</span></div>`);
  }
  const targetTemp = caps.find(c => c.namespace === 'Alexa.ThermostatController' && c.name === 'targetSetpoint');
  if (targetTemp && targetTemp.value) {
    const v = targetTemp.value;
    items.push(`<div class="readable-state-item"><span class="readable-label">Target</span><span>${v.value || v}\u00B0</span></div>`);
  }

  // RangeController-based readings (Air Quality Monitors, etc.)
  const rangeCaps = caps.filter(c => c.namespace === 'Alexa.RangeController' && c.instance);
  for (const rc of rangeCaps) {
    const val = rc.value;
    if (val === null || val === undefined) continue;
    // Include range config (min/max) from discovery
    const rangeConfig = device && (device.rangeCapabilities || []).find(r => r.instance === rc.instance);
    const info = rangeInstanceInfo(rc.instance.toLowerCase(), rc.instance, rangeConfig && rangeConfig.friendlyName);
    const rangeStr = rangeConfig && rangeConfig.maximumValue != null
      ? ` <span class="readable-range">(${rangeConfig.minimumValue ?? 0}–${rangeConfig.maximumValue})</span>` : '';
    const sampleAge = rc.timeOfSample ? ` <span class="readable-age">${formatSampleAge(rc.timeOfSample)}</span>` : '';
    items.push(`<div class="readable-state-item"><span class="readable-label">${info.icon} ${escapeHtml(info.label)}</span><span>${val}${info.unit}${rangeStr}${sampleAge}</span></div>`);
  }

  const battery = caps.find(c => c.namespace === 'Alexa.InventoryLevelSensor' && c.name === 'level');
  if (battery && battery.value) {
    const level = battery.value.value ?? battery.value;
    items.push(`<div class="readable-state-item"><span class="readable-label">\u{1F50B} Battery</span><span>${level}%</span></div>`);
  }

  const conn = caps.find(c => c.namespace === 'Alexa.EndpointHealth' && c.name === 'connectivity');
  if (conn && conn.value) {
    const ok = conn.value.value === 'OK' || conn.value === 'OK';
    items.push(`<div class="readable-state-item"><span class="readable-label">Connectivity</span><span class="${ok ? 'state-on' : 'text-error'}">${ok ? 'OK' : 'Unreachable'}</span></div>`);
  }

  return items.join('');
}

/** Fetch and render historical readings for a device in the modal. */
async function loadDeviceHistory(deviceId, device) {
  const historyEl = document.getElementById('modal-history');
  if (!historyEl) return;

  // Only show history for sensor-type devices (those with RangeController or TemperatureSensor)
  const hasSensorData = (device.interfaces || []).some(i =>
    i === 'Alexa.TemperatureSensor' || i === 'Alexa.ContactSensor' ||
    i === 'Alexa.MotionSensor' || i === 'Alexa.RangeController' ||
    i === 'Alexa.InventoryLevelSensor'
  );
  // Also check polled state for RangeController readings
  const snap = state.deviceStates[device.applianceId || device.id];
  const hasRangeState = snap && (snap.capabilities || []).some(c => c.namespace === 'Alexa.RangeController');

  if (!hasSensorData && !hasRangeState) {
    historyEl.innerHTML = '';
    return;
  }

  historyEl.innerHTML = '<div class="history-loading"><span class="loading-spinner"></span> Loading history...</div>';

  try {
    const res = await fetch(`/state-history?deviceId=${encodeURIComponent(deviceId)}&limit=24`);
    const data = await res.json();
    const snapshots = data.snapshots || [];

    if (snapshots.length <= 1) {
      historyEl.innerHTML = '<div class="history-empty">No historical data yet. Readings are collected automatically every 10 minutes.</div>';
      return;
    }

    // Build a timeline of key readings from snapshots (oldest → newest)
    const reversed = [...snapshots].reverse();

    // Identify which capabilities to track (RangeController instances + temperature)
    const trackedKeys = new Map(); // key → { label, icon, unit, values: [{time, value}] }
    for (const s of reversed) {
      for (const cap of s.capabilities || []) {
        if (cap.namespace === 'Alexa.TemperatureSensor' && cap.name === 'temperature' && cap.value) {
          const key = 'temp';
          if (!trackedKeys.has(key)) {
            trackedKeys.set(key, { label: 'Temp', icon: '\u{1F321}\uFE0F', unit: '\u00B0F', values: [] });
          }
          const f = toFahrenheit(cap.value);
          trackedKeys.get(key).values.push({ time: s.polledAt, value: f.value });
        }
        if (cap.namespace === 'Alexa.RangeController' && cap.instance && cap.value != null) {
          const key = 'range-' + cap.instance;
          if (!trackedKeys.has(key)) {
            const rc = device && (device.rangeCapabilities || []).find(r => r.instance === cap.instance);
            const info = rangeInstanceInfo(cap.instance.toLowerCase(), cap.instance, rc && rc.friendlyName);
            trackedKeys.set(key, { label: info.label, icon: info.icon, unit: info.unit, values: [] });
          }
          trackedKeys.get(key).values.push({ time: s.polledAt, value: Number(cap.value) });
        }
      }
    }

    if (trackedKeys.size === 0) {
      historyEl.innerHTML = '<div class="history-empty">No sensor data in history.</div>';
      return;
    }

    // Render sparklines for each tracked reading
    let html = '<div class="history-section"><div class="history-header">History <span class="text-muted">(' + snapshots.length + ' readings)</span></div>';

    for (const [key, track] of trackedKeys) {
      if (track.values.length < 2) continue;
      const values = track.values.map(v => v.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const latest = values[values.length - 1];
      const first = values[0];
      const delta = latest - first;
      const deltaStr = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
      const deltaClass = Math.abs(delta) < 0.5 ? '' : (delta > 0 ? 'trend-up' : 'trend-down');

      // Build SVG sparkline
      const sparkline = renderSparkline(values, 120, 28);

      // Time range
      const oldest = track.values[0].time;
      const newest = track.values[track.values.length - 1].time;
      const spanMs = new Date(newest).getTime() - new Date(oldest).getTime();
      const spanStr = spanMs < 3600000 ? `${Math.round(spanMs / 60000)}m`
        : spanMs < 86400000 ? `${Math.round(spanMs / 3600000)}h`
        : `${Math.round(spanMs / 86400000)}d`;

      html += `<div class="history-row">
        <div class="history-label">${track.icon} ${escapeHtml(track.label)}</div>
        <div class="history-sparkline">${sparkline}</div>
        <div class="history-stats">
          <span class="history-current">${latest}${track.unit}</span>
          <span class="history-delta ${deltaClass}">${deltaStr}</span>
          <span class="history-range">${min}–${max}</span>
          <span class="history-span">${spanStr}</span>
        </div>
      </div>`;
    }

    html += '</div>';
    historyEl.innerHTML = html;
  } catch (err) {
    historyEl.innerHTML = '<div class="history-empty">Failed to load history.</div>';
    console.warn('Failed to load device history:', err);
  }
}

/** Render a simple SVG sparkline from an array of numbers. */
function renderSparkline(values, width, height) {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const padding = 2;
  const h = height - padding * 2;
  const step = (width - padding * 2) / (values.length - 1);

  const points = values.map((v, i) => {
    const x = padding + i * step;
    const y = padding + h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="sparkline-svg">
    <polyline points="${points.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${points[points.length - 1].split(',')[0]}" cy="${points[points.length - 1].split(',')[1]}" r="2" fill="var(--accent)"/>
  </svg>`;
}

function closeDeviceModal() {
  document.getElementById('device-modal').classList.add('hidden');
}

async function controlDevice(deviceId, deviceType, command) {
  showToast(`Sending ${command.action}...`, 'info');
  // Look up device to include source and entityId for smart home routing
  const device = state.devices.find(d => d.id === deviceId);
  const result = await api({
    type: 'control_account_device',
    deviceId,
    deviceType,
    command,
    source: device?.source,
    entityId: device?.entityId,
    alexaDeviceType: device?.alexaDeviceType,
  });

  if (result.success) {
    showToast(`${command.action} sent successfully`, 'success');

    // Optimistically update local state so the UI reflects the change immediately.
    // This is especially important for Echo devices where poll_device_state can't
    // query volume/media state from the Phoenix API.
    const stateKey = device?.applianceId || deviceId;
    const snap = state.deviceStates[stateKey] || {
      deviceId: stateKey, deviceName: device?.name, capabilities: [], polledAt: new Date().toISOString(),
    };
    const updateCap = (ns, name, value) => {
      const existing = snap.capabilities.find(c => c.namespace === ns && c.name === name);
      if (existing) { existing.value = value; }
      else { snap.capabilities.push({ namespace: ns, name, value }); }
    };
    if (command.action === 'turn_on') updateCap('Alexa.PowerController', 'powerState', 'ON');
    if (command.action === 'turn_off') updateCap('Alexa.PowerController', 'powerState', 'OFF');
    if (command.action === 'set_volume') updateCap('Alexa.Speaker', 'volume', command.volume);
    if (command.action === 'set_brightness') updateCap('Alexa.BrightnessController', 'brightness', command.brightness);
    if (command.action === 'set_color') updateCap('Alexa.ColorController', 'color', command.color);
    snap.polledAt = new Date().toISOString();
    state.deviceStates[stateKey] = snap;
    renderDeviceGrid();
    const modal = document.getElementById('device-modal');
    if (!modal.classList.contains('hidden')) openDeviceModal(deviceId);

    // Also re-poll from the API for smart home devices (they have real state)
    if (device?.source === 'smart_home' && device?.applianceId) {
      setTimeout(async () => {
        const pollResult = await api({ type: 'poll_device_state', entityId: device.id, applianceId: device.applianceId });
        if (pollResult.success && pollResult.data.state) {
          state.deviceStates[pollResult.data.state.deviceId] = pollResult.data.state;
          renderDeviceGrid();
          if (!modal.classList.contains('hidden')) openDeviceModal(deviceId);
        }
      }, 2000);
    }
  } else {
    showToast(result.error || 'Command failed', 'error');
  }
}

// ---------------------------------------------------------------------------
// Routines Tab
// ---------------------------------------------------------------------------

async function loadRoutines() {
  const list = document.getElementById('routine-list');
  list.innerHTML = '<div class="loading-placeholder"><span class="loading-spinner"></span> Loading routines...</div>';

  const result = await api({ type: 'list_routines' });
  if (!result.success) {
    list.innerHTML = `<div class="empty-state"><p>Failed to load routines</p><p class="text-muted">${escapeHtml(result.error)}</p></div>`;
    return;
  }

  state.routines = result.data.routines || [];
  renderRoutineList();
}

function renderRoutineList() {
  const list = document.getElementById('routine-list');

  if (state.routines.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>No routines found</p><p class="text-muted">This shows routines created through this tool, not routines from the Alexa app.<br>Click "+ Create Routine" above to add one.</p></div>';
    return;
  }

  list.innerHTML = state.routines.map(r => {
    const triggerIcon = r.trigger?.type === 'schedule' ? '\u{1F552}' : r.trigger?.type === 'device_event' ? '\u{1F4F1}' : '\u{26A1}';
    const triggerText = r.trigger?.type === 'schedule' ? `Schedule: ${r.trigger.cron || 'unknown'}`
      : r.trigger?.type === 'device_event' ? `Device: ${r.trigger.endpointId || 'unknown'}`
      : `Custom: ${r.trigger?.triggerId || 'unknown'}`;

    return `<div class="routine-card">
      <span class="routine-icon">${triggerIcon}</span>
      <div class="routine-info">
        <div class="routine-name">${escapeHtml(r.name)}</div>
        <div class="routine-trigger">${escapeHtml(triggerText)}</div>
        <div class="routine-meta">
          <span class="routine-enabled-badge ${r.enabled ? 'enabled' : 'disabled'}">${r.enabled ? 'Enabled' : 'Disabled'}</span>
          <span style="font-size:0.75rem;color:var(--text-muted)">${r.actionCount} action${r.actionCount !== 1 ? 's' : ''}</span>
          ${r.lastTriggered ? `<span style="font-size:0.75rem;color:var(--text-muted)">Last: ${timeAgo(r.lastTriggered)}</span>` : ''}
        </div>
      </div>
      <div class="routine-actions">
        <button class="trigger-btn" data-routine="${escapeHtml(r.id)}" onclick="triggerRoutine('${escapeHtml(r.id)}', this)">
          Trigger
        </button>
      </div>
    </div>`;
  }).join('');
}

async function triggerRoutine(routineId, btn) {
  btn.disabled = true;
  btn.textContent = 'Triggering...';

  const result = await api({ type: 'trigger_routine', routineId });

  if (result.success) {
    btn.textContent = 'Triggered!';
    btn.className = 'trigger-btn triggered';
  } else {
    btn.textContent = 'Failed';
    btn.className = 'trigger-btn failed';
    showToast(result.error || 'Failed to trigger routine', 'error');
  }

  setTimeout(() => {
    btn.textContent = 'Trigger';
    btn.className = 'trigger-btn';
    btn.disabled = false;
  }, 2000);
}

function toggleRoutineForm(show) {
  const form = document.getElementById('routine-create-form');
  if (show) {
    form.classList.remove('hidden');
    document.getElementById('routine-name').focus();
  } else {
    form.classList.add('hidden');
    document.getElementById('routine-name').value = '';
    document.getElementById('routine-trigger').value = '';
    document.getElementById('routine-actions').value = '';
  }
}

async function saveRoutine() {
  const name = document.getElementById('routine-name').value.trim();
  const triggerPhrase = document.getElementById('routine-trigger').value.trim();
  const actionsText = document.getElementById('routine-actions').value.trim();

  if (!name) { showToast('Routine name is required', 'error'); return; }

  // Parse trigger — if it looks like a cron, use schedule; otherwise use custom trigger ID
  let trigger;
  if (triggerPhrase.includes('*') || triggerPhrase.includes('/')) {
    trigger = { type: 'schedule', cron: triggerPhrase };
  } else if (triggerPhrase) {
    trigger = { type: 'custom', triggerId: triggerPhrase.toLowerCase().replace(/\s+/g, '-') };
  } else {
    trigger = { type: 'custom', triggerId: name.toLowerCase().replace(/\s+/g, '-') };
  }

  // Parse actions — each line is "endpointId:command" or "speak:text"
  const actions = [];
  for (const line of actionsText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const target = trimmed.substring(0, colonIdx).trim();
    const cmdStr = trimmed.substring(colonIdx + 1).trim();

    if (target === 'speak') {
      // Speak action — needs an Echo device; use first known echo or empty
      const echoDevice = state.devices.find(d => d.source === 'echo');
      actions.push({
        type: 'device_command',
        endpointId: echoDevice?.id || 'default',
        command: { action: 'speak', text: cmdStr },
      });
    } else {
      // Device command — turn_on, turn_off, set_brightness:50, etc.
      let command;
      if (cmdStr === 'turn_on') command = { action: 'turn_on' };
      else if (cmdStr === 'turn_off') command = { action: 'turn_off' };
      else if (cmdStr.startsWith('set_brightness:')) command = { action: 'set_brightness', brightness: parseInt(cmdStr.split(':')[1]) };
      else if (cmdStr.startsWith('set_volume:')) command = { action: 'set_volume', volume: parseInt(cmdStr.split(':')[1]) };
      else command = { action: cmdStr };

      actions.push({
        type: 'device_command',
        endpointId: target,
        command,
      });
    }
  }

  const result = await api({
    type: 'create_routine',
    routine: { name, trigger, actions },
  });

  if (result.success) {
    showToast('Routine created', 'success');
    toggleRoutineForm(false);
    loadRoutines();
  } else {
    showToast(result.error || 'Failed to create routine', 'error');
  }
}

// ---------------------------------------------------------------------------
// Logs Tab — Events
// ---------------------------------------------------------------------------

function getActiveTimeRange(container) {
  const activeBtn = container.querySelector('.time-btn.active');
  return activeBtn ? activeBtn.dataset.range : '1h';
}

async function loadEvents() {
  const table = document.getElementById('events-table');
  const pagination = document.getElementById('events-pagination');

  const range = getActiveTimeRange(document.querySelector('#subtab-events .time-range-buttons'));
  const startTime = getTimeRange(range);
  const deviceFilter = document.getElementById('event-device-filter').value;
  const kindFilter = document.getElementById('event-kind-filter').value;

  // Fetch state snapshots and device control / push events in parallel
  const stateParams = { type: 'query_state_history', limit: 100 };
  if (startTime) stateParams.startTime = startTime;
  if (deviceFilter) stateParams.deviceId = deviceFilter;

  const eventQuery = { limit: 200 };
  if (startTime) eventQuery.startTime = startTime;

  const [stateResult, eventResult] = await Promise.all([
    api(stateParams),
    api({ type: 'query_events', query: eventQuery }),
  ]);

  // Build unified timeline entries
  const timeline = [];

  // Add state snapshots
  if (stateResult.success && (!kindFilter || kindFilter === 'state')) {
    for (const snap of stateResult.data?.snapshots || []) {
      if (deviceFilter && snap.deviceId !== deviceFilter) continue;
      const caps = (snap.capabilities || [])
        .map(c => {
          const ns = (c.namespace || '').split('.').pop();
          const val = typeof c.value === 'object' ? JSON.stringify(c.value) : String(c.value);
          return `${ns}.${c.name}: ${val}`;
        })
        .join(', ');
      timeline.push({
        timestamp: snap.polledAt,
        kind: 'state',
        device: snap.deviceName || snap.deviceId,
        summary: caps || 'No capabilities',
        detail: snap,
      });
    }
  }

  // Add device control actions and push events (exclude self-queries)
  if (eventResult.success) {
    for (const e of eventResult.data?.events || []) {
      // Skip internal agent queries
      if (e.tags?.includes('agent_action') && !e.tags?.includes('device_control')) continue;

      const isPush = e.tags?.includes('push_event');
      const isControl = e.tags?.includes('device_control');
      if (!isPush && !isControl) continue;
      if (kindFilter === 'action' && !isControl) continue;
      if (kindFilter === 'push' && !isPush) continue;

      // Apply device filter
      if (deviceFilter && e.endpointId !== deviceFilter) continue;

      const deviceName = state.devices.find(d => d.id === e.endpointId || d.entityId === e.endpointId || d.applianceId === e.endpointId)?.name || e.endpointId || '—';
      let summary = '';
      if (isControl) {
        const cmd = e.payload?.command;
        summary = cmd ? `${cmd.action}${cmd.text ? ': "' + cmd.text + '"' : ''}${cmd.brightness != null ? ': ' + cmd.brightness + '%' : ''}` : e.eventType;
      } else if (isPush) {
        summary = e.payload?.command || e.eventType;
      }

      timeline.push({
        timestamp: e.timestamp,
        kind: isPush ? 'push' : 'action',
        device: deviceName,
        summary,
        detail: e.payload || e,
      });
    }
  }

  // Sort by timestamp descending (most recent first)
  timeline.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const page = timeline.slice(0, 100);

  // Populate device filter dropdown
  const deviceSelect = document.getElementById('event-device-filter');
  const currentVal = deviceSelect.value;
  const knownDeviceIds = new Set();
  for (const item of timeline) {
    if (item.detail?.deviceId) knownDeviceIds.add(item.detail.deviceId);
  }
  const deviceOptions = '<option value="">All Devices</option>' +
    state.devices
      .filter(d => knownDeviceIds.has(d.applianceId || d.id) || knownDeviceIds.has(d.id))
      .map(d => `<option value="${escapeHtml(d.applianceId || d.id)}" ${currentVal === (d.applianceId || d.id) ? 'selected' : ''}>${escapeHtml(d.name)}</option>`)
      .join('');
  deviceSelect.innerHTML = deviceOptions;

  if (page.length === 0) {
    table.innerHTML = '<div class="empty-state"><p>No device events found</p><p class="text-muted">Control a device or poll states to generate timeline entries.</p></div>';
    pagination.innerHTML = '';
    return;
  }

  const kindBadge = (kind) => {
    if (kind === 'state') return '<span class="log-type-badge state">State</span>';
    if (kind === 'action') return '<span class="log-type-badge action">Action</span>';
    if (kind === 'push') return '<span class="log-type-badge push">Push</span>';
    return '';
  };

  table.innerHTML = `
    <div class="log-row header events-row">
      <span>Timestamp</span><span>Kind</span><span>Device</span><span>Details</span>
    </div>
    ${page.map(e => `
      <div class="log-row events-row">
        <span class="log-timestamp">${formatDateTime(e.timestamp)}</span>
        <span>${kindBadge(e.kind)}</span>
        <span style="color:var(--text-secondary);font-size:0.8rem">${escapeHtml(e.device)}</span>
        <span class="log-payload" onclick="togglePayload(this)" title="Click to expand">${escapeHtml(e.summary.substring(0, 120))}</span>
      </div>
    `).join('')}
  `;

  pagination.innerHTML = `<span class="pagination-info">${page.length}${timeline.length > page.length ? ' of ' + timeline.length : ''} events</span>`;
}

// ---------------------------------------------------------------------------
// Logs Tab — Activity History
// ---------------------------------------------------------------------------

async function loadActivity(nextToken) {
  const table = document.getElementById('activity-table');
  const pagination = document.getElementById('activity-pagination');

  const range = getActiveTimeRange(document.querySelector('#subtab-activity .time-range-buttons'));
  const startTime = getTimeRange(range);
  const search = document.getElementById('activity-search')?.value || '';

  const params = {
    type: 'get_activity_history',
    maxRecords: 50,
  };
  if (startTime) params.startTimestamp = new Date(startTime).getTime();
  if (nextToken) params.nextToken = nextToken;

  const result = await api(params);

  if (!result.success) {
    table.innerHTML = `<div class="empty-state"><p>Failed to load activity</p><p class="text-muted">${escapeHtml(result.error)}</p></div>`;
    return;
  }

  let records = result.data.records || [];
  state.activityNextToken = result.data.nextToken;

  // Client-side search filter
  if (search) {
    const q = search.toLowerCase();
    records = records.filter(r =>
      (r.utteranceText && r.utteranceText.toLowerCase().includes(q)) ||
      (r.responseText && r.responseText.toLowerCase().includes(q)) ||
      (r.deviceName && r.deviceName.toLowerCase().includes(q))
    );
  }

  if (records.length === 0) {
    table.innerHTML = '<div class="empty-state"><p>No activity found</p></div>';
    pagination.innerHTML = '';
    return;
  }

  table.innerHTML = `
    <div class="log-row header activity-row">
      <span>Timestamp</span><span>Device</span><span>Utterance</span><span>Response</span>
    </div>
    ${records.map(r => `
      <div class="log-row activity-row">
        <span class="log-timestamp">${formatDateTime(r.timestamp)}</span>
        <span style="color:var(--text-secondary);font-size:0.8rem">${escapeHtml(r.deviceName || r.deviceSerial || 'Unknown')}</span>
        <span class="log-utterance">${escapeHtml(r.utteranceText || '—')}</span>
        <span class="log-response">${escapeHtml(r.responseText || '—')}</span>
      </div>
    `).join('')}
  `;

  pagination.innerHTML = `
    <span class="pagination-info">${records.length} records</span>
    ${state.activityNextToken ? `<button class="btn btn-sm btn-secondary" onclick="loadActivity('${escapeHtml(state.activityNextToken)}')">Next &raquo;</button>` : ''}
  `;
}

// ---------------------------------------------------------------------------
// Logs Tab — Push Events
// ---------------------------------------------------------------------------

async function loadPushEvents(offset = 0) {
  const table = document.getElementById('push-events-table');
  const pagination = document.getElementById('push-events-pagination');

  const range = getActiveTimeRange(document.querySelector('#subtab-push-events .time-range-buttons'));
  const startTime = getTimeRange(range);
  const command = document.getElementById('push-event-command-filter').value;

  const params = {
    type: 'query_push_events',
    limit: 50,
    offset,
  };
  if (startTime) params.startTime = startTime;
  if (command) params.command = command;

  state.pushEventsOffset = offset;

  const result = await api(params);

  if (!result.success) {
    table.innerHTML = `<div class="empty-state"><p>Failed to load push events</p><p class="text-muted">${escapeHtml(result.error)}</p></div>`;
    return;
  }

  const events = result.data.events || [];
  const totalCount = result.data.totalCount || 0;

  if (events.length === 0) {
    table.innerHTML = '<div class="empty-state"><p>No push events found</p></div>';
    pagination.innerHTML = '';
    return;
  }

  table.innerHTML = `
    <div class="log-row header push-row">
      <span>Timestamp</span><span>Command</span><span>Device</span><span>Payload</span>
    </div>
    ${events.map(e => `
      <div class="log-row push-row">
        <span class="log-timestamp">${formatDateTime(e.timestamp)}</span>
        <span><span class="log-type-badge push">${escapeHtml(e.command)}</span></span>
        <span style="color:var(--text-secondary);font-size:0.8rem">${escapeHtml(e.deviceSerial || e.deviceName || '—')}</span>
        <span class="log-payload" onclick="togglePayload(this)" title="Click to expand">${escapeHtml(JSON.stringify(e.payload || {}).substring(0, 100))}</span>
      </div>
    `).join('')}
  `;

  const hasMore = offset + events.length < totalCount;
  pagination.innerHTML = `
    <span class="pagination-info">Showing ${offset + 1}–${offset + events.length} of ${totalCount}</span>
    ${offset > 0 ? `<button class="btn btn-sm btn-secondary" onclick="loadPushEvents(${Math.max(0, offset - 50)})">&laquo; Prev</button>` : ''}
    ${hasMore ? `<button class="btn btn-sm btn-secondary" onclick="loadPushEvents(${offset + 50})">Next &raquo;</button>` : ''}
  `;
}

function togglePayload(el) {
  if (el.classList.contains('expanded')) {
    el.classList.remove('expanded');
    el.style.whiteSpace = '';
    // Restore truncated view
    const text = el.getAttribute('data-raw');
    if (text) el.textContent = text.substring(0, 100);
  } else {
    // Save raw and expand
    const raw = el.textContent;
    el.setAttribute('data-raw', raw);
    try {
      const parsed = JSON.parse(raw);
      el.textContent = JSON.stringify(parsed, null, 2);
    } catch {
      // Leave as-is
    }
    el.classList.add('expanded');
  }
}

// ---------------------------------------------------------------------------
// Live Events Tab
// ---------------------------------------------------------------------------

function addLiveEvent(event) {
  const feed = document.getElementById('live-feed');
  if (!feed) return;

  // Apply filters
  const commandFilter = document.getElementById('live-command-filter')?.value;
  const deviceFilter = document.getElementById('live-device-filter')?.value?.toLowerCase();

  const command = event.payload?.command || event.eventType || '';
  const device = event.endpointId || '';

  if (commandFilter && !command.includes(commandFilter)) return;
  if (deviceFilter && !device.toLowerCase().includes(deviceFilter)) return;

  // Remove empty state
  const emptyState = feed.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const card = document.createElement('div');
  const commandClass = event.payload?.command || event.eventType || '';
  card.className = `live-event-card ${escapeHtml(commandClass)}`;
  card.innerHTML = `
    <div class="live-event-header">
      <span class="live-event-time">${formatTime(event.timestamp)}</span>
      <span class="live-event-command">${escapeHtml(command)}</span>
      ${device ? `<span class="live-event-device">${escapeHtml(device)}</span>` : ''}
    </div>
    <div class="live-event-payload" onclick="togglePayload(this)">${escapeHtml(JSON.stringify(event.payload || {}).substring(0, 150))}</div>
  `;

  feed.prepend(card);

  // Cap at 200
  while (feed.children.length > 200) {
    feed.removeChild(feed.lastChild);
  }

  // Update count
  document.getElementById('live-event-count').textContent = `${state.liveEvents.length} events`;
}

async function togglePushListener() {
  const btn = document.getElementById('push-toggle-btn');
  btn.disabled = true;

  if (state.pushStatus.connected) {
    btn.textContent = 'Disconnecting...';
    await api({ type: 'stop_push_listener' });
    showToast('Push listener disconnected', 'info');
  } else {
    btn.textContent = 'Connecting...';
    const result = await api({ type: 'start_push_listener' });
    if (result.success) {
      showToast('Push listener connected', 'success');
    } else {
      showToast(result.error || 'Failed to connect', 'error');
    }
  }

  // Status will be updated by SSE push-status heartbeat
  setTimeout(() => checkPushStatus(), 1000);
}

function toggleLivePause() {
  state.livePaused = !state.livePaused;
  const btn = document.getElementById('live-pause-btn');
  btn.textContent = state.livePaused ? '\u{25B6} Resume' : '\u{23F8} Pause';
  btn.className = state.livePaused ? 'btn btn-success' : 'btn btn-secondary';
}

function clearLiveFeed() {
  const feed = document.getElementById('live-feed');
  feed.innerHTML = '<div class="empty-state"><p>Feed cleared</p></div>';
  state.liveEvents = [];
  state.liveEventCount = 0;
  document.getElementById('live-event-count').textContent = '0 events';
  const badge = document.getElementById('live-count');
  badge.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Event Listeners Setup
// ---------------------------------------------------------------------------

function setupEventListeners() {
  // Device filters
  document.getElementById('device-search').addEventListener('input', renderDeviceGrid);
  document.getElementById('device-source-filter').addEventListener('change', renderDeviceGrid);
  document.getElementById('device-type-filter').addEventListener('change', renderDeviceGrid);
  document.getElementById('device-group-filter').addEventListener('change', renderDeviceGrid);
  document.getElementById('device-refresh-btn').addEventListener('click', () => {
    tabInitialized.devices = false;
    loadDevices();
  });
  document.getElementById('device-poll-btn').addEventListener('click', pollAllStates);
  document.getElementById('device-edit-btn').addEventListener('click', toggleEditMode);

  // Routine refresh and create
  document.getElementById('routine-refresh-btn').addEventListener('click', () => {
    tabInitialized.routines = false;
    loadRoutines();
  });
  document.getElementById('routine-create-btn').addEventListener('click', () => toggleRoutineForm(true));
  document.getElementById('routine-cancel-btn').addEventListener('click', () => toggleRoutineForm(false));
  document.getElementById('routine-save-btn').addEventListener('click', saveRoutine);

  // Modal close
  document.getElementById('modal-close').addEventListener('click', closeDeviceModal);
  document.querySelector('.modal-backdrop').addEventListener('click', closeDeviceModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDeviceModal();
  });

  // Log sub-tabs
  document.querySelectorAll('.sub-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.subtab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`subtab-${tab.dataset.subtab}`).classList.add('active');

      // Load data for sub-tab
      switch (tab.dataset.subtab) {
        case 'events': loadEvents(); break;
        case 'activity': loadActivity(); break;
        case 'push-events': loadPushEvents(); break;
      }
    });
  });

  // Time range buttons
  document.querySelectorAll('.time-range-buttons').forEach(group => {
    group.querySelectorAll('.time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Reload the current sub-tab
        const panel = btn.closest('.subtab-panel');
        if (panel?.id === 'subtab-events') loadEvents();
        else if (panel?.id === 'subtab-activity') loadActivity();
        else if (panel?.id === 'subtab-push-events') loadPushEvents();
      });
    });
  });

  // Events refresh and filters
  document.getElementById('events-refresh-btn').addEventListener('click', () => loadEvents());
  document.getElementById('event-device-filter').addEventListener('change', () => loadEvents());
  document.getElementById('event-kind-filter').addEventListener('change', () => loadEvents());

  // Activity refresh and search
  document.getElementById('activity-refresh-btn').addEventListener('click', () => loadActivity());
  document.getElementById('activity-search').addEventListener('input', debounce(() => loadActivity(), 300));

  // Push events refresh and filter
  document.getElementById('push-events-refresh-btn').addEventListener('click', () => loadPushEvents());
  document.getElementById('push-event-command-filter').addEventListener('change', () => loadPushEvents());

  // Auto-refresh
  let autoRefreshInterval = null;
  document.getElementById('events-auto-refresh').addEventListener('change', (e) => {
    if (e.target.checked) {
      autoRefreshInterval = setInterval(() => {
        const activeSubTab = document.querySelector('.sub-tab.active')?.dataset.subtab;
        if (activeSubTab === 'events') loadEvents();
        else if (activeSubTab === 'activity') loadActivity();
        else if (activeSubTab === 'push-events') loadPushEvents(state.pushEventsOffset);
      }, 10000);
    } else {
      clearInterval(autoRefreshInterval);
    }
  });

  // Live events controls
  document.getElementById('push-toggle-btn').addEventListener('click', togglePushListener);
  document.getElementById('live-pause-btn').addEventListener('click', toggleLivePause);
  document.getElementById('live-clear-btn').addEventListener('click', clearLiveFeed);

  // Live events filters (re-apply on change)
  document.getElementById('live-command-filter').addEventListener('change', () => {});
  document.getElementById('live-device-filter').addEventListener('input', () => {});

  // Tab badge clear on visiting live tab
  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#live') {
      state.liveEventCount = 0;
      const badge = document.getElementById('live-count');
      badge.classList.add('hidden');
    }
  });
}

function debounce(fn, ms) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  loadCustomGroups();
  setupEventListeners();

  // Check statuses
  await Promise.all([checkCookieStatus(), checkPushStatus(), checkAutoPollStatus()]);

  // Connect SSE
  connectSSE();

  // Navigate to initial tab
  const hash = window.location.hash.slice(1);
  navigateTab(hash || 'devices');
}

// Start
document.addEventListener('DOMContentLoaded', init);
