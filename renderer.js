// ── State ─────────────────────────────────────────────────────────────────────
var clientOrder = [];   // ordered list of clientIds as they arrive
var clientMeta = {};   // clientId → { color, entries[], countEl }
var CLIENT_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
var colorIndex = 0;

var paused = false;
var buffer = [];
var activeFilters = { log: true, warning: true, error: true, network: true };
var autoScroll = true;

// ── Grid state ────────────────────────────────────────────────────────────────
// rows[] is the single source of truth for what's rendered.
// Each row: { snapKey: string|null, minTimestamp: number, cells: { clientId: entry } }
var rows = [];

// snapIndex: snapKey → row index in rows[]
// Used to find an existing snap row to merge into
var snapIndex = {};

var snapWindowMs = 1000;
var sessionStartTimestamp = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
var colsWrapper = document.getElementById('columns-wrapper');
var headersEl = document.getElementById('grid-headers');
var gridEl = document.getElementById('grid-body');
var gridScroll = document.getElementById('grid-scroll');
var emptyState = document.getElementById('empty');
var pausedBanner = document.getElementById('paused-banner');
var jumpBtn = document.getElementById('jump-to-bottom');

// ── Auto-scroll detection ─────────────────────────────────────────────────────
var scrollTimeout = null;
gridScroll.addEventListener('scroll', function () {
    // Debounce scroll detection
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(function () {
        var atBottom = gridScroll.scrollHeight - gridScroll.scrollTop - gridScroll.clientHeight < 50;
        if (atBottom) {
            autoScroll = true;
            updateJumpButton();
        } else if (autoScroll) {
            autoScroll = false;
            updateJumpButton();
        }
    }, 100);
});

function updateJumpButton() {
    if (autoScroll || rows.length === 0) {
        jumpBtn.classList.remove('visible');
    } else {
        jumpBtn.classList.add('visible');
    }
}

function jumpToBottom() {
    autoScroll = true;
    gridScroll.scrollTop = gridScroll.scrollHeight;
    updateJumpButton();
}

function scrollToBottomIfEnabled() {
    if (autoScroll) {
        gridScroll.scrollTop = gridScroll.scrollHeight;
    }
}

// ── IPC ───────────────────────────────────────────────────────────────────────
window.chorus.onLogEntry(function (entry) {
    if (paused) { buffer.push(entry); return; }
    processEntry(entry);
});

// ── Entry processing ──────────────────────────────────────────────────────────
function processEntry(entry) {
    if (entry.eventType === 'rename' && entry.newClientId) {
        renameClient(entry.clientId, entry.newClientId);
        return;
    }

    if (sessionStartTimestamp === null) sessionStartTimestamp = entry.timestamp;
    entry.elapsed = entry.timestamp - sessionStartTimestamp;

    ensureClient(entry.clientId);
    clientMeta[entry.clientId].entries.push(entry);
    clientMeta[entry.clientId].countEl.textContent = clientMeta[entry.clientId].entries.length;

    // Place into a grid row
    var rowIdx = placeEntryInRow(entry);

    // Render just this row (fast path for live updates)
    renderRow(rowIdx);

    // Auto-scroll to bottom if enabled
    scrollToBottomIfEnabled();
}

// ── Row placement ─────────────────────────────────────────────────────────────
function placeEntryInRow(entry) {
    var snapKey = extractSnapKey(entry.message);

    if (snapKey) {
        var existing = snapIndex[snapKey];
        if (existing !== undefined) {
            var row = rows[existing];
            if ((entry.timestamp - row.minTimestamp) <= snapWindowMs) {
                // Join existing snap row
                if (!row.cells[entry.clientId]) {
                    row.cells[entry.clientId] = entry;
                    row.minTimestamp = Math.min(row.minTimestamp, entry.timestamp);
                }
                return existing;
            }
        }
        // New snap row
        var idx = rows.length;
        rows.push({ snapKey: snapKey, minTimestamp: entry.timestamp, cells: {} });
        rows[idx].cells[entry.clientId] = entry;
        snapIndex[snapKey] = idx;
        return idx;
    }

    // Non-snapped — always its own row
    var idx = rows.length;
    rows.push({ snapKey: null, minTimestamp: entry.timestamp, cells: {} });
    rows[idx].cells[entry.clientId] = entry;
    return idx;
}

