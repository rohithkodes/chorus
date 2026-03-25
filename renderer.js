// ── State ────────────────────────────────────────────────────────────────────
var clients = {};   // clientId → { color, entries[], colEl, logsEl, countEl }
var CLIENT_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
var colorIndex = 0;
var paused = false;
var buffer = [];
var activeFilters = { log: true, warning: true, error: true, photon: true };

// ── Snap state ───────────────────────────────────────────────────────────────
// snapWindow: how many ms apart two [PS:X] logs can be and still be considered
// the same event. Adjustable via the dashboard input.
var snapWindowMs = 1000;

// snapGroups: eventName → { timestamp, rowIndex }
// Tracks the most recent snap group for each named event so new arrivals
// can be placed at the same visual row index.
var snapGroups = {};
var sessionStartTimestamp = null;  // global zero point for elapsed across all clients

// snapRowCounter: global incrementing row index used to assign snap rows
var snapRowCounter = 0;

var colsWrapper = document.getElementById('columns-wrapper');
var emptyState = document.getElementById('empty');
var pausedBanner = document.getElementById('paused-banner');

// ── IPC ──────────────────────────────────────────────────────────────────────
window.punscope.onLogEntry(function (entry) {
    if (paused) { buffer.push(entry); return; }
    processEntry(entry);
});

// ── Entry processing ─────────────────────────────────────────────────────────
function processEntry(entry) {
    if (entry.eventType === 'rename' && entry.newClientId) {
        renameClient(entry.clientId, entry.newClientId);
        return;
    }

    // Anchor all elapsed times to the very first entry received this session
    if (sessionStartTimestamp === null) sessionStartTimestamp = entry.timestamp;
    entry.elapsed = entry.timestamp - sessionStartTimestamp;

    ensureClient(entry.clientId);
    entry._snapRow = resolveSnapRow(entry);
    appendLog(entry.clientId, entry);
}

// ── Snap logic ───────────────────────────────────────────────────────────────

// A log is snap-eligible if its message starts with [PS:SomeCategory]
// e.g. "[PS:NETWORK] OnDisconnected | cause=... | state=... | t=1.23"
//
// The snap key is: eventName + all key=value pairs EXCEPT 't' (timestamp).
// This means NetworkState_Exit|state=IdleState and
// NetworkState_Exit|state=ConnectingState get different keys and never
// incorrectly snap together, even though they share the same event name.
var PS_PREFIX_RE = /^\[PS:[A-Z]+\]\s+(\S+)(.*)/;
var KV_RE = /([\w]+)=([^\s|]+)/g;
var IGNORED_KEYS = { t: true };  // timestamp varies per client, exclude from key

function extractSnapKey(message) {
    var m = message.match(PS_PREFIX_RE);
    if (!m) return null;

    var eventName = m[1];           // e.g. "NetworkState_Exit"
    var rest = m[2] || '';     // e.g. " | state=IdleState | t=37.84"

    // Collect key=value pairs, sorted for determinism, excluding ignored keys
    var pairs = [];
    var kv;
    KV_RE.lastIndex = 0;
    while ((kv = KV_RE.exec(rest)) !== null) {
        if (!IGNORED_KEYS[kv[1]]) {
            pairs.push(kv[1] + '=' + kv[2]);
        }
    }
    pairs.sort();

    return pairs.length > 0 ? eventName + '|' + pairs.join('|') : eventName;
}

function resolveSnapRow(entry) {
    var key = extractSnapKey(entry.message);
    if (!key) return null;  // not snap-eligible

    var now = entry.timestamp;
    var existing = snapGroups[key];

    if (existing && (now - existing.timestamp) <= snapWindowMs) {
        // Within the window — join the existing snap group
        // Update timestamp so latecomers within the window still snap
        existing.timestamp = now;
        return existing.rowIndex;
    }

    // New snap group for this event name
    var rowIndex = snapRowCounter++;
    snapGroups[key] = { timestamp: now, rowIndex: rowIndex };
    return rowIndex;
}

// ── Column management ────────────────────────────────────────────────────────
function ensureClient(id) {
    if (clients[id]) return;

    var color = CLIENT_COLORS[colorIndex % CLIENT_COLORS.length];
    colorIndex++;

    emptyState.style.display = 'none';

    var col = document.createElement('div');
    col.className = 'client-col';
    col.id = 'col-' + id;

    var header = document.createElement('div');
    header.className = 'col-header';

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

    header.appendChild(dot);
    header.appendChild(name);
    header.appendChild(count);

    var logs = document.createElement('div');
    logs.className = 'col-logs';

    col.appendChild(header);
    col.appendChild(logs);
    colsWrapper.appendChild(col);

    clients[id] = { color: color, entries: [], colEl: col, logsEl: logs, countEl: count };
    updateStatus();
}

function renameClient(oldId, newId) {
    var client = clients[oldId];
    if (!client) return;

    client.colEl.querySelector('.col-name').textContent = newId;
    clients[newId] = client;
    delete clients[oldId];

    var header = client.colEl.querySelector('.col-header');
    header.style.transition = 'background 0.15s';
    header.style.background = '#1a2a1a';
    setTimeout(function () { header.style.background = ''; }, 600);
}

// ── Log rendering ────────────────────────────────────────────────────────────
function appendLog(clientId, entry) {
    var client = clients[clientId];
    if (!client) return;
    client.entries.push(entry);
    client.countEl.textContent = client.entries.length;

    if (!activeFilters[entry.eventType]) return;

    var row = buildRow(entry);
    client.logsEl.appendChild(row);

    // If this entry has a snap row, insert a spacer in all OTHER columns
    // at the same logical position so the rows stay visually aligned
    if (entry._snapRow !== null) {
        alignOtherColumns(clientId, entry._snapRow, row.offsetHeight || 22);
    }


}

// Insert an invisible spacer in columns that don't yet have a row for this
// snap group, so their logs stay vertically aligned with the snapped row
function alignOtherColumns(sourceClientId, snapRow, rowHeight) {
    var ids = Object.keys(clients);
    for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (id === sourceClientId) continue;

        var col = clients[id];
        // Check if this column already has a row for this snapRow
        var existing = col.logsEl.querySelector('[data-snap-row="' + snapRow + '"]');
        if (!existing) {
            var spacer = document.createElement('div');
            spacer.className = 'snap-spacer';
            spacer.dataset.snapRow = snapRow;
            spacer.style.height = rowHeight + 'px';
            col.logsEl.appendChild(spacer);
        }
    }
}

// ── Tag colours and display ──────────────────────────────────────────────────
var TAG_COLORS = {
    'NETWORK': '#4fc3f7',  // sky
    'STATE': '#a78bfa',  // violet
    'INIT': '#34d399',  // emerald
    'RECONNECT': '#fb923c',  // amber
};
var TAG_RE = /^\[PS:([A-Z]+)\]\s*/;
var TIMESTAMP_RE = /\s*\|\s*t=[\d.]+$/;

function getTagColor(message) {
    var m = message.match(TAG_RE);
    return m ? (TAG_COLORS[m[1]] || null) : null;
}

function stripTagsForDisplay(message) {
    // Remove [PS:X] prefix and trailing | t=XX.XX
    return message.replace(TAG_RE, '').replace(TIMESTAMP_RE, '').trim();
}

function buildRow(entry) {
    var row = document.createElement('div');
    row.className = 'log-entry type-' + entry.eventType;
    row.dataset.type = entry.eventType;

    // Tag snapped rows so alignOtherColumns can find them
    if (entry._snapRow !== null) {
        row.dataset.snapRow = entry._snapRow;
        row.classList.add('is-snapped');
    }

    var tagColor = getTagColor(entry.message);

    // Tag badge — shows [NETWORK], [STATE] etc with its colour
    if (tagColor) {
        var tagM = entry.message.match(TAG_RE);
        var badge = document.createElement('div');
        badge.className = 'log-tag';
        badge.textContent = tagM[1];
        badge.style.color = tagColor;
        badge.style.borderColor = tagColor;
        row.appendChild(badge);
    }

    var time = document.createElement('div');
    time.className = 'log-time';
    time.textContent = formatElapsed(entry.elapsed);

    var msg = document.createElement('div');
    msg.className = 'log-msg';
    // Display without [PS:X] prefix and trailing timestamp
    msg.textContent = stripTagsForDisplay(entry.message);
    if (tagColor) msg.style.color = tagColor;

    row.appendChild(time);
    row.appendChild(msg);
    return row;
}