// ── Snap key extraction ───────────────────────────────────────────────────────
var PS_PREFIX_RE = /^\[PS:[A-Z]+\]\s+(\S+)(.*)/;
var KV_RE = /([\w]+)=([^\s|]+)/g;
var IGNORED_KEYS = { t: true };

// Events that fire every tick or are otherwise too frequent to snap usefully.
// These will each get their own row and never align across columns.
var SNAP_BLOCKLIST = {
    'GameLoop_Tick': true,
};

function extractSnapKey(message) {
    var m = message.match(PS_PREFIX_RE);
    if (!m) return null;

    var eventName = m[1];
    if (SNAP_BLOCKLIST[eventName]) return null;

    var rest = m[2] || '';
    var pairs = [];
    var kv;
    KV_RE.lastIndex = 0;
    while ((kv = KV_RE.exec(rest)) !== null) {
        if (!IGNORED_KEYS[kv[1]]) pairs.push(kv[1] + '=' + kv[2]);
    }
    pairs.sort();
    return pairs.length > 0 ? eventName + '|' + pairs.join('|') : eventName;
}

// ── Client management ─────────────────────────────────────────────────────────
function ensureClient(id) {
    if (clientMeta[id]) return;

    var color = CLIENT_COLORS[colorIndex % CLIENT_COLORS.length];
    colorIndex++;

    clientOrder.push(id);
    clientMeta[id] = { color: color, entries: [] };

    emptyState.style.display = 'none';

    // Add header cell
    var hCell = document.createElement('div');
    hCell.className = 'grid-header-cell';
    hCell.id = 'hcell-' + id;

    var dot = document.createElement('div');
    dot.className = 'col-dot';
    dot.style.background = color;

    var name = document.createElement('div');
    name.className = 'col-name';
    name.textContent = id;
    name.style.color = color;

    var count = document.createElement('div');
    count.className = 'col-count';
    count.textContent = '0';
    clientMeta[id].countEl = count;

    hCell.appendChild(dot);
    hCell.appendChild(name);
    hCell.appendChild(count);
    headersEl.appendChild(hCell);

    // Update grid column template
    updateGridColumns();
    updateStatus();

    // Re-render all existing rows to add the new empty cell column
    renderAllRows();
}

function renameClient(oldId, newId) {
    if (!clientMeta[oldId]) return;

    // Update metadata
    clientMeta[newId] = clientMeta[oldId];
    delete clientMeta[oldId];

    var idx = clientOrder.indexOf(oldId);
    if (idx !== -1) clientOrder[idx] = newId;

    // Update all row cells
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].cells[oldId] !== undefined) {
            rows[i].cells[newId] = rows[i].cells[oldId];
            rows[i].cells[newId].clientId = newId;
            delete rows[i].cells[oldId];
        }
    }

    // Update header DOM
    var hCell = document.getElementById('hcell-' + oldId);
    if (hCell) {
        hCell.id = 'hcell-' + newId;
        hCell.querySelector('.col-name').textContent = newId;
    }

    // Flash header
    if (hCell) {
        hCell.style.transition = 'background 0.15s';
        hCell.style.background = '#1a2a1a';
        setTimeout(function () { hCell.style.background = ''; }, 600);
    }

    renderAllRows();
}