function formatElapsed(ms) {
    // When elapsed is a multiple of 10 with no fractional part it came from
    // a .log file import (line index * 10). Show as line number instead.
    if (ms % 10 === 0 && ms < 864000000) {
        var line = ms / 10;
        return 'L' + String(line).padStart(4, '0');
    }
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    var rem = Math.floor((ms % 1000) / 10);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') + '.' + String(rem).padStart(2, '0');
}

// ── Controls ─────────────────────────────────────────────────────────────────
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
    var ids = Object.keys(clients);
    for (var i = 0; i < ids.length; i++) {
        clients[ids[i]].colEl.remove();
    }
    clients = {};
    colorIndex = 0;
    buffer = [];
    snapGroups = {};
    snapRowCounter = 0;
    sessionStartTimestamp = null;
    emptyState.style.display = '';
    var el = document.getElementById('status-indicator');
    el.textContent = 'waiting for clients...';
    el.className = 'status';
}

function clearAll() {
    var ids = Object.keys(clients);
    for (var i = 0; i < ids.length; i++) {
        var c = clients[ids[i]];
        c.logsEl.innerHTML = '';
        c.entries = [];
        c.countEl.textContent = '0';
    }
    buffer = [];
    snapGroups = {};
    snapRowCounter = 0;
}

function toggleFilter(pill) {
    var type = pill.dataset.type;
    activeFilters[type] = !activeFilters[type];
    pill.className = activeFilters[type] ? 'pill active-' + type : 'pill';
    rebuildAllColumns();
}

function rebuildAllColumns() {
    // Reset snap state so rows re-align cleanly on rebuild
    snapGroups = {};
    snapRowCounter = 0;

    var ids = Object.keys(clients);
    for (var i = 0; i < ids.length; i++) {
        var client = clients[ids[i]];
        client.logsEl.innerHTML = '';
    }

    // Re-process all entries in timestamp order across all clients
    // so snap groups are rebuilt correctly
    var all = [];
    for (var i = 0; i < ids.length; i++) {
        var entries = clients[ids[i]].entries;
        for (var j = 0; j < entries.length; j++) {
            all.push({ clientId: ids[i], entry: entries[j] });
        }
    }
    all.sort(function (a, b) { return a.entry.timestamp - b.entry.timestamp; });

    for (var i = 0; i < all.length; i++) {
        var item = all[i];
        if (!activeFilters[item.entry.eventType]) continue;
        item.entry._snapRow = resolveSnapRow(item.entry);
        var row = buildRow(item.entry);
        clients[item.clientId].logsEl.appendChild(row);
        if (item.entry._snapRow !== null) {
            alignOtherColumns(item.clientId, item.entry._snapRow, row.offsetHeight || 22);
        }
    }

    for (var i = 0; i < ids.length; i++) {
        clients[ids[i]].logsEl.scrollTop = clients[ids[i]].logsEl.scrollHeight;
    }
}

function setSnapWindow(ms) {
    snapWindowMs = ms;
}

function updateStatus() {
    var n = Object.keys(clients).length;
    var el = document.getElementById('status-indicator');
    el.textContent = n + ' client' + (n !== 1 ? 's' : '') + ' connected';
    el.className = 'status live';
}

// ── Save session ──────────────────────────────────────────────────────────────
async function saveSession() {
    // Serialise all client entries into a portable format
    var sessionData = {
        version: 1,
        savedAt: Date.now(),
        clients: {}
    };

    var ids = Object.keys(clients);
    for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        sessionData.clients[id] = {
            color: clients[id].color,
            entries: clients[id].entries
        };
    }

    var result = await window.punscope.saveSession(sessionData);
    if (result.ok) {
        flashStatus("Session saved");
    }
}

// ── Load session (.json) ──────────────────────────────────────────────────────
async function loadSession() {
    var data = await window.punscope.loadSession();
    if (!data) return;

    newSession();

    var ids = Object.keys(data.clients);

    // 1. Create all columns first with their saved colours
    for (var i = 0; i < ids.length; i++) {
        ensureClientWithColor(ids[i], data.clients[ids[i]].color);
    }

    // 2. Collect all entries across all clients and sort by timestamp
    //    so spacers get inserted in the correct order globally
    var all = [];
    for (var i = 0; i < ids.length; i++) {
        var entries = data.clients[ids[i]].entries;
        for (var j = 0; j < entries.length; j++) {
            all.push({ clientId: ids[i], entry: entries[j] });
        }
    }
    all.sort(function (a, b) { return a.entry.timestamp - b.entry.timestamp; });

    // 3. Find global session start and highest snap row
    var maxSavedSnapRow = -1;
    var minTimestamp = Infinity;
    for (var i = 0; i < all.length; i++) {
        var e = all[i].entry;
        if (e.timestamp < minTimestamp) minTimestamp = e.timestamp;
        var sr = e._snapRow;
        if (sr !== null && sr !== undefined && sr > maxSavedSnapRow) maxSavedSnapRow = sr;
    }
    snapRowCounter = maxSavedSnapRow + 1;
    sessionStartTimestamp = minTimestamp;

    // Normalize all elapsed values to global session start
    for (var i = 0; i < all.length; i++) {
        all[i].entry.elapsed = all[i].entry.timestamp - minTimestamp;
    }

    // 4. Render in timestamp order, trusting saved _snapRow values directly
    for (var i = 0; i < all.length; i++) {
        var clientId = all[i].clientId;
        var entry = all[i].entry;
        var client = clients[clientId];

        client.entries.push(entry);
        client.countEl.textContent = client.entries.length;

        if (!activeFilters[entry.eventType]) continue;

        var row = buildRow(entry);
        client.logsEl.appendChild(row);

        // Use saved _snapRow directly — do NOT call resolveSnapRow
        if (entry._snapRow !== null && entry._snapRow !== undefined) {
            alignOtherColumns(clientId, entry._snapRow, row.offsetHeight || 22);
        }
    }

    flashStatus("Session loaded");
}

// ── Load browser .log files ───────────────────────────────────────────────────
async function loadLogFiles() {
    var files = await window.punscope.loadLogFiles();
    if (!files) return;

    clearAll();

    // Sort files so columns appear in a consistent order
    files.sort(function (a, b) { return a.clientId.localeCompare(b.clientId); });

    var startTimestamp = null;

    for (var i = 0; i < files.length; i++) {
        var file = files[i];
        var clientId = file.clientId;
        var entries = parseChromeLog(file.content, clientId);

        if (!entries.length) continue;

        // Use the first log's timestamp as the session start so elapsed times
        // are relative, just like live sessions
        if (startTimestamp === null) startTimestamp = entries[0].timestamp;

        ensureClient(clientId);

        for (var j = 0; j < entries.length; j++) {
            var entry = entries[j];
            entry.elapsed = entry.timestamp - startTimestamp;
            entry._snapRow = resolveSnapRow(entry);
            clients[clientId].entries.push(entry);
            clients[clientId].countEl.textContent = clients[clientId].entries.length;
            if (!activeFilters[entry.eventType]) continue;
            var row = buildRow(entry);
            clients[clientId].logsEl.appendChild(row);
            if (entry._snapRow !== null) {
                alignOtherColumns(clientId, entry._snapRow, row.offsetHeight || 22);
            }
        }
        clients[clientId].logsEl.scrollTop = 0;
    }

    flashStatus(files.length + " log file(s) loaded");
}