function updateGridColumns() {
    // Set CSS grid template — one column per client, plus a leading time column
    var template = '60px ' + clientOrder.map(function () { return '1fr'; }).join(' ');
    gridEl.style.gridTemplateColumns = template;
    headersEl.style.gridTemplateColumns = '60px ' + clientOrder.map(function () { return '1fr'; }).join(' ');
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderAllRows() {
    gridEl.innerHTML = '';
    for (var i = 0; i < rows.length; i++) {
        renderRow(i);
    }
    // Re-apply search highlights after a full re-render
    var input = document.getElementById('search-input');
    if (input && input.value.trim()) runSearch(input.value.trim());
}

function renderRow(rowIdx) {
    var row = rows[rowIdx];

    // Check if any cell in this row passes the active filter
    var hasVisible = false;
    var clientIds = Object.keys(row.cells);
    for (var i = 0; i < clientIds.length; i++) {
        if (activeFilters[row.cells[clientIds[i]].eventType]) { hasVisible = true; break; }
    }
    if (!hasVisible) return;

    // Check if row DOM already exists — if so, update it
    var existingRowEl = gridEl.querySelector('[data-row-idx="' + rowIdx + '"]');
    var isNew = !existingRowEl;

    // Time cell — shows the earliest timestamp in this row
    var timeEl = isNew ? document.createElement('div') : existingRowEl.querySelector('.grid-time');
    timeEl.className = 'grid-time';
    timeEl.textContent = formatElapsed(row.minTimestamp - (sessionStartTimestamp || row.minTimestamp));

    if (isNew) {
        // Build a full row wrapper
        var rowEl = document.createElement('div');
        rowEl.className = 'grid-row' + (row.snapKey ? ' is-snapped' : '');
        rowEl.dataset.rowIdx = rowIdx;
        rowEl.appendChild(timeEl);

        // One cell per client in order
        for (var i = 0; i < clientOrder.length; i++) {
            var cid = clientOrder[i];
            var entry = row.cells[cid];
            var cell = buildCell(entry, clientMeta[cid]);
            cell.dataset.clientId = cid;
            rowEl.appendChild(cell);
        }

        gridEl.appendChild(rowEl);
    } else {
        // Row exists — a new client just joined this snap row, update its cell
        for (var i = 0; i < clientOrder.length; i++) {
            var cid = clientOrder[i];
            var entry = row.cells[cid];
            var existing = existingRowEl.querySelector('[data-client-id="' + cid + '"]');
            if (existing) {
                var newCell = buildCell(entry, clientMeta[cid]);
                newCell.dataset.clientId = cid;
                existingRowEl.replaceChild(newCell, existing);
          }
      }
    }
}

function buildCell(entry, meta) {
    var cell = document.createElement('div');

    if (!entry) {
        // Empty cell — this client had no log for this snap row
        cell.className = 'grid-cell empty';
        return cell;
    }

    cell.className = 'grid-cell type-' + entry.eventType;

    var tagColor = getTagColor(entry.message);
    if (tagColor) cell.style.borderLeftColor = tagColor;

    // Tag badge
    if (tagColor) {
        var tagM = entry.message.match(TAG_RE);
        var badge = document.createElement('span');
        badge.className = 'log-tag';
        badge.textContent = tagM[1];
        badge.style.color = tagColor;
        badge.style.borderColor = tagColor;
        cell.appendChild(badge);
    }

    var msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = stripTagsForDisplay(entry.message);
    if (tagColor) msg.style.color = tagColor;
    cell.appendChild(msg);

    return cell;
}

// ── Tag colours ───────────────────────────────────────────────────────────────
var TAG_COLORS = {
    'NETWORK': '#4fc3f7',
    'STATE': '#a78bfa',
    'INIT': '#34d399',
    'RECONNECT': '#fb923c',
};
var TAG_RE = /^\[PS:([A-Z]+)\]\s*/;
var TIMESTAMP_RE = /\s*\|\s*t=[\d.]+$/;

function getTagColor(message) {
    var m = message.match(TAG_RE);
    return m ? (TAG_COLORS[m[1]] || null) : null;
}

function stripTagsForDisplay(message) {
    return message.replace(TAG_RE, '').replace(TIMESTAMP_RE, '').trim();
}

// ── Elapsed formatting ────────────────────────────────────────────────────────
function formatElapsed(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    var rem = Math.floor((ms % 1000) / 10);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') + '.' + String(rem).padStart(2, '0');
}

// ── Controls ──────────────────────────────────────────────────────────────────
function togglePause() {
    paused = !paused;
    var btn = document.getElementById('btn-pause');
    btn.textContent = paused ? 'Resume' : 'Pause';
    btn.classList.toggle('active', paused);
    if (paused) {
        pausedBanner.classList.add('visible');
    } else {
        pausedBanner.classList.remove('visible');
        for (var i = 0; i < buffer.length; i++) processEntry(buffer[i]);
        buffer = [];
    }
}

function newSession() {
    clientOrder = [];
    clientMeta = {};
    colorIndex = 0;
    rows = [];
    snapIndex = {};
    buffer = [];
    sessionStartTimestamp = null;
    autoScroll = true;
    gridEl.innerHTML = '';
    headersEl.innerHTML = '';
    updateJumpButton();
    // Re-add the time header placeholder
    var timeHeader = document.createElement('div');
    timeHeader.className = 'grid-header-cell time-header';
    timeHeader.textContent = 'time';
    headersEl.appendChild(timeHeader);
    gridEl.style.gridTemplateColumns = '';
    headersEl.style.gridTemplateColumns = '';
    emptyState.style.display = '';
    var el = document.getElementById('status-indicator');
    el.textContent = 'waiting for clients...';
    el.className = 'status';
}

function clearAll() {
    // Keep columns, wipe entries and rows
    for (var i = 0; i < clientOrder.length; i++) {
        var meta = clientMeta[clientOrder[i]];
        meta.entries = [];
        meta.countEl.textContent = '0';
    }
    rows = [];
    snapIndex = {};
    buffer = [];
    sessionStartTimestamp = null;
    autoScroll = true;
    gridEl.innerHTML = '';
    updateJumpButton();
}

function toggleFilter(pill) {
    var type = pill.dataset.type;
    activeFilters[type] = !activeFilters[type];
    pill.className = activeFilters[type] ? 'pill active-' + type : 'pill';
    renderAllRows();
}

function setSnapWindow(ms) {
    snapWindowMs = ms;
}

function updateStatus() {
    var n = clientOrder.length;
    var el = document.getElementById('status-indicator');
    el.textContent = n + ' client' + (n !== 1 ? 's' : '') + ' connected';
    el.className = 'status live';
}

// ── Save session ──────────────────────────────────────────────────────────────
async function saveSession() {
    var sessionData = { version: 2, savedAt: Date.now(), clients: {} };
    for (var i = 0; i < clientOrder.length; i++) {
        var id = clientOrder[i];
        sessionData.clients[id] = {
            color: clientMeta[id].color,
            entries: clientMeta[id].entries
        };
    }
    var result = await window.chorus.saveSession(sessionData);
    if (result.ok) flashStatus('Session saved');
}

// ── Load session ──────────────────────────────────────────────────────────────
async function loadSession() {
    var data = await window.chorus.loadSession();
    if (!data) return;

    newSession();

    // Collect and sort all entries globally by timestamp
    var all = [];
    var ids = Object.keys(data.clients);
    for (var i = 0; i < ids.length; i++) {
        var entries = data.clients[ids[i]].entries;
        for (var j = 0; j < entries.length; j++) {
            all.push({ clientId: ids[i], entry: entries[j], color: data.clients[ids[i]].color });
        }
    }
    all.sort(function (a, b) { return a.entry.timestamp - b.entry.timestamp; });

    if (!all.length) return;

    sessionStartTimestamp = all[0].entry.timestamp;

    // Register all clients first so grid columns are complete before rendering
    for (var i = 0; i < ids.length; i++) {
        if (!clientMeta[ids[i]]) {
            ensureClientWithColor(ids[i], data.clients[ids[i]].color);
        }
    }

    // Place all entries into rows
    for (var i = 0; i < all.length; i++) {
        var item = all[i];
        var entry = item.entry;
        entry.elapsed = entry.timestamp - sessionStartTimestamp;

        if (entry.eventType === 'rename' && entry.newClientId) continue;

        clientMeta[item.clientId].entries.push(entry);
        clientMeta[item.clientId].countEl.textContent = clientMeta[item.clientId].entries.length;
        placeEntryInRow(entry);
    }

    renderAllRows();
    scrollToBottomIfEnabled();
    flashStatus('Session loaded');
}

// ── Load browser .log files ───────────────────────────────────────────────────
async function loadLogFiles() {
    var files = await window.chorus.loadLogFiles();
    if (!files) return;

    newSession();
    files.sort(function (a, b) { return a.clientId.localeCompare(b.clientId); });

    // Parse all files first
    var all = [];
    for (var i = 0; i < files.length; i++) {
        var entries = parseChromeLog(files[i].content, files[i].clientId);
        for (var j = 0; j < entries.length; j++) {
            all.push({ clientId: files[i].clientId, entry: entries[j] });
        }
    }
    all.sort(function (a, b) { return a.entry.timestamp - b.entry.timestamp; });
    if (!all.length) return;

    sessionStartTimestamp = all[0].entry.timestamp;

    // Register ALL clients first so grid column template is complete
    // before any rows are placed or rendered
    for (var i = 0; i < files.length; i++) {
        ensureClient(files[i].clientId);
    }

    // Now place all entries into rows
    for (var i = 0; i < all.length; i++) {
        var item = all[i];
        var entry = item.entry;
        entry.elapsed = entry.timestamp - sessionStartTimestamp;
        clientMeta[item.clientId].entries.push(entry);
        clientMeta[item.clientId].countEl.textContent = clientMeta[item.clientId].entries.length;
        placeEntryInRow(entry);
    }

    // Render once everything is ready
    renderAllRows();
    scrollToBottomIfEnabled();
    flashStatus(files.length + ' log file(s) loaded');
}

// ── Chrome log parser ─────────────────────────────────────────────────────────
// Handles Chrome DevTools saved log format:
//   HH:MM:SS.mmm  filename.js:N  message      ← timestamped line
//   filename.js:N  message                     ← no timestamp (continuation)
//   _fnName @ filename.js:N                    ← stack frame, skip
//   (blank line)                               ← skip

// Matches any timestamped line in Chrome DevTools exports.
// Three formats exist in the wild:
//   "HH:MM:SS.mmm  filename.js:N  message"   (ts + source prefix)
//   "HH:MM:SS.mmm  message"                  (ts + 2 spaces, no source prefix)
//   "HH:MM:SS.mmm message"                   (ts + 1 space, no source prefix)
// Strategy: match the timestamp, then optionally strip a source prefix,
// then take whatever remains as the message.
var CHROME_TS_RE = /^(\d{2}:\d{2}:\d{2}\.\d+)\s+(.*)/;
var CHROME_SOURCE_STRIP = /^\S+\.js:\d+\s+/;
var CHROME_STACK_FRAME_RE = /^\S+\s*@\s*\S+\.js:\d+/;

// Lines matching these patterns are skipped during Chrome log import —
// they are Unity/WebGL boot noise with no debugging value.
var CHROME_NOISE_RES = [
    /^\[UnityMemory\]/,
    /^"memorysetup-/,
    /^\[UnityCache\]/,
    /^\[Subsystems\]/,
    /^\[Physics::/,
    /^Trying to get length of sound/,
    /^The AudioContext was not allowed/,
    /^WebGL: INVALID_ENUM/,
    /^OPENGL LOG:/,
    /^Renderer:/,
    /^Vendor:/,
    /^Version:/,
    /^GLES:/,
    /^EXT_|^GL_|^OES_|^NV_|^WEBGL_|^KHR_/,
    /^Manual synchronization of Unity/,
    /^_JS_FileSystem_Sync/,
    /^Loading player data/,
    /^Initialize engine version/,
    /^Creating WebGL/,
    /^Input Manager initialize/,
    /^UnloadTime:/,
    /^Unloading \d+ Unused Serialized/,
    /^Unloading \d+ unused Assets/,
    /^Total: [\d.]+ ms \(FindLiveObjects/,
    /^texture_compression_/,  // wrapped GL extension string continuation
    /^sion_/,                  // another GL extension continuation fragment
];

function isChromeNoise(message) {
    for (var i = 0; i < CHROME_NOISE_RES.length; i++) {
        if (CHROME_NOISE_RES[i].test(message)) return true;
    }
    return false;
}

function parseTimestampToMs(ts) {
    // "HH:MM:SS.mmm" → ms since midnight
    var parts = ts.split(/[:.]/)
    return parseInt(parts[0]) * 3600000
        + parseInt(parts[1]) * 60000
        + parseInt(parts[2]) * 1000
        + parseInt((parts[3] || '0').padEnd(3, '0').slice(0, 3));
}

function parseChromeLog(content, clientId) {
    var lines = content.split(/\r?\n/);
    var entries = [];
    var lastMs = null;   // ms-since-midnight of last timestamped line
    var fallbackIndex = 0;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];  // do NOT trim — leading spaces matter for continuation
        var trimmed = line.trim();

        if (!trimmed) continue;
        if (CHROME_STACK_FRAME_RE.test(trimmed)) continue;

        var message = null;
        var ms = null;

        var m = CHROME_TS_RE.exec(trimmed);
        if (m) {
            // Timestamped line — strip optional source prefix from the rest
            ms = parseTimestampToMs(m[1]);
            message = m[2].replace(CHROME_SOURCE_STRIP, '').trim();
            lastMs = ms;
        } else {
            // No timestamp — skip (these are continuation lines we can't place)
            continue;
        }

        if (!message) continue;
        if (isChromeNoise(message)) continue;

        // Convert ms-since-midnight to a comparable epoch value.
        // We use a fixed date base so cross-file timestamps align correctly.
        var timestamp = ms;  // loadLogFiles will normalise to session start

        entries.push({
            clientId: clientId,
            timestamp: timestamp,
            elapsed: 0,  // filled by loadLogFiles after global sort
            logType: classifyLogType(message),
            eventType: classifyEventType(message),
            message: message,
        });

        fallbackIndex++;
    }

    return entries;
}

function classifyLogType(message) {
    var lower = message.toLowerCase();
    if (lower.includes('error') || lower.includes('exception')) return 'Error';
    if (lower.includes('warning') || lower.includes('warn')) return 'Warning';
    return 'Log';
}

function classifyEventType(message) {
    var lower = message.toLowerCase();
    if (message.match(/^\[PS:[A-Z]+\]/)) {
        if (lower.includes('error') || lower.includes('exception')) return 'error';
        if (lower.includes('warning') || lower.includes('warn')) return 'warning';
        return 'network';
    }
    if (lower.includes('error') || lower.includes('exception')) return 'error';
    if (lower.includes('warning') || lower.includes('warn')) return 'warning';
    return 'log';
}

// ── ensureClientWithColor ─────────────────────────────────────────────────────
function ensureClientWithColor(id, color) {
    if (clientMeta[id]) return;

    clientOrder.push(id);
    clientMeta[id] = { color: color, entries: [] };

    emptyState.style.display = 'none';

    var hCell = document.createElement('div');
    hCell.className = 'grid-header-cell';
    hCell.id = 'hcell-' + id;

    var dot = document.createElement('div');
    dot.className = 'col-dot';
    dot.style.background = color;

    var name = document.createElement('div');
    name.className = 'col-name';
    name.textContent = id;
    name.style.color = color;

    var count = document.createElement('div');
    count.className = 'col-count';
    count.textContent = '0';
    clientMeta[id].countEl = count;

    hCell.appendChild(dot);
    hCell.appendChild(name);
    hCell.appendChild(count);
    headersEl.appendChild(hCell);

    updateGridColumns();
    updateStatus();
}

// ── Status flash ──────────────────────────────────────────────────────────────
function flashStatus(msg) {
    var el = document.getElementById('status-indicator');
    var prev = el.textContent;
    el.textContent = '✓ ' + msg;
    setTimeout(function () { el.textContent = prev; }, 2500);
}

// ── Search ────────────────────────────────────────────────────────────────────
var searchMatches = [];   // array of .grid-row elements that match
var searchCurrent = -1;   // index into searchMatches of active match

document.addEventListener('keydown', function (e) {
    // Ctrl+F — open search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        openSearch();
        return;
    }
    // Escape — close search
    if (e.key === 'Escape') {
        closeSearch();
        return;
    }
    // Enter / Shift+Enter — navigate matches when search is open
    var bar = document.getElementById('search-bar');
    if (bar.classList.contains('visible') && e.key === 'Enter') {
        e.preventDefault();
        searchNav(e.shiftKey ? -1 : 1);
    }
});

function openSearch() {
    var bar = document.getElementById('search-bar');
    var input = document.getElementById('search-input');
    bar.classList.add('visible');
    input.focus();
    input.select();
}

function closeSearch() {
    var bar = document.getElementById('search-bar');
    var input = document.getElementById('search-input');
    bar.classList.remove('visible');
    input.value = '';
    clearSearchHighlights();
    searchMatches = [];
    searchCurrent = -1;
}

document.getElementById('search-input').addEventListener('input', function () {
    runSearch(this.value.trim());
});

function runSearch(term) {
    clearSearchHighlights();
    searchMatches = [];
    searchCurrent = -1;

    if (!term) {
        updateSearchCount();
        return;
    }

    var lower = term.toLowerCase();
    var rowEls = gridEl.querySelectorAll('.grid-row');

    for (var i = 0; i < rowEls.length; i++) {
        var rowEl = rowEls[i];
        // Gather text from all non-empty cells in this row
        var cells = rowEl.querySelectorAll('.grid-cell:not(.empty)');
        var matched = false;
        for (var j = 0; j < cells.length; j++) {
            if (cells[j].textContent.toLowerCase().includes(lower)) {
                matched = true;
                break;
            }
        }
        if (matched) {
            rowEl.classList.add('search-match');
            searchMatches.push(rowEl);
        }
    }

    if (searchMatches.length > 0) {
        searchCurrent = 0;
        activateMatch(0);
    }

    updateSearchCount();
}

function searchNav(dir) {
    if (!searchMatches.length) return;
    searchMatches[searchCurrent].classList.remove('search-match-active');
    searchCurrent = (searchCurrent + dir + searchMatches.length) % searchMatches.length;
    activateMatch(searchCurrent);
    updateSearchCount();
}

function activateMatch(idx) {
    var el = searchMatches[idx];
    el.classList.add('search-match-active');
    // Scroll the first child cell into view (grid-row uses display:contents
    // so the row itself has no box — scroll via its first real child)
    var firstCell = el.querySelector('.grid-time') || el.querySelector('.grid-cell');
    if (firstCell) firstCell.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function clearSearchHighlights() {
    var marked = gridEl.querySelectorAll('.search-match, .search-match-active');
    for (var i = 0; i < marked.length; i++) {
        marked[i].classList.remove('search-match', 'search-match-active');
    }
}

function updateSearchCount() {
    var el = document.getElementById('search-count');
    if (!searchMatches.length) {
        el.textContent = document.getElementById('search-input').value ? '0 results' : '';
        return;
    }
    el.textContent = (searchCurrent + 1) + ' / ' + searchMatches.length;
}