// ── Chrome DevTools log parser ────────────────────────────────────────────────
// Handles the two formats seen in Chrome WebGL log exports:
//
// Format A — leading space, no source prefix (early boot lines):
//   " Some message here"
//
// Format B — framework source prefix (runtime lines):
//   "CCC_v6.1.6.2_WebGL.framework.js:3 Some message here"
//
// Neither format has timestamps, so we assign a sequential index as elapsed.
// Blank lines and stack-frame-only lines (e.g. "_JS_Log_Dump @ ...") are skipped.

// Matches "filename.js:N " prefix on runtime log lines
var CHROME_SOURCE_PREFIX_RE = /^\S+\.js:\d+\s+/;

// Lines that are purely JS stack frames — skip entirely
var CHROME_STACK_FRAME_RE = /^\S+\s*@\s*\S+\.js:\d+$/;

function parseChromeLog(content, clientId) {
    var lines = content.split(/\r?\n/);
    var entries = [];
    var index = 0;  // used as a stand-in for elapsed since there are no timestamps

    for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        var line = raw.trim();

        // Skip blank lines
        if (!line) continue;

        // Skip pure stack frame lines like "_JS_Log_Dump @ framework.js:3"
        if (CHROME_STACK_FRAME_RE.test(line)) continue;

        // Strip "filename.js:N " source prefix if present
        var message = line.replace(CHROME_SOURCE_PREFIX_RE, '').trim();

        // Skip if stripping left us with nothing
        if (!message) continue;

        entries.push({
            clientId: clientId,
            timestamp: Date.now() + index,  // fake monotonic timestamp for ordering
            elapsed: index * 10,          // treat each line as 10ms apart
            logType: classifyLogType(message),
            eventType: classifyEventType(message),
            message: message,
        });

        index++;
    }

    return entries;
}

function classifyLogType(message) {
    var lower = message.toLowerCase();
    if (lower.includes("error") || lower.includes("exception")) return "Error";
    if (lower.includes("warning") || lower.includes("warn")) return "Warning";
    return "Log";
}

function classifyEventType(message) {
    if (message.match(/^\[PS:[A-Z]+\]/)) {
        var lower = message.toLowerCase();
        if (lower.includes("error") || lower.includes("exception")) return "error";
        if (lower.includes("warning") || lower.includes("warn")) return "warning";
        return "photon";
    }
    var lower = message.toLowerCase();
    if (lower.includes("error") || lower.includes("exception")) return "error";
    if (lower.includes("warning") || lower.includes("warn")) return "warning";
    return "log";
}

// ── ensureClientWithColor ─────────────────────────────────────────────────────
// Like ensureClient but uses a specific colour (for session restore)
function ensureClientWithColor(id, color) {
    if (clients[id]) return;

    emptyState.style.display = "none";

    var col = document.createElement("div");
    col.className = "client-col";
    col.id = "col-" + id;

    var header = document.createElement("div");
    header.className = "col-header";

    var dot = document.createElement("div");
    dot.className = "col-dot";
    dot.style.background = color;

    var name = document.createElement("div");
    name.className = "col-name";
    name.textContent = id;
    name.style.color = color;

    var count = document.createElement("div");
    count.className = "col-count";
    count.textContent = "0";

    header.appendChild(dot);
    header.appendChild(name);
    header.appendChild(count);

    var logs = document.createElement("div");
    logs.className = "col-logs";

    col.appendChild(header);
    col.appendChild(logs);
    colsWrapper.appendChild(col);

    clients[id] = { color: color, entries: [], colEl: col, logsEl: logs, countEl: count };
    updateStatus();
}

// ── Status flash ──────────────────────────────────────────────────────────────
function flashStatus(msg) {
    var el = document.getElementById("status-indicator");
    var prev = el.textContent;
    el.textContent = "✓ " + msg;
    setTimeout(function () { el.textContent = prev; }, 2500);
}
