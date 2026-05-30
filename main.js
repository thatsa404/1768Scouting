import Dexie from 'dexie';
import Chart from 'chart.js/auto';
import { getGameConfig, resolveColumnMap, aggregateScoutingData, processScoutingData, fuseScoutingWithTBA, indexObservationsByMatch, detectCumulativeReportingMode, EVENT_SOURCES as SCOUTING_SOURCES } from './games/registry.js';
import { getTeamQuip, logFractionToTier, QUIP_TIERS } from './teamQuips.js';

// 1. DATABASE SETUP
// We use Dexie to handle larger storage (images/multiple events)
const db = new Dexie('ScoutingAppDB');
db.version(1).stores({
    teams: 'teamNumber, eventKey',
    matches: 'key, eventKey, matchNumber'
});
db.version(2).stores({
    teams: 'teamNumber, eventKey',
    matches: 'key, eventKey, matchNumber',
    tbaTeams: 'teamNumber, eventKey'
});
window.db = db;

// 2. CONFIG & API KEYS
const TBA_BASE = 'https://www.thebluealliance.com/api/v3';
const TBA_KEY = import.meta.env.VITE_TBA_KEY;
const YT_KEY = import.meta.env.VITE_YOUTUBE_KEY || '';

// SCOUTING_SOURCES is imported as EVENT_SOURCES from ./games/registry.js above.
// To add events, edit the eventSources field in the appropriate games/ config file.

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
const _firedNotifIds = new Set(); // prevents re-firing within a session

function fireNotif(title, body, tag) {
    if (localStorage.getItem('notifEnabled') !== 'true') return;
    if (Notification.permission === 'granted') {
        new Notification(title, { body, tag, icon: '/favicon.ico' });
    }
    if (document.visibilityState !== 'visible') {
        document.title = `🔔 ${title}`;
    }
}

function updateNotifBtn() {
    const btn   = document.getElementById('notifBtn');
    const label = document.getElementById('notifBtnLabel');
    if (!btn) return;
    const enabled = localStorage.getItem('notifEnabled') === 'true';
    const blocked = Notification.permission === 'denied';
    btn.style.opacity = enabled ? '1' : '0.35';
    btn.title = blocked
        ? 'Notifications blocked — allow in browser settings'
        : enabled ? 'Notifications on (click to disable)' : 'Notifications off (click to enable)';
    if (label) label.textContent = blocked ? 'Blocked' : enabled ? 'On' : 'Off';
}

function initNotifications() {
    updateNotifBtn();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') document.title = '1768 Scouting';
    });
}

window.toggleNotifications = async function () {
    if (!('Notification' in window)) { alert('Your browser does not support notifications.'); return; }
    const enabled = localStorage.getItem('notifEnabled') === 'true';
    if (!enabled) {
        if (Notification.permission === 'denied') {
            alert('Notifications are blocked. Allow them in your browser settings, then try again.');
            return;
        }
        if (Notification.permission !== 'granted') {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') return;
        }
        localStorage.setItem('notifEnabled', 'true');
    } else {
        localStorage.setItem('notifEnabled', 'false');
    }
    updateNotifBtn();
};


window.currentFocusedTeam = null;

function updateAppEventKey(eventKey) {
    const subtitle = document.getElementById('headerSubtitle');
    if (eventKey) {
        if (subtitle) subtitle.textContent = eventKey;
        document.title = `Nashoba Robotics — ${eventKey}`;
    } else {
        if (subtitle) subtitle.textContent = 'Event Hub';
        document.title = 'Nashoba Robotics — Event Hub';
    }
}

// ── EVENT SELECTOR ─────────────────────────────────────────────────────────────

function showEventSelector() {
    const overlay = document.getElementById('event-selector-overlay');
    if (!overlay) return;

    // Build preset cards grouped by year, newest first
    const byYear = {};
    for (const [key, src] of Object.entries(SCOUTING_SOURCES)) {
        const year = key.slice(0, 4);
        if (!byYear[year]) byYear[year] = [];
        byYear[year].push({ key, src });
    }
    const years = Object.keys(byYear).sort((a, b) => b - a);

    const presetsEl = document.getElementById('event-selector-presets');
    if (presetsEl) {
        presetsEl.innerHTML = years.map(year => {
            const cards = byYear[year].map(({ key, src }) => {
                const gameConfig = getGameConfig(key);
                const sublabel = [src.label, gameConfig ? `${gameConfig.name} ${year}` : null]
                    .filter(Boolean).join(' · ');
                return `<button class="event-preset-card" onclick="window.selectPresetEvent('${key}')">
                    <span class="preset-key">${key}</span>
                    ${sublabel ? `<span class="preset-sublabel">${sublabel}</span>` : ''}
                </button>`;
            }).join('');
            return `<div>
                <div class="event-selector-year-label">${year}</div>
                <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:8px;">${cards}</div>
            </div>`;
        }).join('');
    }

    // Show "Continue with [key]" if a key is already saved
    const savedKey = localStorage.getItem('lastEventKey');
    const continueDiv = document.getElementById('event-selector-continue');
    const continueBtn = document.getElementById('event-selector-continue-btn');
    if (savedKey && continueDiv && continueBtn) {
        continueBtn.textContent = `Continue with ${savedKey}`;
        continueDiv.style.display = 'block';
    } else if (continueDiv) {
        continueDiv.style.display = 'none';
    }

    overlay.style.display = 'flex';
}

window.closeEventSelector = function () {
    const overlay = document.getElementById('event-selector-overlay');
    if (overlay) overlay.style.display = 'none';
};

window.selectPresetEvent = async function (key) {
    const input = document.getElementById('eventKeyInput');
    if (input) input.value = key;
    localStorage.setItem('lastEventKey', key);
    updateAppEventKey(key);
    updateOBEStatus(key);
    renderScoutingSection();
    window.closeEventSelector();

    // Auto-load archive if one exists for this event
    const url = `${import.meta.env.BASE_URL}scouting/${key}_archive.json`;
    const hint = document.getElementById('archiveHint');
    if (hint) hint.innerHTML = `<span style="color:#64748b;font-size:0.82em;">Checking for archive…</span>`;
    try {
        const resp = await fetch(url, { method: 'HEAD' });
        const ct = resp.headers.get('content-type') || '';
        if (resp.ok && ct.includes('json')) {
            await window.loadEventArchive(key);
        } else {
            if (hint) hint.innerHTML = `<span style="color:#475569;font-size:0.8em;">No archive available</span>`;
        }
    } catch {
        if (hint) hint.innerHTML = `<span style="color:#475569;font-size:0.8em;">No archive available</span>`;
    }
};

window.selectCustomEvent = function () {
    const input = document.getElementById('event-selector-custom-input');
    const key = input?.value.trim().toLowerCase();
    if (!key) return;
    window.selectPresetEvent(key);
};

window.openEventSelector = function () { showEventSelector(); };

// 3. UTILITY FUNCTIONS
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function getTeamNotes() {
    try { return JSON.parse(localStorage.getItem('teamNotes') || '{}'); } catch { return {}; }
}
// Returns { matchKey: { text, qm } } for one team; migrates legacy formats transparently.
function getTeamNotesMap(teamNumber) {
    const raw = getTeamNotes()[String(teamNumber)];
    if (!raw) return {};
    if (typeof raw === 'string') return { general: { text: raw, qm: null } };
    // Old single-note format: { text, qm }
    if (typeof raw.text === 'string') {
        const key = raw.qm != null ? String(raw.qm) : 'general';
        return { [key]: { text: raw.text, qm: raw.qm ?? null } };
    }
    return raw;
}
// Returns { text, qm } for a specific match context (qm = number or null = general).
function getTeamNote(teamNumber, qm = null) {
    const map = getTeamNotesMap(teamNumber);
    return map[qm != null ? String(qm) : 'general'] || null;
}
// Formatted string for a specific match context.
function noteDisplayText(teamNumber, qm = null) {
    const note = getTeamNote(teamNumber, qm);
    if (!note?.text) return '';
    return note.qm != null ? `(QM ${note.qm}) ${note.text}` : note.text;
}
// All note lines for a team, sorted by match number (for overview tab).
function allNoteDisplayLines(teamNumber) {
    return Object.values(getTeamNotesMap(teamNumber))
        .filter(n => n.text)
        .sort((a, b) => (a.qm ?? Infinity) - (b.qm ?? Infinity))
        .map(n => n.qm != null ? `(QM ${n.qm}) ${n.text}` : n.text);
}
function saveTeamNote(teamNumber, text, qm = null) {
    const all = getTeamNotes();
    const teamKey = String(teamNumber);
    const map = getTeamNotesMap(teamNumber);
    const matchKey = qm != null ? String(qm) : 'general';
    if (text.trim()) map[matchKey] = { text: text.trim(), qm: qm ?? null };
    else delete map[matchKey];
    if (Object.keys(map).length === 0) delete all[teamKey];
    else all[teamKey] = map;
    localStorage.setItem('teamNotes', JSON.stringify(all));
}

// ── Scouting data helpers ─────────────────────────────────────────────────────

// Returns the source URL for an event: checks SCOUTING_SOURCES first, then a
// per-device localStorage override (saved when the user pastes a URL manually).
function getScoutingSource(eventKey) {
    if (!eventKey) return null;
    const entry = SCOUTING_SOURCES[eventKey];
    if (entry?.url) return entry.url;
    if (typeof entry === 'string') return entry; // legacy string form
    return localStorage.getItem(`scoutingSheetUrl_${eventKey}`) || null;
}

function getPitSource(eventKey) {
    if (!eventKey) return null;
    return SCOUTING_SOURCES[eventKey]?.pitUrl || localStorage.getItem(`pitSheetUrl_${eventKey}`) || null;
}

// Returns any per-event column name overrides defined in SCOUTING_SOURCES.
function getScoutingColumnOverrides(eventKey) {
    return SCOUTING_SOURCES[eventKey]?.columnOverrides || {};
}

// Returns aggregated scouting stats for all teams at an event, or null if no
// raw data or no game config exists for that event key.
function getScoutingStats(eventKey) {
    const raw = localStorage.getItem(`scoutingData_${eventKey}`);
    if (!raw) return null;
    return aggregateScoutingData(eventKey, JSON.parse(raw), getScoutingColumnOverrides(eventKey));
}

// Returns scout comments for one team at an event, sorted by match number.
// Each entry: { matchNumber, text }
function getScoutingComments(teamNumber, eventKey) {
    if (!eventKey) return [];
    const raw = localStorage.getItem(`scoutingData_${eventKey}`);
    if (!raw) return [];
    const result = processScoutingData(eventKey, JSON.parse(raw), getScoutingColumnOverrides(eventKey));
    if (!result) return [];
    return (result.byTeam[String(teamNumber)] || [])
        .filter(r => r.comments)
        .map(r => ({ matchNumber: r.matchNumber, text: r.comments }))
        .sort((a, b) => a.matchNumber - b.matchNumber);
}

// RFC-4180-compliant CSV parser. Handles quoted fields containing commas/newlines.
function parseCSV(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    function parseLine(line) {
        const fields = [];
        let cur = '', inQ = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
            else if (c === ',' && !inQ) { fields.push(cur); cur = ''; }
            else cur += c;
        }
        fields.push(cur);
        return fields;
    }
    const headers = parseLine(lines[0]).map(h => h.trim());
    return lines.slice(1).map(line => {
        const vals = parseLine(line);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = (vals[i] ?? '').trim(); });
        return obj;
    });
}

const TIER_BG  = { S: '#f59e0b', A: '#4ade80', B: '#a855f7', C: '#64748b' };
const TIER_STYLE = {
    S: { color: '#f59e0b', bg: 'rgba(245,158,11,0.08)' },
    A: { color: '#4ade80', bg: 'rgba(74,222,128,0.07)' },
    B: { color: '#a855f7', bg: 'rgba(168,85,247,0.06)' },
    C: { color: '#64748b', bg: 'rgba(100,116,139,0.03)' },
};
function tierBadge(tier, extraClass = '', label = '') {
    const bg = TIER_BG[tier] || TIER_BG.C;
    const fg = tier === 'C' ? '#f8fafc' : '#0f172a';
    const text = label ? `${tier} ${label}` : tier;
    return `<span class="${extraClass}" style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:0.72em;font-weight:800;background:${bg};color:${fg};letter-spacing:0.06em;vertical-align:middle;">${text}</span>`;
}
const OWN_TEAM = '1768';
function ownStar(tn) {
    return String(tn) === OWN_TEAM
        ? `<span style="color:#fbbf24;font-size:0.65em;vertical-align:middle;margin-left:3px;line-height:1;">★</span>`
        : '';
}

function epaRankTier(allTeams, myVal, fieldFn) {
    const vals = allTeams.map(fieldFn).filter(v => v != null && !isNaN(v)).sort((a, b) => b - a);
    const rank = vals.findIndex(v => v <= myVal + 0.001);
    const r = rank < 0 ? vals.length : rank;
    return r < 8 ? 'S' : r < 20 ? 'A' : r < 32 ? 'B' : 'C';
}


async function fetchTBA(endpoint) {
    const response = await fetch(`${TBA_BASE}${endpoint}`, {
        headers: { 'X-TBA-Auth-Key': TBA_KEY }
    });
    return await response.json();
}

window.fetchSchedule = async function (eventKey) {
    const statusDiv = document.getElementById('status');
    try {
        const response = await fetch(`https://www.thebluealliance.com/api/v3/event/${eventKey}/matches/simple`, {
            headers: { 'X-TBA-Auth-Key': TBA_KEY }
        });
        const matches = await response.json();

        // Filter for Qualifications only and sort by match number
        const qualMatches = matches
            .filter(m => m.comp_level === 'qm')
            .sort((a, b) => a.match_number - b.match_number);

        // Save to Dexie
        await db.matches.bulkPut(qualMatches.map(m => ({
            key: m.key,
            eventKey: eventKey,
            matchNumber: m.match_number,
            red: m.alliances.red.team_keys.map(t => t.replace('frc', '')),
            blue: m.alliances.blue.team_keys.map(t => t.replace('frc', '')),
            redScore: m.alliances.red.score,
            blueScore: m.alliances.blue.score,
            predictedTime: m.predicted_time || null,
            actualTime: m.actual_time || null,
            videos: (m.videos || []).filter(v => v.type === 'youtube').map(v => v.key),
        })));

        console.log(`Loaded ${qualMatches.length} matches into schedule.`);
    } catch (err) {
        console.error("TBA Fetch Error:", err);
    }
};

window.displaySchedule = async function () {
    const body = document.getElementById('scheduleBody');
    if (!body) return;

    const matches = await db.matches.orderBy('matchNumber').toArray();
    const isMobile = document.body.classList.contains('mobile-ui');
    const thead = document.querySelector('#scheduleTable thead');

    if (matches.length === 0) {
        body.innerHTML = `<tr><td colspan="${isMobile ? 5 : 8}" style="text-align:center; padding:20px;">No matches cached. Hit "Sync Schedule" on the Home tab.</td></tr>`;
        return;
    }

    // Rebuild thead to match layout
    if (isMobile) {
        thead.innerHTML = `<tr>
            <th style="text-align:center;">Match</th>
            <th>1</th><th>2</th><th>3</th>
            <th style="text-align:center;min-width:3.2rem;">Score</th>
        </tr>`;
    } else {
        thead.innerHTML = `
            <tr>
                <th rowspan="2">Match</th>
                <th colspan="3" class="red-header">Red Alliance</th>
                <th colspan="3" class="blue-header">Blue Alliance</th>
                <th rowspan="2">Result</th>
            </tr>
            <tr>
                <th class="red-header">1</th><th class="red-header">2</th><th class="red-header">3</th>
                <th class="blue-header">1</th><th class="blue-header">2</th><th class="blue-header">3</th>
            </tr>`;
    }

    body.innerHTML = '';

    const teamCell = (team, cls) =>
        `<td class="${cls}" data-team="${team}" onclick="highlightTeam('${team}')" style="cursor:pointer;"><strong>${team}</strong></td>`;

    const nowTs = Math.floor(Date.now() / 1000);

    matches.forEach(m => {
        const redWon  = m.redScore > -1 && m.redScore > m.blueScore;
        const blueWon = m.redScore > -1 && m.blueScore > m.redScore;
        const hasVideo = m.videos && m.videos.length > 0;
        const matchPassed = m.redScore <= -1 && m.predictedTime && m.predictedTime < nowTs;
        const videoIcon = hasVideo
            ? `<svg style="width:12px;height:12px;vertical-align:middle;margin-left:4px;color:#f59e0b;flex-shrink:0;" viewBox="0 0 20 20" fill="currentColor"><circle cx="10" cy="10" r="10"/><polygon points="8,6 15,10 8,14" fill="#080d16"/></svg>`
            : '';

        if (isMobile) {
            const redRow  = document.createElement('tr');
            const blueRow = document.createElement('tr');
            redRow.dataset.matchStart = 'true';
            redRow.dataset.teams = [...m.red, ...m.blue].join(',');

            const redCells  = m.red.map(t  => teamCell(t,  'red-cell')).join('');
            const blueCells = m.blue.map(t => teamCell(t, 'blue-cell')).join('');

            const scoreCell = m.redScore > -1
                ? `<td rowspan="2" onclick="viewMatchDetail('${m.key}')"
                       style="cursor:pointer;border-left:2px solid #334155;vertical-align:middle;text-align:center;white-space:nowrap;padding:4px 8px;min-width:2.8rem;">
                       <div style="color:${redWon  ? '#4ade80' : '#94a3b8'};font-weight:${redWon  ? '800' : 'normal'};white-space:nowrap;">${m.redScore}</div>
                       <div style="color:#334155;font-size:0.65em;line-height:1.4;white-space:nowrap;">${hasVideo ? videoIcon : '—'}</div>
                       <div style="color:${blueWon ? '#4ade80' : '#94a3b8'};font-weight:${blueWon ? '800' : 'normal'};white-space:nowrap;">${m.blueScore}</div>
                   </td>`
                : matchPassed
                    ? `<td rowspan="2" onclick="viewMatchDetail('${m.key}')"
                           style="cursor:pointer;border-left:2px solid #334155;vertical-align:middle;text-align:center;white-space:nowrap;min-width:2.8rem;">⏩</td>`
                    : `<td rowspan="2" data-unscored-key="${m.key}" data-unscored-time="${m.predictedTime}" style="color:#64748b;font-style:italic;border-left:2px solid #334155;vertical-align:middle;text-align:center;white-space:nowrap;min-width:2.8rem;">—</td>`;

            const mobileCountdown = m.redScore <= -1 && m.predictedTime
                ? `<div data-predicted-time="${m.predictedTime}" data-match-key="${m.key}" style="font-size:0.65em;color:#64748b;margin-top:2px;"></div>`
                : '';
            redRow.innerHTML = `
                <td class="match-number" rowspan="2" onclick="viewMatchPrep('${m.key}')"
                    style="cursor:pointer;text-decoration:underline;color:#3b82f6;vertical-align:middle;text-align:center;white-space:nowrap;padding:4px 6px;">
                    QM ${m.matchNumber}${mobileCountdown}
                </td>
                ${redCells}${scoreCell}`;
            blueRow.innerHTML = blueCells;

            body.appendChild(redRow);
            body.appendChild(blueRow);
        } else {
            const row = document.createElement('tr');
            row.dataset.matchStart = 'true';
            row.dataset.teams = [...m.red, ...m.blue].join(',');
            const redCells  = m.red.map(t  => teamCell(t,  'red-cell')).join('');
            const blueCells = m.blue.map(t => teamCell(t, 'blue-cell')).join('');
            const resultCell = m.redScore > -1
                ? `<td onclick="viewMatchDetail('${m.key}')" style="cursor:pointer;border-left:2px solid #334155;white-space:nowrap;">
                       <span style="color:${redWon  ? '#4ade80' : '#94a3b8'};font-weight:${redWon  ? 'bold' : 'normal'}">${m.redScore}</span>
                       <span style="color:#475569;"> – </span>
                       <span style="color:${blueWon ? '#4ade80' : '#94a3b8'};font-weight:${blueWon ? 'bold' : 'normal'}">${m.blueScore}</span>
                       ${videoIcon}
                   </td>`
                : matchPassed
                    ? `<td onclick="viewMatchDetail('${m.key}')" style="cursor:pointer;border-left:2px solid #334155;text-align:center;color:#64748b;">⏩</td>`
                    : `<td data-unscored-key="${m.key}" data-unscored-time="${m.predictedTime}" style="color:#64748b;font-style:italic;border-left:2px solid #334155;">Upcoming</td>`;
            const desktopCountdown = m.redScore <= -1 && m.predictedTime
                ? `<div data-predicted-time="${m.predictedTime}" data-match-key="${m.key}" style="font-size:0.65em;color:#64748b;margin-top:2px;"></div>`
                : '';
            row.innerHTML = `
                <td class="match-number" onclick="viewMatchPrep('${m.key}')"
                    style="cursor:pointer;text-decoration:underline;color:#3b82f6;">QM ${m.matchNumber}${desktopCountdown}</td>
                ${redCells}${blueCells}${resultCell}`;
            body.appendChild(row);
        }
    });
    applyScheduleFilter();
    clearInterval(_scheduleCountdownInterval);
    updateScheduleCountdowns();
    _scheduleCountdownInterval = setInterval(updateScheduleCountdowns, 1_000);
    updateHomeBanner();
};

let prepChartInstance = null; // Global variable to handle chart destruction
let breakdownRadarChartRed  = null;
let breakdownRadarChartBlue = null;

const rightPanelHistory = [];

let _scheduleCountdownInterval = null;

// ── MATCH COUNTDOWN BANNER (team 1768) ────────────────────────────────────────
let _bannerMatchNum  = null;
let _bannerMatchTime = null;
let _bannerAlliance  = null; // 'red' | 'blue'

function updateBannerTick() {
    const textEl = document.getElementById('match-countdown-text');
    const banner = document.getElementById('match-countdown-banner');
    if (!textEl || !_bannerMatchTime) return;

    const now = Math.floor(Date.now() / 1000);
    const remaining = _bannerMatchTime - now;

    if (remaining < 0) {
        // Predicted time passed — clear and advance to the next future match
        _bannerMatchTime = null;
        updateHomeBanner();
        return;
    }

    let countdown;
    if (remaining >= 3600) {
        const h = Math.floor(remaining / 3600);
        const m = Math.floor((remaining % 3600) / 60);
        countdown = `${h}h ${m}m`;
    } else {
        const m = Math.floor(remaining / 60);
        const s = String(remaining % 60).padStart(2, '0');
        countdown = m > 0 ? `${m}m ${s}s` : `${s}s`;
    }

    textEl.textContent = `QM ${_bannerMatchNum}  ·  ${countdown}`;
    banner.style.display = 'flex';
}

async function updateHomeBanner() {
    const banner = document.getElementById('match-countdown-banner');
    const allianceEl = document.getElementById('match-countdown-alliance');
    if (!banner) return;

    const now = Math.floor(Date.now() / 1000);
    const matches = await db.matches.orderBy('matchNumber').toArray();
    const next = matches.find(m =>
        m.redScore <= -1 &&
        m.predictedTime &&
        m.predictedTime > now &&
        (m.red?.includes('1768') || m.blue?.includes('1768'))
    );

    if (!next) {
        banner.style.display = 'none';
        _bannerMatchTime = null;
        return;
    }

    _bannerMatchNum  = next.matchNumber;
    _bannerMatchTime = next.predictedTime;
    _bannerAlliance  = next.red?.includes('1768') ? 'red' : 'blue';

    if (allianceEl) {
        allianceEl.textContent = _bannerAlliance === 'red' ? 'Red' : 'Blue';
        allianceEl.style.color      = _bannerAlliance === 'red' ? '#fca5a5' : '#93c5fd';
        allianceEl.style.background = _bannerAlliance === 'red' ? '#7f1d1d55' : '#1e3a5f55';
    }

    updateBannerTick();
}

function updateScheduleCountdowns() {
    const now = Math.floor(Date.now() / 1000);
    document.querySelectorAll('[data-predicted-time]').forEach(el => {
        const predicted = parseInt(el.dataset.predictedTime, 10);
        const remaining = predicted - now;
        if (remaining < 0) {
            el.textContent = '';
        } else if (remaining >= 3600) {
            const t = new Date(predicted * 1000);
            el.textContent = '~' + t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        } else if (remaining >= 300) {
            el.textContent = `${Math.floor(remaining / 60)}m`;
        } else {
            const m = Math.floor(remaining / 60);
            const s = String(remaining % 60).padStart(2, '0');
            el.textContent = m > 0 ? `${m}m ${s}s` : `${s}s`;
        }
        // 5-minute warning for focused team's matches
        const matchKey = el.dataset.matchKey;
        if (matchKey && remaining > 0 && remaining <= 300) {
            const notifId = `warn-${matchKey}`;
            if (!_firedNotifIds.has(notifId)) {
                const row = el.closest('tr');
                const teams = (row?.dataset.teams || '').split(',').filter(Boolean);
                const focused = window.currentFocusedTeam;
                if (focused && teams.includes(focused)) {
                    _firedNotifIds.add(notifId);
                    const matchNum = matchKey.split('_qm')[1] || matchKey;
                    const mins = Math.ceil(remaining / 60);
                    fireNotif(
                        `QM ${matchNum} in ~${mins} min`,
                        `${teams.slice(0, 3).join(', ')} vs ${teams.slice(3).join(', ')}`,
                        notifId
                    );
                }
            }
        }
    });
    // Flip "Upcoming / —" cells to ⏩ once their predicted time passes
    document.querySelectorAll('[data-unscored-key]').forEach(td => {
        const t = parseInt(td.dataset.unscoredTime, 10);
        if (t && t < now) {
            const key = td.dataset.unscoredKey;
            td.removeAttribute('data-unscored-key');
            td.removeAttribute('data-unscored-time');
            td.style.cssText += ';cursor:pointer;text-align:center;color:#64748b;font-style:normal;';
            td.textContent = '⏩';
            td.onclick = () => window.viewMatchDetail(key);
        }
    });
}

let currentPrepMatch = null;

window.viewMatchPrep = async function (matchKey) {
    const match = await db.matches.get(matchKey);
    if (!match) return;
    currentPrepMatch = match;

    document.getElementById('prepMatchLabel').innerText = `Match Prep: Qual ${match.matchNumber}`;
    const isSplit = document.body.classList.contains('split-ui');
    if (isSplit) {
        pushCurrentRightPanel();
        document.getElementById('splitRightPanel').style.display = 'none';
        document.getElementById('matchPrepView').style.display = 'block';
    } else {
        window.switchView('matchPrepView');
        pushNavState('matchPrep');
    }

    // Preload all teams to compute overall tiers
    const allTeamsForTier = await db.teams.toArray();
    const overallTierOf = (team) => {
        const myVal = team.analysis?.ceiling != null ? parseFloat(team.analysis.ceiling) : (team.currentEPA || 0);
        return epaRankTier(allTeamsForTier, myVal,
            t => t.analysis?.ceiling != null ? parseFloat(t.analysis.ceiling) : (t.currentEPA || 0));
    };

    // Helper to get team data and return a stats object
    const getTeamStats = async (teamNum) => {
        const team = await db.teams.get(parseInt(teamNum));
        return {
            number: teamNum,
            total: team?.currentEPA || 0,
            auto: team?.autoEPA || 0,
            teleop: team?.teleopEPA || 0,
            endgame: team?.endgameEPA || 0
        };
    };

    // 1. Calculate Alliance Totals
    const redTeamsData = await Promise.all(match.red.map(num => getTeamStats(num)));
    const blueTeamsData = await Promise.all(match.blue.map(num => getTeamStats(num)));

    // 2. Render the Comparison Chart
    renderPrepChart(redTeamsData, blueTeamsData);

    // 2. Helper function to build a team card
    const createTeamCard = async (teamNum, matchNumber = null) => {
        const team = await db.teams.get(parseInt(teamNum));

        // 1. DATA CLEANUP: Force both to strings and trim any whitespace
        const globalFocus = (window.currentFocusedTeam || "").toString().trim();
        const currentCardTeam = (teamNum || "").toString().trim();

        // 2. THE CHECK:
        const isFocused = (globalFocus !== "" && globalFocus === currentCardTeam);

        // 3. LOGGING: Keep this in for one refresh to see the truth in the console
        console.log(`Comparing: [${globalFocus}] to [${currentCardTeam}] -> Result: ${isFocused}`);

        const focusClass = isFocused ? 'highlight-active' : '';

        // Fallback if team data hasn't been synced yet
        if (!team) {
            return `<div class="prep-team-card"><h3>Team ${teamNum}</h3><p>No data. Sync Statbotics.</p></div>`;
        }

        const tier = overallTierOf(team);
        const hasNote = !!getTeamNote(teamNum, matchNumber)?.text;
        const qmArg = matchNumber != null ? matchNumber : 'null';

        return `
        <div class="prep-team-card ${focusClass}" id="prep-card-${teamNum}">
            <div class="prep-card-header" onclick="highlightTeam('${teamNum}')" style="cursor:pointer;">
                <div class="header-left">
                    <span class="prep-team-number">${teamNum}</span>
                    <div style="color:#94a3b8;font-size:0.78em;font-weight:600;">EPA ${team.currentEPA.toFixed(1)}</div>
                </div>
                ${tierBadge(tier, 'prep-tier-badge', 'Tier')}
            </div>

            <div class="prep-action-btns" style="display:flex;gap:8px;margin-top:10px;">
                <button onclick="viewTeamDetail(${teamNum})" style="flex:1;background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:6px;padding:7px;font-size:0.82em;font-weight:600;cursor:pointer;">View Profile</button>
                <button id="note-toggle-btn-${teamNum}" onclick="togglePrepNote('${teamNum}')" style="flex:1;background:#1e293b;color:#94a3b8;border:1px solid ${hasNote ? '#3b82f6' : '#334155'};border-radius:6px;padding:7px;font-size:0.82em;font-weight:600;cursor:pointer;">${hasNote ? 'Note ▾' : 'Notes ▾'}</button>
            </div>
            <div id="prep-note-section-${teamNum}" data-view-all="false" style="display:none;margin-top:8px;">
                <div style="display:flex;justify-content:flex-end;margin-bottom:5px;">
                    <button id="note-view-toggle-${teamNum}" onclick="togglePrepNoteView('${teamNum}', ${qmArg})" style="background:none;border:1px solid #334155;color:#64748b;border-radius:4px;padding:2px 8px;font-size:0.72em;cursor:pointer;">Show All</button>
                </div>
                <div id="prep-note-content-${teamNum}">
                    ${renderPrepNoteSection(teamNum, matchNumber)}
                </div>
            </div>
        </div>
    `;
    };

    // 3. Populate Red and Blue Lists
    const redCards = await Promise.all(match.red.map(num => createTeamCard(num, match.matchNumber)));
    const blueCards = await Promise.all(match.blue.map(num => createTeamCard(num, match.matchNumber)));

    document.getElementById('redPrepList').innerHTML = redCards.join('');
    document.getElementById('bluePrepList').innerHTML = blueCards.join('');
};

window.openScoutingBreakdown = async function () {
    if (!currentPrepMatch) return;
    const modal   = document.getElementById('scoutingBreakdownModal');
    const content = document.getElementById('scoutingBreakdownContent');
    modal.style.display = 'block';
    pushNavState('scoutingBreakdown');
    content.innerHTML = '<p style="color:#64748b;text-align:center;margin-top:40px;">Loading…</p>';

    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    const rawStr   = localStorage.getItem(`scoutingData_${eventKey}`);
    if (!rawStr) {
        content.innerHTML = '<p style="color:#64748b;padding:20px;">No scouting data synced for this event.</p>';
        return;
    }
    const processed = processScoutingData(eventKey, JSON.parse(rawStr), getScoutingColumnOverrides(eventKey));
    if (!processed || !processed.config.displayFields) {
        content.innerHTML = '<p style="color:#64748b;padding:20px;">No scouting comparison available for this game.</p>';
        return;
    }

    const { config, byTeam } = processed;
    const redTeams  = currentPrepMatch.red  || [];
    const blueTeams = currentPrepMatch.blue || [];
    const allTeams  = [...redTeams, ...blueTeams];

    const tbaMatches = await db.matches.where('eventKey').equals(eventKey).toArray();
    const tbaByMatch = {};
    const hasTBABreakdowns = tbaMatches.some(m => m.redBreakdown);
    if (hasTBABreakdowns && config.enrichAggregateWithTBA) {
        for (const m of tbaMatches) tbaByMatch[m.matchNumber] = m;
    }

    const teamStats = {};
    for (const tn of allTeams) {
        const rows = byTeam[String(tn)];
        if (rows?.length) {
            const { rows: deduped } = deduplicateTeamRows(rows);
            const stats = config.aggregateTeam(deduped);
            if (hasTBABreakdowns && config.enrichAggregateWithTBA) {
                config.enrichAggregateWithTBA(String(tn), deduped, stats, tbaByMatch);
            }
            teamStats[tn] = stats;
        } else {
            teamStats[tn] = null;
        }
    }

    const fmtVal = (stats, field) => {
        if (!stats) return '<span style="color:#334155;">N/A</span>';
        const v = stats[field.key];
        if (v == null) return '<span style="color:#475569;">—</span>';
        if (field.suffix === '%') return `${Math.round(v)}%`;
        if (field.decimals != null) return v.toFixed(field.decimals);
        return String(Math.round(v));
    };

    // ── Radar chart ───────────────────────────────────────────────────────────
    // Fuse each team to get autoFuelFused, then combine with autoClimbPts for auto EPA.
    const allByMatch = indexObservationsByMatch(processed.observations);
    const teamEPABreakdown = {};
    const teamAutoEPA = {};
    for (const tn of allTeams) {
        const agg  = teamStats[tn];
        if (!agg) { teamAutoEPA[tn] = 0; teamEPABreakdown[tn] = { total: 0 }; continue; }
        const rows = byTeam[String(tn)];
        const { rows: deduped } = deduplicateTeamRows(rows);
        const fused = hasTBABreakdowns
            ? fuseScoutingWithTBA(String(tn), deduped, allByMatch, tbaMatches, config)
            : { available: false };
        const fs = fused.available ? fused.stats : {};
        const merged = { ...agg, ...fs };
        const bd = config.computeFusedEPABreakdown?.(merged) ?? { auto: agg.autoClimbPts ?? 0, total: 0 };
        teamAutoEPA[tn] = bd.auto;
        teamEPABreakdown[tn] = bd;
    }
    const redPred  = redTeams.reduce((s, tn)  => s + (teamEPABreakdown[tn]?.total ?? 0), 0);
    const bluePred = blueTeams.reduce((s, tn) => s + (teamEPABreakdown[tn]?.total ?? 0), 0);
    const maxAutoEPA = Math.max(...Object.values(teamAutoEPA), 1);

    const radarAxes = [
        { label: 'Auto EPA',      fn: (s, tn) => teamAutoEPA[tn] / maxAutoEPA * 100 },
        { label: 'Endgame Climb', fn: (s)     => s?.climbPct ?? 0 },
        { label: 'Scoring Eff',   fn: (s)     => s?.avgScoringEff   != null ? (s.avgScoringEff   - 1) / 9 * 100 : 0 },
        { label: 'Shuttling Eff', fn: (s)     => s?.avgPassingSkill != null ? (s.avgPassingSkill - 1) / 9 * 100 : 0 },
        { label: 'Defense Eff',   fn: (s)     => s?.avgDefenseSkill != null ? (s.avgDefenseSkill - 1) / 9 * 100 : 0 },
        { label: 'Reliability',   fn: (s)     => 100 - (s?.pctDied ?? 0) },
    ];

    const redPalette  = ['rgba(239,68,68',  'rgba(248,113,113', 'rgba(252,165,165'];
    const bluePalette = ['rgba(59,130,246', 'rgba(96,165,250',  'rgba(147,197,253'];

    const makeDatasets = (teams, palette) => teams.map((tn, i) => {
        const stats = teamStats[tn];
        const c = palette[i];
        return {
            label: `${tn}${String(tn) === OWN_TEAM ? ' ★' : ''}`,
            data: radarAxes.map(ax => ax.fn(stats, tn)),
            borderColor: `${c},1)`,
            backgroundColor: `${c},0.08)`,
            pointBackgroundColor: `${c},1)`,
            pointRadius: 3,
            borderWidth: 2,
        };
    });

    // ── Table ─────────────────────────────────────────────────────────────────
    const thBase = 'padding:8px 10px;text-align:center;font-weight:700;font-size:0.82em;white-space:nowrap;border-bottom:2px solid';
    let tableHtml = `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">
        <thead><tr>
            <th style="padding:8px 10px;text-align:left;color:#475569;font-size:0.72em;border-bottom:2px solid #334155;"></th>
            ${redTeams.map(t  => `<th style="${thBase} #7f1d1d;color:#fca5a5;">${t}${ownStar(t)}</th>`).join('')}
            ${blueTeams.map(t => `<th style="${thBase} #1e3a8a;color:#93c5fd;">${t}${ownStar(t)}</th>`).join('')}
        </tr></thead>
        <tbody>`;

    for (const field of config.displayFields) {
        if (field.group) {
            tableHtml += `<tr style="background:#1e293b;">
                <td colspan="${1 + allTeams.length}" style="padding:5px 10px;color:#64748b;font-size:0.7em;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${field.group}</td>
            </tr>`;
            continue;
        }
        tableHtml += `<tr style="border-bottom:1px solid #1e293b;">
            <td style="padding:5px 10px;color:#94a3b8;font-size:0.8em;white-space:nowrap;">${field.label}</td>
            ${redTeams.map(t  => `<td style="padding:5px 10px;text-align:center;font-size:0.82em;">${fmtVal(teamStats[t],  field)}</td>`).join('')}
            ${blueTeams.map(t => `<td style="padding:5px 10px;text-align:center;font-size:0.82em;">${fmtVal(teamStats[t], field)}</td>`).join('')}
        </tr>`;
    }

    tableHtml += `</tbody></table></div>`;

    content.innerHTML = `
        <div style="display:flex;justify-content:center;gap:32px;margin-bottom:16px;font-weight:700;">
            <div style="text-align:center;">
                <div style="font-size:0.7em;font-weight:700;color:#fca5a5;letter-spacing:0.06em;margin-bottom:2px;">RED PREDICTED</div>
                <div style="font-size:1.6em;color:#f87171;">${Math.round(redPred)}</div>
            </div>
            <div style="align-self:center;color:#475569;font-size:0.9em;">vs</div>
            <div style="text-align:center;">
                <div style="font-size:0.7em;font-weight:700;color:#93c5fd;letter-spacing:0.06em;margin-bottom:2px;">BLUE PREDICTED</div>
                <div style="font-size:1.6em;color:#60a5fa;">${Math.round(bluePred)}</div>
            </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:20px;">
            <div style="flex:1;min-width:260px;text-align:center;">
                <div style="font-size:0.75em;font-weight:700;color:#fca5a5;letter-spacing:0.06em;margin-bottom:6px;">RED ALLIANCE</div>
                <canvas id="breakdownRadarRed"></canvas>
            </div>
            <div style="flex:1;min-width:260px;text-align:center;">
                <div style="font-size:0.75em;font-weight:700;color:#93c5fd;letter-spacing:0.06em;margin-bottom:6px;">BLUE ALLIANCE</div>
                <canvas id="breakdownRadarBlue"></canvas>
            </div>
        </div>
        ${tableHtml}
    `;

    // Render both radars after DOM is updated
    if (breakdownRadarChartRed)  { breakdownRadarChartRed.destroy();  breakdownRadarChartRed  = null; }
    if (breakdownRadarChartBlue) { breakdownRadarChartBlue.destroy(); breakdownRadarChartBlue = null; }

    const radarOptions = {
        responsive: true,
        aspectRatio: 1,
        layout: { padding: 0 },
        scales: {
            r: {
                min: 0, max: 100,
                ticks: { stepSize: 25, color: '#475569', backdropColor: 'transparent', font: { size: 10 } },
                grid:        { color: '#1e293b' },
                angleLines:  { color: '#334155' },
                pointLabels: {
                    color: '#94a3b8',
                    font: { size: 10 },
                    padding: 4,
                    callback: label => label.includes(' ') ? label.split(' ') : label,
                },
            },
        },
        plugins: {
            legend: {
                position: 'bottom',
                labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11 }, padding: 8 },
            },
            tooltip: {
                callbacks: { label: ctx => `${ctx.dataset.label}: ${Math.round(ctx.raw)}` },
            },
        },
    };

    const axisLabels = radarAxes.map(a => a.label);
    breakdownRadarChartRed  = new Chart(document.getElementById('breakdownRadarRed').getContext('2d'),
        { type: 'radar', data: { labels: axisLabels, datasets: makeDatasets(redTeams,  redPalette)  }, options: radarOptions });
    breakdownRadarChartBlue = new Chart(document.getElementById('breakdownRadarBlue').getContext('2d'),
        { type: 'radar', data: { labels: axisLabels, datasets: makeDatasets(blueTeams, bluePalette) }, options: radarOptions });
};

window.closeScoutingBreakdown = function () {
    document.getElementById('scoutingBreakdownModal').style.display = 'none';
    if (breakdownRadarChartRed)  { breakdownRadarChartRed.destroy();  breakdownRadarChartRed  = null; }
    if (breakdownRadarChartBlue) { breakdownRadarChartBlue.destroy(); breakdownRadarChartBlue = null; }
};

function renderPrepChart(redTeams, blueTeams) {
    const ctx = document.getElementById('allianceComparisonChart').getContext('2d');

    if (prepChartInstance) {
        prepChartInstance.destroy();
    }

    const redShades = ['#b91c1c', '#ef4444', '#f87171'];
    const blueShades = ['#1e3a8a', '#3b82f6', '#93c5fd'];

    const datasets = [
        ...redTeams.map((team, i) => {
            // Check if this specific team segment should be highlighted
            const isFocused = (window.currentFocusedTeam === team.number.toString());
            return {
                label: `Team ${team.number}`,
                data: [team.total, team.auto, team.teleop, team.endgame],
                backgroundColor: isFocused ? '#fde047' : redShades[i],
                borderColor: isFocused ? '#000' : 'transparent',
                borderWidth: isFocused ? 2 : 0,
                stack: 'Red'
            };
        }),
        ...blueTeams.map((team, i) => {
            const isFocused = (window.currentFocusedTeam === team.number.toString());
            return {
                label: `Team ${team.number}`,
                data: [team.total, team.auto, team.teleop, team.endgame],
                backgroundColor: isFocused ? '#fde047' : blueShades[i],
                borderColor: isFocused ? '#000' : 'transparent',
                borderWidth: isFocused ? 2 : 0,
                stack: 'Blue'
            };
        })
    ];

    prepChartInstance = new Chart(ctx, {
        type: 'bar',
        data: { labels: ['Total EPA', 'Auto', 'Teleop', 'Endgame'], datasets: datasets },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { stacked: true, grid: { color: '#334155' }, ticks: { color: '#94a3b8' } },
                y: { stacked: true, grid: { display: false }, ticks: { color: '#f8fafc', font: { weight: 'bold' } } }
            },
            plugins: {
                legend: { display: true, position: 'bottom', labels: { color: '#f8fafc', boxWidth: 12 } }
            }
        }
    });
}





window.viewMatchDetail = async function (matchKey) {
    const match = await db.matches.get(matchKey);
    if (!match) return;

    const redWon = match.redScore > match.blueScore;
    const blueWon = match.blueScore > match.redScore;

    document.getElementById('matchDetailLabel').innerText = `Match Details: Qual ${match.matchNumber}`;

    const redScoreEl = document.getElementById('redTotalScore');
    const blueScoreEl = document.getElementById('blueTotalScore');
    redScoreEl.innerText = match.redScore;
    blueScoreEl.innerText = match.blueScore;
    redScoreEl.style.color = redWon ? '#4ade80' : '#f8fafc';
    blueScoreEl.style.color = blueWon ? '#4ade80' : '#f8fafc';

    document.getElementById('redMatchTeams').innerHTML = match.red.map(t => `<div>${t}</div>`).join('');
    document.getElementById('blueMatchTeams').innerHTML = match.blue.map(t => `<div>${t}</div>`).join('');

    const breakdownEl = document.getElementById('scoreBreakdown');
    const rbd = match.redBreakdown;
    const bbd = match.blueBreakdown;

    if (rbd && bbd) {
        const eventKeyFromMatch = matchKey.split('_')[0];
        const mb = getGameConfig(eventKeyFromMatch)?.matchBreakdown;

        const redResultRP  = redWon ? 3 : match.redScore === match.blueScore ? 1 : 0;
        const blueResultRP = blueWon ? 3 : match.redScore === match.blueScore ? 1 : 0;

        const bonusRPFields = mb?.bonusRPFields ?? [];
        const check = val => val ? `<span style="color:#4ade80;">✓</span>` : `<span style="color:#475569;">✗</span>`;

        const totalRedRP  = rbd.rp ?? (redResultRP  + bonusRPFields.reduce((s, { field }) => s + (rbd[field] ? 1 : 0), 0));
        const totalBlueRP = bbd.rp ?? (blueResultRP + bonusRPFields.reduce((s, { field }) => s + (bbd[field] ? 1 : 0), 0));

        const scoreRows = mb?.scoreRows(rbd, bbd) ?? [
            ['Auto',         rbd.totalAutoPoints,   bbd.totalAutoPoints],
            ['Teleop',       rbd.totalTeleopPoints,  bbd.totalTeleopPoints],
            ['Fouls Earned', rbd.foulPoints,         bbd.foulPoints],
        ];
        const rpRows = [
            ['Match Result', redResultRP, blueResultRP],
            ...bonusRPFields.map(({ label, field }) => [label, rbd[field], bbd[field]]),
        ];

        breakdownEl.innerHTML = `
            <table class="breakdown-table">
                <thead><tr>
                    <th></th>
                    <th style="color:#ef4444;">Red</th>
                    <th style="color:#3b82f6;">Blue</th>
                </tr></thead>
                <tbody>
                    ${scoreRows.map(([label, r, b]) => `<tr>
                        <td>${label}</td>
                        <td>${r ?? '—'}</td>
                        <td>${b ?? '—'}</td>
                    </tr>`).join('')}
                    <tr class="breakdown-total">
                        <td>Total</td>
                        <td style="color:${redWon ? '#4ade80' : 'inherit'}">${rbd.totalPoints ?? match.redScore}</td>
                        <td style="color:${blueWon ? '#4ade80' : 'inherit'}">${bbd.totalPoints ?? match.blueScore}</td>
                    </tr>
                    <tr><td colspan="3" style="padding:8px 0 4px; color:#64748b; font-size:0.8em; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Ranking Points</td></tr>
                    ${rpRows.map(([label, r, b]) => `<tr>
                        <td style="color:#94a3b8;">${label}</td>
                        <td>${typeof r === 'number' ? r : check(r)}</td>
                        <td>${typeof b === 'number' ? b : check(b)}</td>
                    </tr>`).join('')}
                    <tr class="breakdown-total">
                        <td>Total RP</td>
                        <td style="color:#fbbf24;">${totalRedRP}</td>
                        <td style="color:#fbbf24;">${totalBlueRP}</td>
                    </tr>
                </tbody>
            </table>`;
    } else {
        breakdownEl.innerHTML = `<p style="color:#64748b; font-style:italic; font-size:0.9em; margin-top:12px;">Run "Sync TBA Matches" for a detailed breakdown.</p>`;
    }

    const videoSection = document.getElementById('matchVideoSection');
    const ytKeys = match.videos || [];
    if (ytKeys.length === 0) {
        let webcasts = [];
        try {
            const ek = document.getElementById('eventKeyInput')?.value.trim().toLowerCase() || match.eventKey;
            webcasts = JSON.parse(localStorage.getItem(`webcasts_${ek}`) || '[]');
        } catch {}
        const stream = findStreamForMatch(match, webcasts);
        if (stream) {
            const matchTs = match.actualTime ?? match.predictedTime;
            const offset = Math.max(0, matchTs - stream.startTimestamp - 20);
            const thumbId = 'stream-seek-thumb';
            videoSection.innerHTML = `
                <div style="color:#64748b;font-size:0.78em;font-style:italic;margin-bottom:6px;">No match video yet — live stream seeked to approx. match time</div>
                <div id="${thumbId}" onclick="loadYTEmbedAtTime('${stream.channel}','${thumbId}',${offset})"
                    style="position:relative;cursor:pointer;border-radius:8px;overflow:hidden;background:#000;">
                    <img src="https://img.youtube.com/vi/${stream.channel}/hqdefault.jpg"
                        style="width:100%;display:block;opacity:0.75;"
                        onerror="this.style.display='none'" loading="lazy">
                    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;gap:6px;">
                        <div style="width:56px;height:40px;background:rgba(15,23,42,0.82);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.3em;">⏩</div>
                        <div style="background:rgba(15,23,42,0.7);color:#94a3b8;font-size:0.72em;padding:2px 8px;border-radius:4px;">Live Stream</div>
                    </div>
                </div>`;
        } else {
            videoSection.innerHTML = `<p style="color:#64748b; font-style:italic; font-size:0.85em; margin:0;">No match video available.</p>`;
        }
    } else {
        videoSection.innerHTML = ytKeys.map((key, i) => {
            const thumbId = `yt-thumb-${i}`;
            return `<div id="${thumbId}" onclick="loadYTEmbed('${key}','${thumbId}')"
                style="position:relative; cursor:pointer; border-radius:8px; overflow:hidden; background:#000; ${i > 0 ? 'margin-top:12px;' : ''}">
                <img src="https://img.youtube.com/vi/${key}/hqdefault.jpg"
                    style="width:100%; display:block; opacity:0.85;"
                    onerror="this.style.display='none'" loading="lazy">
                <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none;">
                    <div style="width:64px; height:44px; background:rgba(255,0,0,0.85); border-radius:10px; display:flex; align-items:center; justify-content:center;">
                        <div style="border-style:solid; border-width:10px 0 10px 20px; border-color:transparent transparent transparent #fff; margin-left:4px;"></div>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    const isSplitDetail = document.body.classList.contains('split-ui');
    if (isSplitDetail) pushCurrentRightPanel();
    document.getElementById('matchDetailView').style.display = isSplitDetail ? 'block' : 'flex';
    pushNavState('matchDetail');
};

window.openLightbox = function (url) {
    const lb = document.getElementById('photoLightbox');
    document.getElementById('lightboxImg').src = url;
    lb.style.display = 'flex';
    pushNavState('lightbox');
};

window.closeLightbox = function () {
    document.getElementById('photoLightbox').style.display = 'none';
    document.getElementById('lightboxImg').src = '';
};

window.closeMatchDetail = function () {
    document.getElementById('matchDetailView').style.display = 'none';
    document.getElementById('matchVideoSection').innerHTML = '';
    if (document.body.classList.contains('split-ui') && !popRightPanel()) {
        document.getElementById('splitRightPanel').style.display = 'flex';
    }
};

window.closePrepView = function () {
    if (document.body.classList.contains('split-ui')) {
        document.getElementById('matchPrepView').style.display = 'none';
        if (!popRightPanel()) {
            document.getElementById('splitRightPanel').style.display = 'flex';
        }
    } else {
        window.switchView('scheduleView');
    }
};

// ── Note editor (match prep cards) ──────────────────────────────────────────

const NOTE_TA_STYLE = 'width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#f8fafc;padding:8px;font-size:0.85em;font-family:inherit;resize:vertical;min-height:60px;margin-top:6px;';
const NOTE_BTN = (label, color, onclick) =>
    `<button onclick="${onclick}" style="background:${color};color:#f8fafc;border:none;border-radius:6px;padding:5px 12px;font-size:0.82em;font-weight:600;cursor:pointer;">${label}</button>`;

function renderPrepNoteSection(teamNum, qm) {
    const note = getTeamNote(teamNum, qm);
    const qmArg = qm != null ? qm : 'null';
    if (note?.text) {
        return `<div class="prep-note-display" style="color:#94a3b8;font-size:0.82em;line-height:1.4;padding:6px 8px;background:#0f172a;border-radius:4px;border-left:2px solid #3b82f6;white-space:pre-wrap;margin-bottom:6px;">${noteDisplayText(teamNum, qm)}</div>
            <div style="display:flex;gap:6px;">
                ${NOTE_BTN('Edit', '#334155', `showPrepNoteEditor('${teamNum}', ${qmArg})`)}
                ${NOTE_BTN('Delete', '#7f1d1d', `deletePrepNote('${teamNum}', ${qmArg})`)}
            </div>`;
    }
    const label = qm != null ? ` for QM ${qm}` : '';
    return `<div style="color:#475569;font-size:0.82em;margin-bottom:6px;font-style:italic;">No note${label}.</div>
        ${NOTE_BTN('Add Note', '#3b82f6', `showPrepNoteEditor('${teamNum}', ${qmArg})`)}`;
}

window.togglePrepNote = function (teamNum) {
    const section = document.getElementById(`prep-note-section-${teamNum}`);
    const btn = document.getElementById(`note-toggle-btn-${teamNum}`);
    if (!section) return;
    const opening = section.style.display === 'none';
    section.style.display = opening ? 'block' : 'none';
    if (btn) btn.textContent = btn.textContent.replace(/[▾▴]/, opening ? '▴' : '▾');
};

window.togglePrepNoteView = function (teamNum, qm) {
    const section = document.getElementById(`prep-note-section-${teamNum}`);
    const viewBtn = document.getElementById(`note-view-toggle-${teamNum}`);
    const content = document.getElementById(`prep-note-content-${teamNum}`);
    if (!section || !content) return;
    const showingAll = section.dataset.viewAll === 'true';
    if (showingAll) {
        section.dataset.viewAll = 'false';
        if (viewBtn) viewBtn.textContent = 'Show All';
        content.innerHTML = renderPrepNoteSection(teamNum, qm);
    } else {
        section.dataset.viewAll = 'true';
        if (viewBtn) viewBtn.textContent = 'This Match';
        const lines = allNoteDisplayLines(teamNum);
        content.innerHTML = lines.length
            ? `<div class="prep-note-display" style="color:#94a3b8;font-size:0.82em;line-height:1.6;white-space:pre-wrap;">${lines.join('\n')}</div>`
            : `<div style="color:#475569;font-size:0.82em;font-style:italic;">No notes for this team yet.</div>`;
    }
};

window.showPrepNoteEditor = function (teamNum, qm) {
    const content = document.getElementById(`prep-note-content-${teamNum}`);
    if (!content) return;
    const qmArg = qm != null ? qm : 'null';
    const existing = getTeamNote(teamNum, qm);
    content.innerHTML = `<textarea id="note-ta-${teamNum}" style="${NOTE_TA_STYLE}">${existing?.text ?? ''}</textarea>
        <div style="display:flex;gap:6px;margin-top:6px;">
            ${NOTE_BTN('Save', '#3b82f6', `savePrepNote('${teamNum}', ${qmArg})`)}
            ${NOTE_BTN('Cancel', '#334155', `cancelPrepNoteEditor('${teamNum}', ${qmArg})`)}
        </div>`;
    document.getElementById(`note-ta-${teamNum}`)?.focus();
};

window.savePrepNote = function (teamNum, qm) {
    const text = document.getElementById(`note-ta-${teamNum}`)?.value || '';
    saveTeamNote(teamNum, text, qm);
    const section = document.getElementById(`prep-note-section-${teamNum}`);
    const content = document.getElementById(`prep-note-content-${teamNum}`);
    if (section) section.dataset.viewAll = 'false';
    const viewBtn = document.getElementById(`note-view-toggle-${teamNum}`);
    if (viewBtn) viewBtn.textContent = 'Show All';
    if (content) content.innerHTML = renderPrepNoteSection(teamNum, qm);
    _updateNoteToggleBtn(teamNum, qm);
};

window.cancelPrepNoteEditor = function (teamNum, qm) {
    const content = document.getElementById(`prep-note-content-${teamNum}`);
    if (content) content.innerHTML = renderPrepNoteSection(teamNum, qm);
};

window.deletePrepNote = function (teamNum, qm) {
    saveTeamNote(teamNum, '', qm);
    const section = document.getElementById(`prep-note-section-${teamNum}`);
    const content = document.getElementById(`prep-note-content-${teamNum}`);
    if (section) section.dataset.viewAll = 'false';
    const viewBtn = document.getElementById(`note-view-toggle-${teamNum}`);
    if (viewBtn) viewBtn.textContent = 'Show All';
    if (content) content.innerHTML = renderPrepNoteSection(teamNum, qm);
    _updateNoteToggleBtn(teamNum, qm);
};

function _updateNoteToggleBtn(teamNum, qm) {
    const btn = document.getElementById(`note-toggle-btn-${teamNum}`);
    if (!btn) return;
    const hasNote = !!getTeamNote(teamNum, qm)?.text;
    const isOpen = document.getElementById(`prep-note-section-${teamNum}`)?.style.display !== 'none';
    btn.textContent = `${hasNote ? 'Note' : 'Notes'} ${isOpen ? '▴' : '▾'}`;
    btn.style.borderColor = hasNote ? '#3b82f6' : '#334155';
}

// Note editor wired into the team detail Overview tab (adds/edits general notes only)
window.showOverviewNoteEditor = function (teamNum) {
    const section = document.getElementById('overview-notes-section');
    if (!section) return;
    const existing = getTeamNote(teamNum, null); // general note
    const allLines = allNoteDisplayLines(teamNum);
    const allDisplay = allLines.length
        ? `<div style="background:#1e293b;padding:10px 14px;border-radius:8px;border:1px solid #334155;color:#cbd5e1;font-size:0.9em;line-height:1.5;white-space:pre-wrap;margin-bottom:10px;">${allLines.join('\n')}</div>`
        : '';
    section.innerHTML = `${allDisplay}
        <div style="color:#64748b;font-size:0.8em;margin-bottom:4px;">General note (not tied to a match)</div>
        <textarea id="overview-note-ta" style="${NOTE_TA_STYLE}">${existing?.text ?? ''}</textarea>
        <div style="display:flex;gap:6px;margin-top:6px;">
            ${NOTE_BTN('Save', '#3b82f6', `saveOverviewNote(${teamNum})`)}
            ${NOTE_BTN('Cancel', '#334155', `cancelOverviewNote(${teamNum})`)}
            ${existing?.text ? NOTE_BTN('Delete', '#7f1d1d', `deleteOverviewNote(${teamNum})`) : ''}
        </div>`;
    document.getElementById('overview-note-ta')?.focus();
};

window.saveOverviewNote = function (teamNum) {
    const text = document.getElementById('overview-note-ta')?.value || '';
    saveTeamNote(teamNum, text, null); // always saves as general note
    renderNoteSection(teamNum);
};

window.cancelOverviewNote = function (teamNum) { renderNoteSection(teamNum); };

window.deleteOverviewNote = function (teamNum) {
    saveTeamNote(teamNum, '', null); // delete general note only
    renderNoteSection(teamNum);
};

function renderNoteSection(teamNum) {
    const section = document.getElementById('overview-notes-section');
    if (!section) return;

    const userLines  = allNoteDisplayLines(teamNum);
    const hasGeneral = !!getTeamNote(teamNum, null)?.text;
    const eventKey   = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    const scoutComments = getScoutingComments(teamNum, eventKey);

    // Build user notes block
    const userBlock = userLines.length
        ? `<div style="margin-bottom:10px;">
               <div style="color:#60a5fa;font-size:0.72em;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Your Notes</div>
               <div style="background:#1e293b;padding:12px 14px;border-radius:8px;border:1px solid #334155;color:#cbd5e1;font-size:0.9em;line-height:1.5;white-space:pre-wrap;">${userLines.join('\n')}</div>
           </div>`
        : '';

    // Build scout comments block (read-only)
    const scoutBlock = scoutComments.length
        ? `<div style="margin-bottom:10px;">
               <div style="color:#a78bfa;font-size:0.72em;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Scout Observations</div>
               <div style="background:#1e293b;padding:12px 14px;border-radius:8px;border:1px solid #334155;color:#cbd5e1;font-size:0.9em;line-height:1.5;">
                   ${scoutComments.map(c => `<div style="padding:4px 0;border-bottom:1px solid #1e293b;"><span style="color:#64748b;font-size:0.85em;margin-right:8px;">QM ${c.matchNumber}</span>${c.text}</div>`).join('')}
               </div>
           </div>`
        : '';

    const hasAnything = userLines.length || scoutComments.length;

    section.innerHTML = `
        ${userBlock}
        ${scoutBlock}
        ${!hasAnything ? `<div style="background:#1e293b;padding:16px;border-radius:8px;border:1px dashed #334155;display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <p style="color:#475569;font-style:italic;margin:0;font-size:0.9em;">No notes yet.</p>
            <button onclick="showOverviewNoteEditor(${teamNum})" style="background:#334155;color:#f8fafc;border:none;border-radius:6px;padding:6px 14px;font-size:0.82em;font-weight:600;cursor:pointer;white-space:nowrap;">Add Note</button>
        </div>` : `<button onclick="showOverviewNoteEditor(${teamNum})" style="background:#334155;color:#f8fafc;border:none;border-radius:6px;padding:6px 14px;font-size:0.82em;font-weight:600;cursor:pointer;">${hasGeneral ? 'Edit General Note' : 'Add General Note'}</button>`}`;
}

window.loadYTEmbed = function (key, thumbId) {
    const container = document.getElementById(thumbId);
    if (!container) return;
    container.outerHTML = `<div style="position:relative; padding-bottom:56.25%; height:0; overflow:hidden; border-radius:8px;">
        <iframe src="https://www.youtube-nocookie.com/embed/${key}?autoplay=1"
            style="position:absolute; top:0; left:0; width:100%; height:100%; border:0;"
            allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
    </div>`;
};

window.loadYTEmbedAtTime = function (key, thumbId, startSecs) {
    const container = document.getElementById(thumbId);
    if (!container) return;
    container.outerHTML = `<div style="position:relative; padding-bottom:56.25%; height:0; overflow:hidden; border-radius:8px;">
        <iframe src="https://www.youtube-nocookie.com/embed/${key}?autoplay=1&start=${Math.floor(startSecs)}"
            style="position:absolute; top:0; left:0; width:100%; height:100%; border:0;"
            allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
    </div>`;
};

// Returns the webcast record (with startTimestamp) whose date matches the match's play time.
// Uses actualTime when available; falls back to predictedTime if the predicted time has already passed.
function findStreamForMatch(match, webcasts) {
    const now = Math.floor(Date.now() / 1000);
    const ts = match.actualTime ?? (match.predictedTime < now ? match.predictedTime : null);
    if (!ts || !webcasts.length) return null;
    const matchDate = new Date(ts * 1000).toISOString().slice(0, 10);
    return webcasts.find(w => w.date === matchDate && w.type === 'youtube' && w.startTimestamp) ?? null;
}





window.highlightTeam = function (teamNumber) {
    const allCells = document.querySelectorAll('.red-cell, .blue-cell');
    const allRows = document.querySelectorAll('#scheduleBody tr');

    // 1. Clear previous
    allCells.forEach(cell => cell.classList.remove('highlight-active'));
    allRows.forEach(row => row.classList.remove('row-highlight'));

    // 2. Toggle check (using window.currentFocusedTeam)
    if (window.currentFocusedTeam === teamNumber.toString()) {
        window.currentFocusedTeam = null;
        window.refreshPrepHighlight(); // Keep these in sync
        if (document.getElementById('schedule-sub-watchlist')?.style.display !== 'none') renderWatchList();
        return;
    }

    // 3. Apply new
    const targets = document.querySelectorAll(`[data-team="${teamNumber}"]`);
    if (targets.length > 0) {
        targets.forEach(cell => {
            cell.classList.add('highlight-active');
            const parentRow = cell.closest('tr');
            if (parentRow) parentRow.classList.add('row-highlight');
        });

        window.currentFocusedTeam = teamNumber.toString();
    }

    // 4. Update the Prep cards if they are currently visible
    window.refreshPrepHighlight();
    applyScheduleFilter();
    if (document.getElementById('schedule-sub-watchlist')?.style.display !== 'none') renderWatchList();
};

window.refreshPrepHighlight = function () {
    const allCards = document.querySelectorAll('.prep-team-card');

    // 1. Update the Team Cards
    allCards.forEach(card => {
        const teamNum = card.querySelector('.prep-card-header span').innerText;
        if (window.currentFocusedTeam === teamNum) {
            card.classList.add('highlight-active');
        } else {
            card.classList.remove('highlight-active');
        }
    });

    // 2. Update the Chart segments
    if (prepChartInstance) {
        const redShades = ['#b91c1c', '#ef4444', '#f87171'];
        const blueShades = ['#1e3a8a', '#3b82f6', '#93c5fd'];

        prepChartInstance.data.datasets.forEach((dataset, index) => {
            // Extract the team number from the label "Team 1768"
            const teamNum = dataset.label.replace('Team ', '');
            const isFocused = (window.currentFocusedTeam === teamNum);

            if (dataset.stack === 'Red') {
                dataset.backgroundColor = isFocused ? '#fde047' : redShades[index % 3];
            } else {
                // Blue teams are the 4th, 5th, and 6th datasets
                dataset.backgroundColor = isFocused ? '#fde047' : blueShades[(index - 3) % 3];
            }

            // Add a border to the highlighted segment to make it "pop"
            dataset.borderColor = isFocused ? '#000' : 'transparent';
            dataset.borderWidth = isFocused ? 2 : 0;
        });

        prepChartInstance.update();
    }
};






async function getMatchHistory(teamNumber, year) {
    const url = `https://api.statbotics.io/v3/team_matches?team=${teamNumber}&year=${year}`;
    const response = await fetch(url);
    const json = await response.json();
    const matchArray = json.data || json.results || json;

    if (!matchArray || matchArray.length === 0) return [];

    // We still sort it so the order is preserved in the database
    matchArray.sort((a, b) => a.time - b.time);

    return matchArray; // Return the full objects, not just EPA
}

// teamEventData: the full record from team_events?event= (passed in from syncProjections).
// Keeps component EPAs event-specific without an extra per-team network call.
async function processTeamPerformance(teamNumber, eventKey, force = false, teamEventData = null) {
    const year = eventKey.slice(0, 4);

    // 1. Check local DB
    const cachedTeam = await db.teams.get(teamNumber);

    const nameResp = await fetch(`https://api.statbotics.io/v3/team/${teamNumber}`);
    const nameData = await nameResp.json();
    const teamName = nameData.name || "Unknown Team";

    // 2. Handshake (team_year) — used for match count and as fallback for EPA values
    const summaryResp = await fetch(`https://api.statbotics.io/v3/team_year/${teamNumber}/${year}`);
    const summary = await summaryResp.json();
    const apiMatchCount = summary.count || summary.data?.count || 0;

    console.log(`Team ${teamNumber}: Local Count ${cachedTeam?.matchCount || 0}, API Count ${apiMatchCount}`);

    // Event-specific EPA from the bulk team_events record; falls back to season-level team_year.
    const evEPA       = teamEventData?.epa ?? null;
    const bd          = evEPA?.breakdown ?? null;
    const autoEPA     = bd?.auto_points    ?? summary.epa?.breakdown?.auto_points    ?? 0;
    const teleopEPA   = bd?.teleop_points  ?? summary.epa?.breakdown?.teleop_points  ?? 0;
    const endgameEPA  = bd?.endgame_points ?? summary.epa?.breakdown?.endgame_points ?? 0;
    const eventEpaEnd = evEPA?.end ?? null;

    // 3. Only skip deep dive if cache is fresh
    const needsUpdate = force || !cachedTeam || cachedTeam.matchCount !== apiMatchCount;

    if (!needsUpdate) {
        await db.teams.update(teamNumber, {
            ...(eventEpaEnd != null ? { currentEPA: eventEpaEnd } : {}),
            autoEPA,
            teleopEPA,
            endgameEPA,
            epa: evEPA ?? summary.epa ?? null,
        });
        console.log(`-> Skipping deep dive for ${teamNumber}, but updated summary stats.`);
        return null;
    }

    // 4. Deep dive — full match history for EPA timeline and ceiling analysis
    console.log(`-> Fetching full matches for ${teamNumber}...`);
    const fullMatchData = await getMatchHistory(teamNumber, year);

    if (!fullMatchData || fullMatchData.length === 0) {
        console.warn(`-> No match data found for ${teamNumber}`);
        return null;
    }

    const playedMatches = fullMatchData.filter(m => m.status === 'Completed' && m.epa?.post);
    const currentEPA = eventEpaEnd
        ?? (playedMatches.length > 0 ? playedMatches[playedMatches.length - 1].epa.post : 0);

    await db.teams.put({
        teamNumber,
        teamName,
        eventKey,
        matchCount: apiMatchCount,
        currentEPA,
        autoEPA,
        teleopEPA,
        endgameEPA,
        epa: evEPA ?? summary.epa ?? null,
        rawStatboticsData: fullMatchData,
        analysis: cachedTeam?.analysis || null,
        lastUpdated: Date.now(),
    });

    return null;
}


function setSyncTimestamp(key) {
    const str = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    localStorage.setItem(`lastSync_${key}`, str);
    const el = document.getElementById(`ts-${key}`);
    if (el) el.textContent = `Last sync: ${str}`;
}

window.syncProjections = async function () {
    const input = document.getElementById('eventKeyInput');
    const eventKey = input ? input.value.trim().toLowerCase() : "";
    if (!eventKey) { alert("Please enter a valid Event Key first!"); return; }

    localStorage.setItem('lastEventKey', eventKey);

    const statusDiv = document.getElementById('status');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');

    // 1. Get team list from TBA (primary source — always available)
    statusDiv.innerText = `Fetching team list for ${eventKey} from TBA…`;
    let tbaTeams = [];
    try {
        const resp = await fetchTBA(`/event/${eventKey}/teams`);
        tbaTeams = Array.isArray(resp) ? resp : [];
    } catch (e) {
        statusDiv.innerText = `❌ Failed to reach TBA. Check your event key and network connection.`;
        return;
    }
    if (!tbaTeams.length) {
        statusDiv.innerText = `❌ No teams found for ${eventKey} on TBA. Check the event key.`;
        return;
    }

    // Build a name map from TBA data
    const tbaNameMap = {};
    for (const t of tbaTeams) tbaNameMap[t.team_number] = t.nickname || `Team ${t.team_number}`;

    // 2. Try Statbotics event bulk endpoint to get event-specific EPA breakdowns (optional)
    //    This only returns data if the event is hosted on Statbotics; if not, we still
    //    fetch per-team history via processTeamPerformance using year-level data.
    statusDiv.innerText = `Fetching Statbotics event data for ${eventKey}…`;
    const sbMap = {};
    try {
        const sbResp = await fetch(`https://api.statbotics.io/v3/team_events?event=${eventKey}&limit=100`);
        if (sbResp.ok) {
            const sbJson = await sbResp.json();
            const sbList = sbJson.data || sbJson.results || sbJson;
            if (Array.isArray(sbList)) {
                for (const te of sbList) sbMap[te.team] = te;
            }
        }
    } catch (e) {
        console.warn('Statbotics event endpoint unreachable — will use year-level data per team');
    }

    // 3. Progress bar setup
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    const totalTeams = tbaTeams.length;
    let sbFailed = 0;

    // 4. Sync loop — always try processTeamPerformance (works without event-specific data);
    //    only fall back to a TBA stub if Statbotics is completely unreachable for that team.
    for (let i = 0; i < totalTeams; i++) {
        const tn = tbaTeams[i].team_number;
        statusDiv.innerText = `Syncing Team ${tn} (${i + 1}/${totalTeams})…`;

        try {
            // Pass event-specific data if available; processTeamPerformance handles null gracefully
            await processTeamPerformance(tn, eventKey, false, sbMap[tn] ?? null);
        } catch (e) {
            // Statbotics unreachable for this team — write a minimal TBA-only record
            console.warn(`Statbotics unavailable for team ${tn}: ${e.message}`);
            sbFailed++;
            const existing = await db.teams.get(tn);
            if (!existing) {
                await db.teams.put({
                    teamNumber:  tn,
                    teamName:    tbaNameMap[tn],
                    eventKey,
                    currentEPA:  null,
                    autoEPA:     null,
                    teleopEPA:   null,
                    endgameEPA:  null,
                    epa:         null,
                    rawStatboticsData: [],
                    lastUpdated: Date.now(),
                });
            } else if (tbaNameMap[tn] && tbaNameMap[tn] !== `Team ${tn}`) {
                await db.teams.update(tn, { teamName: tbaNameMap[tn] });
            }
        }

        progressBar.style.width = `${((i + 1) / totalTeams) * 100}%`;
        displayTeams();
    }

    // 5. Wrap up
    const sbNote = sbFailed > 0 ? ` (${sbFailed} team${sbFailed > 1 ? 's' : ''} missing Statbotics data)` : '';
    statusDiv.innerText = `✅ Sync complete! Loaded ${totalTeams} teams${sbNote}.`;
    setSyncTimestamp('statboticsProjections');
    progressBar.style.background = '#10b981';
    setTimeout(() => {
        progressContainer.style.display = 'none';
        progressBar.style.background = '#3b82f6';
    }, 2000);

    displayTeams();
}

window.syncStatboticsLive = async function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) { alert('Enter an Event Key first.'); return; }

    const statusDiv = document.getElementById('status');
    statusDiv.textContent = 'Fetching live Statbotics match data…';

    // Two parallel calls: match-by-match EPA for timeline, and event-level for component EPAs
    const [matchResp, teamEvResp] = await Promise.all([
        fetch(`https://api.statbotics.io/v3/team_matches?event=${eventKey}&limit=1000`),
        fetch(`https://api.statbotics.io/v3/team_events?event=${eventKey}&limit=100`),
    ]);
    const json = await matchResp.json();
    const eventMatches = json.data || json.results || json;

    if (!Array.isArray(eventMatches) || !eventMatches.length) {
        statusDiv.textContent = 'No Statbotics match data returned for this event.';
        return;
    }

    // Build team_event map for component EPA lookup
    const teamEvMap = {};
    if (teamEvResp.ok) {
        const teJson = await teamEvResp.json();
        const teList = teJson.data || teJson.results || teJson;
        if (Array.isArray(teList)) {
            for (const te of teList) teamEvMap[te.team] = te;
        }
    }

    // Group match records by team
    const byTeam = {};
    for (const m of eventMatches) {
        const tn = m.team;
        if (!byTeam[tn]) byTeam[tn] = [];
        byTeam[tn].push(m);
    }
    for (const tn of Object.keys(byTeam)) {
        byTeam[tn].sort((a, b) => (a.time || 0) - (b.time || 0));
    }

    const allTeams = await db.teams.toArray();
    let updated = 0;

    // Create records for teams not yet in db — allows live-only sync without history sync
    const existingNums = new Set(allTeams.map(t => t.teamNumber));
    const toCreate = [];
    for (const [tnStr, matches] of Object.entries(byTeam)) {
        const tn = parseInt(tnStr);
        if (existingNums.has(tn)) continue;
        const teData = teamEvMap[tn];
        const evEPA  = teData?.epa ?? null;
        const teBd   = evEPA?.breakdown ?? null;
        const played = matches.filter(m => m.status === 'Completed' && m.epa?.post != null);
        const latestEPA = played.length ? played[played.length - 1].epa.post
                        : (evEPA?.total_points?.mean ?? null);
        toCreate.push({
            teamNumber:  tn,
            teamName:    `Team ${tn}`,
            eventKey,
            currentEPA:  latestEPA,
            autoEPA:     teBd?.auto_points    ?? null,
            teleopEPA:   teBd?.teleop_points  ?? null,
            endgameEPA:  teBd?.endgame_points ?? null,
            epa:         evEPA,
            rawStatboticsData: matches,
            lastUpdated: Date.now(),
        });
        updated++;
    }
    if (toCreate.length) await db.teams.bulkPut(toCreate);

    for (const team of allTeams) {
        const tn = team.teamNumber;
        const newMatches = byTeam[tn];
        if (!newMatches) continue;

        const played = newMatches.filter(m => m.status === 'Completed' && m.epa?.post != null);
        if (!played.length) continue;

        const latestEPA = played[played.length - 1].epa.post;

        // Merge event matches into existing history (replace same match keys, keep the rest)
        const eventKeys = new Set(newMatches.map(m => m.match));
        const baseHistory = (team.rawStatboticsData || []).filter(m => !eventKeys.has(m.match));
        const merged = [...baseHistory, ...newMatches].sort((a, b) => (a.time || 0) - (b.time || 0));

        const teData = teamEvMap[tn];
        const evEPA  = teData?.epa ?? null;
        const teBd   = evEPA?.breakdown ?? null;

        await db.teams.update(tn, {
            currentEPA: latestEPA,
            rawStatboticsData: merged,
            ...(evEPA ? {
                autoEPA:    teBd?.auto_points    ?? team.autoEPA,
                teleopEPA:  teBd?.teleop_points  ?? team.teleopEPA,
                endgameEPA: teBd?.endgame_points ?? team.endgameEPA,
                epa:        evEPA,
            } : {}),
        });
        updated++;
    }

    displayTeams();
    await renderAtAGlance();
    setSyncTimestamp('statboticsLive');
    statusDiv.textContent = `✅ Live Statbotics sync complete — ${updated} team${updated !== 1 ? 's' : ''} updated.`;
};

window.syncSchedule = async function () {
    const eventKey = document.getElementById('eventKeyInput').value.trim().toLowerCase();
    if (!eventKey) return alert("Please enter an Event Key.");

    const statusDiv = document.getElementById('status');
    statusDiv.innerText = "Fetching Schedule from TBA...";

    try {
        // TBA_API_KEY should be defined at the top of your file
        const response = await fetch(`https://www.thebluealliance.com/api/v3/event/${eventKey}/matches/simple`, {
            headers: { 'X-TBA-Auth-Key': TBA_KEY }
        });

        if (!response.ok) throw new Error("TBA Key invalid or Event not found.");

        const matches = await response.json();
        const qualMatches = matches
            .filter(m => m.comp_level === 'qm')
            .sort((a, b) => a.match_number - b.match_number);

        await db.matches.bulkPut(qualMatches.map(m => ({
            key: m.key,
            eventKey: eventKey,
            matchNumber: m.match_number,
            red: m.alliances.red.team_keys.map(t => t.replace('frc', '')),
            blue: m.alliances.blue.team_keys.map(t => t.replace('frc', '')),
            redScore: m.alliances.red.score,
            blueScore: m.alliances.blue.score,
            predictedTime: m.predicted_time || null,
            actualTime: m.actual_time || null,
            videos: (m.videos || []).filter(v => v.type === 'youtube').map(v => v.key),
        })));

        // Fetch webcasts from event metadata, then enrich with YouTube stream start times
        try {
            const evData = await fetchTBA(`/event/${eventKey}`);
            const webcasts = (evData.webcasts || []).filter(w => w.type === 'youtube');
            if (YT_KEY && webcasts.length > 0) {
                const ids = webcasts.map(w => w.channel).join(',');
                const ytData = await fetch(
                    `https://www.googleapis.com/youtube/v3/videos?id=${ids}&part=liveStreamingDetails&key=${YT_KEY}`
                ).then(r => r.json());
                for (const item of (ytData.items || [])) {
                    const wc = webcasts.find(w => w.channel === item.id);
                    const startStr = item.liveStreamingDetails?.actualStartTime;
                    if (wc && startStr) wc.startTimestamp = Math.floor(new Date(startStr).getTime() / 1000);
                }
            }
            localStorage.setItem(`webcasts_${eventKey}`, JSON.stringify(webcasts));
        } catch (e) {
            console.warn('Could not fetch webcasts:', e);
        }

        statusDiv.innerText = "✅ Schedule Sync Complete!";
        displaySchedule();
    } catch (err) {
        console.error(err);
        statusDiv.innerText = "❌ TBA Schedule Sync Failed.";
    }

    localStorage.setItem('lastEventKey', eventKey);
};

window.syncAll = async function () {
    const eventKey = document.getElementById('eventKeyInput').value.trim();
    if (!eventKey) return alert("Please enter an Event Key.");

    const statusDiv = document.getElementById('status');

    // Run them sequentially so the status messages don't fight
    statusDiv.innerText = "🚀 Starting Master Sync...";

    await window.syncProjections();
    await window.syncSchedule();
    await window.syncTBAOPR();
    await window.syncTBAMatches();
    await renderAtAGlance();

    statusDiv.innerText = "🎉 All systems up to date!";
};

// ── Auto-sync ─────────────────────────────────────────────────────────────

let _autoSyncTimer = null;
let _autoSyncTick = null;
let _autoSyncCountdown = 0;

async function runDuringEventSyncs() {
    await window.syncStatboticsLive();
    await window.syncTBAOPR();
    await window.syncTBAMatches();
}

function _updateAutoSyncStatus() {
    const el = document.getElementById('autoSyncStatus');
    if (!el) return;
    const m = Math.floor(_autoSyncCountdown / 60);
    const s = String(_autoSyncCountdown % 60).padStart(2, '0');
    el.textContent = `Next sync in ${m}:${s}`;
}

window.toggleAutoSync = function () {
    if (_autoSyncTimer) {
        clearInterval(_autoSyncTimer);
        clearInterval(_autoSyncTick);
        _autoSyncTimer = null;
        _autoSyncTick = null;
        const btn = document.getElementById('autoSyncBtn');
        const sel = document.getElementById('autoSyncInterval');
        if (btn) { btn.textContent = 'Start Auto-Sync'; btn.style.background = '#059669'; }
        if (sel) sel.disabled = false;
        const status = document.getElementById('autoSyncStatus');
        if (status) status.textContent = '';
    } else {
        const minutes = parseInt(document.getElementById('autoSyncInterval')?.value || '5', 10);
        const totalSeconds = minutes * 60;
        _autoSyncCountdown = totalSeconds;

        runDuringEventSyncs();

        _autoSyncTimer = setInterval(() => {
            _autoSyncCountdown = totalSeconds;
            runDuringEventSyncs();
        }, totalSeconds * 1000);

        _autoSyncTick = setInterval(() => {
            _autoSyncCountdown = Math.max(0, _autoSyncCountdown - 1);
            _updateAutoSyncStatus();
        }, 1000);

        const btn = document.getElementById('autoSyncBtn');
        const sel = document.getElementById('autoSyncInterval');
        if (btn) { btn.textContent = 'Stop Auto-Sync'; btn.style.background = '#ef4444'; }
        if (sel) sel.disabled = true;
        _updateAutoSyncStatus();
    }
};






// ── Scouting data sync ────────────────────────────────────────────────────────

let _scoutingAutoSyncTimer = null;
let _scoutingAutoSyncTick  = null;
let _scoutingAutoSyncCountdown = 0;

function _updateScoutingAutoSyncStatus() {
    const el = document.getElementById('scoutingAutoSyncStatus');
    if (!el) return;
    const m = Math.floor(_scoutingAutoSyncCountdown / 60);
    const s = String(_scoutingAutoSyncCountdown % 60).padStart(2, '0');
    el.textContent = `Next sync in ${m}:${s}`;
}

// Imports a parsed archive bundle into localStorage + IndexedDB.
// Returns a summary string.
async function importArchiveBundle(data, eventKey) {
    localStorage.removeItem(`scoutingFusedStats_${eventKey}`);
    // Detect a structured archive bundle by eventKey presence (not by scoutingRows, which may be empty)
    if (!Array.isArray(data) && (data.eventKey || data.teams || data.scoutingRows)) {
        if (Array.isArray(data.scoutingRows) && data.scoutingRows.length) {
            localStorage.setItem(`scoutingData_${eventKey}`, JSON.stringify(data.scoutingRows));
        }
        if (data.pitRows?.length) localStorage.setItem(`pitData_${eventKey}`, JSON.stringify(data.pitRows));
        if (data.teams?.length)    await db.teams.bulkPut(data.teams);
        if (data.tbaTeams?.length) await db.tbaTeams.bulkPut(data.tbaTeams);
        if (data.matches?.length)  await db.matches.bulkPut(data.matches);
        if (data.tbaAlliances?.length) {
            localStorage.setItem(`tbaAlliances_${eventKey}`, JSON.stringify(data.tbaAlliances));
            const alliances = Array.from({ length: 8 }, (_, i) => {
                const a = data.tbaAlliances[i];
                if (!a) return { captain: null, pick1: null, pick2: null };
                const strip = key => a.picks[key]?.replace(/^frc/i, '') || null;
                return { captain: strip(0), pick1: strip(1), pick2: strip(2) };
            });
            localStorage.setItem('realDraftState', JSON.stringify({ alliances, currentAlliance: 8, currentRound: 2 }));
        }
        if (typeof data.calibrationBeta === 'number' && !isNaN(data.calibrationBeta)) {
            localStorage.setItem(`wlCalibrationBeta_${eventKey}`, String(data.calibrationBeta));
        }
        if (data.preEventSnapshot) {
            localStorage.setItem(`wlPreEventSnapshot_${data.eventKey}`, JSON.stringify(data.preEventSnapshot));
        }
        const scoutCount = data.scoutingRows?.length || 0;
        return `Archive loaded: ${scoutCount} scouting rows + ${data.teams?.length || 0} teams + ${data.matches?.length || 0} matches`;
    } else {
        // Legacy: bare array of scouting rows
        localStorage.setItem(`scoutingData_${eventKey}`, JSON.stringify(data));
        return `${data.length} rows loaded`;
    }
}

// Updates OBE (overtaken by events) indicators on sync buttons based on stored archive coverage.
// coverage keys: teams, tbaTeams, matches, breakdowns, scouting
function updateOBEStatus(eventKey) {
    const raw = eventKey ? localStorage.getItem(`archiveCoverage_${eventKey}`) : null;
    const cov = raw ? JSON.parse(raw) : {};

    const entries = [
        { btnId: 'btn-syncProjections',    spanId: 'ts-statboticsProjections', covered: !!cov.teams,      setText: true },
        { btnId: 'btn-syncSchedule',       spanId: 'ts-schedule',              covered: !!cov.matches,    setText: true },
        { btnId: 'btn-syncStatboticsLive', spanId: 'ts-statboticsLive',        covered: !!cov.teams,      setText: false },
        { btnId: 'btn-syncTBAOPR',         spanId: 'ts-tbaOPR',                covered: !!cov.tbaTeams,   setText: false },
        { btnId: 'btn-syncTBAMatches',     spanId: 'ts-tbaMatches',            covered: !!cov.breakdowns, setText: false },
        { btnId: 'btn-syncScoutingData',   spanId: 'scouting-sync-status',     covered: !!cov.scouting,   setText: false },
        { btnId: 'btn-syncPitData',        spanId: 'pit-sync-status',          covered: !!cov.pit,        setText: false },
    ];

    for (const { btnId, spanId, covered, setText } of entries) {
        const btn  = document.getElementById(btnId);
        const span = document.getElementById(spanId);
        if (btn)  btn.style.opacity = covered ? '0.5' : '';
        if (span) {
            if (setText) span.textContent = covered ? '✓ from archive' : '';
            span.style.color = covered ? '#4ade80' : '#475569';
        }
    }
}

// Checks for a public archive file for the given event key and updates #archiveHint.
let _archiveCheckTimer = null;
async function checkEventArchive(eventKey) {
    const hint = document.getElementById('archiveHint');
    if (!hint) return;
    if (!eventKey || eventKey.length < 6) { hint.innerHTML = ''; return; }

    const url = `${import.meta.env.BASE_URL}scouting/${eventKey}_archive.json`;
    try {
        const resp = await fetch(url, { method: 'HEAD' });
        const ct = resp.headers.get('content-type') || '';
        // Vite's SPA fallback returns 200 with text/html for missing paths — reject those
        if (resp.ok && ct.includes('json')) {
            hint.innerHTML = `<button onclick="loadEventArchive('${eventKey}')" style="background:#1e3a5f;color:#60a5fa;border:1px solid #3b82f6;font-size:0.82em;padding:6px 12px;">↓ Load Archived Data</button>`;
        } else {
            hint.innerHTML = `<span style="color:#475569;font-size:0.8em;">No archive available</span>`;
        }
    } catch {
        hint.innerHTML = `<span style="color:#475569;font-size:0.8em;">No archive available</span>`;
    }
}

window.loadEventArchive = async function (eventKey) {
    if (!eventKey) eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) { alert('No event key — type one in the Event Key field first.'); return; }

    const url = `${import.meta.env.BASE_URL}scouting/${eventKey}_archive.json`;
    const hint = document.getElementById('archiveHint');
    if (hint) hint.innerHTML = `<span style="color:#64748b;font-size:0.82em;">Loading…</span>`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const summary = await importArchiveBundle(data, eventKey);

        // Store per-field coverage so updateOBEStatus can dim the right buttons
        localStorage.setItem(`archiveCoverage_${eventKey}`, JSON.stringify({
            teams:      !!(data.teams?.length),
            tbaTeams:   !!(data.tbaTeams?.length),
            matches:    !!(data.matches?.length),
            breakdowns: !!(data.matches?.some(m => m.redBreakdown || m.blueBreakdown)),
            scouting:   !!(data.scoutingRows?.length),
            pit:        !!(data.pitRows?.length),
        }));
        updateOBEStatus(eventKey);

        // Restore event key to the input so subsequent actions work
        const keyInput = document.getElementById('eventKeyInput');
        if (keyInput) keyInput.value = eventKey;
        localStorage.setItem('lastEventKey', eventKey);
        updateAppEventKey(eventKey);

        // Set sync timestamps for all bundled data sources so the Home tab shows them as synced
        const archiveTime = data.archived ? new Date(data.archived).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const archiveLabel = `Archive (${archiveTime})`;
        for (const key of ['statboticsLive', 'tbaOPR', 'tbaMatches', 'scoutingData']) {
            localStorage.setItem(`lastSync_${key}`, archiveLabel);
            const el = document.getElementById(`ts-${key}`);
            if (el) el.textContent = `Last sync: ${archiveLabel}`;
        }

        if (hint) hint.innerHTML = `<span style="color:#4ade80;font-size:0.82em;">✓ ${summary}</span>`;

        // Run TBA fusion now so the dashboard shows fused EPA immediately
        try { await computeScoutingFusion(); } catch (_) {}

        // Refresh all display surfaces
        renderScoutingSection();
        await Promise.all([
            displayTeams(),
            displaySchedule(),
            displayTBATeams(),
        ]);
        await renderAtAGlance();
        displayScoutingTeams();
        renderPickList();
        renderDraft();
    } catch (err) {
        if (hint) hint.innerHTML = `<span style="color:#ef4444;font-size:0.82em;">Error: ${err.message}</span>`;
    }
};

window.syncScoutingData = async function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) { alert('Enter an Event Key first.'); return; }
    const rawSource = getScoutingSource(eventKey);
    if (!rawSource) { alert('No scouting sheet source configured for this event.'); return; }
    const source = rawSource.endsWith('.json') ? rawSource : (sheetsInputToCsvUrl(rawSource) || rawSource);

    const statusEl = document.getElementById('scouting-sync-status');
    if (statusEl) statusEl.textContent = 'Syncing…';

    try {
        const resp = await fetch(source);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = rawSource.endsWith('.json') ? await resp.json() : parseCSV(await resp.text());
        const now = new Date().toLocaleTimeString();
        localStorage.setItem('lastSync_scoutingData', now);
        const summary = await importArchiveBundle(data, eventKey);
        if (statusEl) statusEl.textContent = summary.startsWith('Archive') ? summary : `Last sync: ${now} · ${summary}`;
        renderScoutingSection();
    } catch (err) {
        const msg = err.message === 'Failed to fetch'
            ? 'Failed to fetch — check that the sheet is shared publicly (Anyone with the link → Viewer)'
            : `Error: ${err.message}`;
        if (statusEl) statusEl.textContent = msg;
    }
};

window.toggleScoutingAutoSync = function () {
    if (_scoutingAutoSyncTimer) {
        clearInterval(_scoutingAutoSyncTimer);
        clearInterval(_scoutingAutoSyncTick);
        _scoutingAutoSyncTimer = _scoutingAutoSyncTick = null;
        const btn = document.getElementById('scoutingAutoSyncBtn');
        const sel = document.getElementById('scoutingAutoSyncInterval');
        const sts = document.getElementById('scoutingAutoSyncStatus');
        if (btn) { btn.textContent = 'Start Auto-Sync'; btn.style.background = '#059669'; }
        if (sel) sel.disabled = false;
        if (sts) sts.textContent = '';
    } else {
        const minutes = parseInt(document.getElementById('scoutingAutoSyncInterval')?.value || '5', 10);
        const total = minutes * 60;
        _scoutingAutoSyncCountdown = total;
        const _runScoutingAutoSync = () => {
            const ek = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
            window.syncScoutingData();
            if (ek) _syncPitDataForEvent(ek);
        };
        _runScoutingAutoSync();
        _scoutingAutoSyncTimer = setInterval(() => {
            _scoutingAutoSyncCountdown = total;
            _runScoutingAutoSync();
        }, total * 1000);
        _scoutingAutoSyncTick = setInterval(() => {
            _scoutingAutoSyncCountdown = Math.max(0, _scoutingAutoSyncCountdown - 1);
            _updateScoutingAutoSyncStatus();
        }, 1000);
        const btn = document.getElementById('scoutingAutoSyncBtn');
        const sel = document.getElementById('scoutingAutoSyncInterval');
        if (btn) { btn.textContent = 'Stop Auto-Sync'; btn.style.background = '#ef4444'; }
        if (sel) sel.disabled = true;
        _updateScoutingAutoSyncStatus();
    }
};

function sheetsInputToCsvUrl(input) {
    // Accept: bare sheet ID, any Google Sheets URL (edit/view/pub), or existing CSV export URL
    const idMatch = input.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
    const id = idMatch ? idMatch[1] : input.replace(/\s/g, '');
    if (!id) return null;
    // Preserve gid if present in the pasted URL (query param or fragment), otherwise default to first sheet (gid=0)
    const gidMatch = input.match(/[?&#]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : '0';
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

window.saveScoutingSheetUrl = function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    const raw = document.getElementById('scoutingUrlInput')?.value.trim();
    if (!raw || !eventKey) return;
    const url = sheetsInputToCsvUrl(raw);
    if (!url) return;
    localStorage.setItem(`scoutingSheetUrl_${eventKey}`, url);
    renderScoutingSection();
};

window.savePitSheetUrl = function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    const raw = document.getElementById('pitUrlInput')?.value.trim();
    if (!raw || !eventKey) return;
    const url = sheetsInputToCsvUrl(raw);
    if (!url) return;
    localStorage.setItem(`pitSheetUrl_${eventKey}`, url);
    renderScoutingSection();
};

async function _syncPitDataForEvent(eventKey) {
    const raw = getPitSource(eventKey);
    if (!raw) return; // no pit source — skip silently
    const source = sheetsInputToCsvUrl(raw) || raw;
    const statusEl = document.getElementById('pit-sync-status');
    if (statusEl) statusEl.textContent = 'Syncing…';
    try {
        const resp = await fetch(source);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const rows = parseCSV(await resp.text());
        const now = new Date().toLocaleTimeString();
        localStorage.setItem(`pitData_${eventKey}`, JSON.stringify(rows));
        localStorage.setItem(`lastSync_pitData`, now);
        if (statusEl) statusEl.textContent = `Last sync: ${now} · ${rows.length} teams`;
        renderScoutingSection();
    } catch (err) {
        const msg = err.message === 'Failed to fetch'
            ? 'Failed to fetch — check that the sheet is shared publicly (Anyone with the link → Viewer)'
            : `Error: ${err.message}`;
        if (statusEl) statusEl.textContent = msg;
    }
}

window.syncPitData = async function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) { alert('Enter an Event Key first.'); return; }
    if (!getPitSource(eventKey)) { alert('No pit scouting sheet configured for this event.'); return; }
    await _syncPitDataForEvent(eventKey);
};

window.saveScoutingArchive = async function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) { alert('Enter an event key first.'); return; }
    const raw = localStorage.getItem(`scoutingData_${eventKey}`);

    const [teams, tbaTeams, matches] = await Promise.all([
        db.teams.where('eventKey').equals(eventKey).toArray(),
        db.tbaTeams.where('eventKey').equals(eventKey).toArray(),
        db.matches.where('eventKey').equals(eventKey).toArray(),
    ]);

    const pitRaw = localStorage.getItem(`pitData_${eventKey}`);
    const allianceRaw = localStorage.getItem(`tbaAlliances_${eventKey}`);
    const savedBeta = parseFloat(localStorage.getItem(`wlCalibrationBeta_${eventKey}`));
    const bundle = {
        eventKey,
        archived: new Date().toISOString(),
        scoutingRows: raw ? JSON.parse(raw) : [],
        pitRows: pitRaw ? JSON.parse(pitRaw) : null,
        teams: teams.map(({ photoUrl: _, ...rest }) => rest),
        tbaTeams,
        matches,
        tbaAlliances: allianceRaw ? JSON.parse(allianceRaw) : null,
        calibrationBeta: isNaN(savedBeta) ? null : savedBeta,
        preEventSnapshot: JSON.parse(localStorage.getItem(`wlPreEventSnapshot_${eventKey}`) ?? 'null'),
    };

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    a.download = `${eventKey}_archive.json`;
    a.click();
    URL.revokeObjectURL(a.href);
};

// ── Adjustments bundle (ignored matches, ceilings, notes) ────────────────────

async function buildAdjBundle(eventKey) {
    const [allTeams, allTBATeams] = await Promise.all([
        db.teams.where('eventKey').equals(eventKey).toArray(),
        db.tbaTeams.where('eventKey').equals(eventKey).toArray(),
    ]);
    const allNotes = JSON.parse(localStorage.getItem('teamNotes') || '{}');
    const teams = {};
    for (const t of allTBATeams) {
        if (t.ignoredMatchKeys?.length || t.scoutingIgnoreActive) {
            teams[t.teamNumber] = {
                ignoredMatchKeys: t.ignoredMatchKeys ?? [],
                scoutingIgnoreActive: t.scoutingIgnoreActive ?? false,
            };
        }
    }
    for (const t of allTeams) {
        if (t.analysis) {
            teams[t.teamNumber] = { ...(teams[t.teamNumber] ?? {}), analysis: t.analysis };
        }
    }
    return { version: 1, eventKey, teams, notes: allNotes };
}

async function applyAdjBundle(bundle) {
    const [allTBATeams, allMatches] = await Promise.all([
        db.tbaTeams.toArray(),
        db.matches.toArray(),
    ]);
    const allTeamNums = allTBATeams.map(t => t.teamNumber);
    const globalIgnored = new Set(allMatches.filter(m => m.globallyIgnored).map(m => m.key));

    for (const [tn, adj] of Object.entries(bundle.teams ?? {})) {
        const num = parseInt(tn);
        const existing = (await db.tbaTeams.get(num)) ?? { teamNumber: num };
        const keys = adj.ignoredMatchKeys ?? existing.ignoredMatchKeys ?? [];

        let adjustedOPR = null;
        if (keys.length > 0) {
            const keySet = new Set(keys);
            const subset = allMatches.filter(m =>
                (m.redScore ?? -1) >= 0 && (m.blueScore ?? -1) >= 0 &&
                !globalIgnored.has(m.key) && !keySet.has(m.key)
            );
            const result = computeLocalOPR(subset, allTeamNums);
            const idx = allTeamNums.findIndex(n => n === num);
            if (result && idx !== -1) adjustedOPR = result[idx];
        }

        await db.tbaTeams.put({
            ...existing,
            ignoredMatchKeys: keys.length > 0 ? keys : null,
            adjustedOPR: keys.length > 0 ? adjustedOPR : null,
            scoutingIgnoreActive: adj.scoutingIgnoreActive ?? existing.scoutingIgnoreActive ?? false,
        });
        if (adj.analysis) {
            const team = (await db.teams.get(num)) ?? { teamNumber: num };
            await db.teams.put({ ...team, analysis: adj.analysis });
        }
    }
    const existingNotes = JSON.parse(localStorage.getItem('teamNotes') || '{}');
    for (const [tn, matchNotes] of Object.entries(bundle.notes ?? {})) {
        existingNotes[tn] = { ...existingNotes[tn], ...matchNotes };
    }
    localStorage.setItem('teamNotes', JSON.stringify(existingNotes));
    await refreshEPADisplays(activeTeamNumber);
}

window.exportAdjBundle = async function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) { alert('Enter an event key first.'); return; }
    const bundle = await buildAdjBundle(eventKey);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    a.download = `${eventKey}_adjustments.json`;
    a.click();
    URL.revokeObjectURL(a.href);
};

window.importAdjFile = async function (input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    try {
        const bundle = JSON.parse(await file.text());
        if (!bundle.version || !bundle.teams) throw new Error('Not a valid adjustments file.');
        if (!confirm(`Import adjustments for ${bundle.eventKey}?\nThis merges ignored matches, ceilings, and notes without overwriting your raw data.`)) return;
        await applyAdjBundle(bundle);
        alert('Adjustments imported.');
    } catch (err) {
        alert(`Import failed: ${err.message}`);
    }
};

window.shareAdjLink = async function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) { alert('Enter an event key first.'); return; }
    if (typeof LZString === 'undefined') { alert('LZString not loaded — check your network connection.'); return; }
    const bundle = await buildAdjBundle(eventKey);
    const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(bundle));
    const url = `${location.origin}${location.pathname}#adj=${compressed}`;
    const btn = document.getElementById('shareAdjLinkBtn');
    try {
        await navigator.clipboard.writeText(url);
        if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = orig; }, 2000); }
    } catch {
        prompt('Copy this link:', url);
    }
};

async function checkAdjustmentsFromURL() {
    const hash = location.hash;
    if (!hash.startsWith('#adj=')) return;
    const compressed = hash.slice(5);
    history.replaceState(null, '', location.pathname + location.search);
    if (typeof LZString === 'undefined') return;
    try {
        const bundle = JSON.parse(LZString.decompressFromEncodedURIComponent(compressed));
        if (!bundle?.version || !bundle?.teams) return;
        if (!confirm(`Import adjustments for ${bundle.eventKey} from shared link?\nThis merges ignored matches, ceilings, and notes without overwriting your raw data.`)) return;
        await applyAdjBundle(bundle);
        alert('Adjustments imported.');
    } catch {
        // malformed or expired link — silently ignore
    }
}

function renderScoutingSection() {
    const container = document.getElementById('scouting-data-section');
    if (!container) return;
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();

    if (!eventKey) {
        container.innerHTML = `<p style="color:#475569;font-size:0.85em;margin:0;">Enter an event key above to configure scouting data.</p>`;
        return;
    }

    const source    = getScoutingSource(eventKey);
    const isLive    = source?.startsWith('http');
    const hasData   = !!localStorage.getItem(`scoutingData_${eventKey}`);
    const lastSync  = localStorage.getItem('lastSync_scoutingData');
    const gameConfig = getGameConfig(eventKey);
    const noConfig  = !gameConfig;

    const pitSource = getPitSource(eventKey);

    if (!source) {
        const hasPitData  = !!localStorage.getItem(`pitData_${eventKey}`);
        const pitLastSync = localStorage.getItem('lastSync_pitData');
        const pitSyncStatus = pitLastSync && hasPitData ? `Last sync: ${pitLastSync}` : hasPitData ? 'Data loaded' : 'No data yet';
        const pitSectionHtml = pitSource
            ? `<div>
                   <div style="color:#94a3b8;font-size:0.75em;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px;">Pit Scouting</div>
                   <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                       <span style="color:#34d399;font-size:0.78em;font-weight:700;">● Configured</span>
                   </div>
                   <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                       <button id="btn-syncPitData" onclick="syncPitData()">Sync Pit Data</button>
                       <span id="pit-sync-status" style="color:#475569;font-size:0.78em;">${pitSyncStatus}</span>
                   </div>
               </div>`
            : `<div>
                   <div style="color:#94a3b8;font-size:0.75em;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px;">Pit Scouting</div>
                   <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                       <input type="text" id="pitUrlInput" placeholder="Sheet ID or Google Sheets URL"
                           style="flex:1;min-width:260px;padding:8px 10px;border-radius:4px;border:1px solid #334155;background:#0f172a;color:#f8fafc;font-size:0.85em;">
                       <button onclick="savePitSheetUrl()">Save</button>
                   </div>
               </div>`;
        container.innerHTML = `
            <p style="color:#64748b;font-size:0.85em;margin:0 0 10px;">No match sheet configured for <strong style="color:#f8fafc;">${eventKey}</strong>.</p>
            <div style="display:flex;flex-direction:column;gap:10px;">
                <div>
                    <div style="color:#94a3b8;font-size:0.75em;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px;">Match Scouting</div>
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                        <input type="text" id="scoutingUrlInput" placeholder="Sheet ID or Google Sheets URL"
                            style="flex:1;min-width:260px;padding:8px 10px;border-radius:4px;border:1px solid #334155;background:#0f172a;color:#f8fafc;font-size:0.85em;">
                        <button onclick="saveScoutingSheetUrl()">Save</button>
                    </div>
                </div>
                ${pitSectionHtml}
            </div>`;
        return;
    }

    const matchBadge = isLive
        ? `<span style="color:#34d399;font-size:0.78em;font-weight:700;">● Live Sheet</span>`
        : `<span style="color:#60a5fa;font-size:0.78em;font-weight:700;">● Archive</span>`;
    const gameLabel = noConfig
        ? `<span style="color:#fbbf24;font-size:0.78em;">⚠ No game config for ${eventKey.match(/^\d{4}/)?.[0] ?? '?'}</span>`
        : `<span style="color:#64748b;font-size:0.78em;">Game: <strong style="color:#94a3b8;">${gameConfig.name} ${gameConfig.year}</strong></span>`;

    const hasPitData   = !!localStorage.getItem(`pitData_${eventKey}`);
    const pitLastSync  = localStorage.getItem('lastSync_pitData');
    const syncStatus    = lastSync && hasData ? `Last sync: ${lastSync}` : hasData ? 'Data loaded' : 'No data yet';
    const pitSyncStatus = pitLastSync && hasPitData ? `Last sync: ${pitLastSync}` : hasPitData ? 'Data loaded' : 'No data yet';

    const pitBlock = pitSource
        ? `<div style="display:flex;flex-direction:column;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid #1e293b;">
               <div style="display:flex;align-items:center;gap:8px;">
                   <span style="color:#64748b;font-size:0.85em;min-width:100px;">Pit Scouting</span>
                   <span style="color:#34d399;font-size:0.78em;font-weight:700;">● Configured</span>
               </div>
               <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                   <button id="btn-syncPitData" onclick="syncPitData()">Sync Pit Data</button>
                   <span id="pit-sync-status" style="color:#475569;font-size:0.78em;">${pitSyncStatus}</span>
               </div>
           </div>`
        : `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #1e293b;">
               <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                   <span style="color:#64748b;font-size:0.85em;min-width:100px;">Pit Scouting</span>
                   <input type="text" id="pitUrlInput" placeholder="Sheet ID or Google Sheets URL"
                       style="flex:1;min-width:220px;padding:8px 10px;border-radius:4px;border:1px solid #334155;background:#0f172a;color:#f8fafc;font-size:0.85em;">
                   <button onclick="savePitSheetUrl()">Save</button>
               </div>
           </div>`;

    container.innerHTML = `
        <div style="margin-bottom:12px;">
            <div style="display:flex;flex-direction:column;gap:6px;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="color:#64748b;font-size:0.85em;min-width:100px;">Match Scouting</span>
                    ${matchBadge}
                    ${gameLabel}
                </div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                    <button id="btn-syncScoutingData" onclick="syncScoutingData()">Sync Match Data</button>
                    <span id="scouting-sync-status" style="color:#475569;font-size:0.78em;">${syncStatus}</span>
                </div>
            </div>
            ${pitBlock}
        </div>
        ${isLive ? `
        <div style="padding-top:10px;border-top:1px solid #1e293b;">
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                <button id="scoutingAutoSyncBtn" onclick="toggleScoutingAutoSync()" style="background:#059669;">Start Auto-Sync</button>
                <select id="scoutingAutoSyncInterval" style="padding:7px 10px;border-radius:4px;border:1px solid #334155;background:#1e293b;color:#f8fafc;font-size:0.9rem;cursor:pointer;">
                    <option value="5">Every 5 min</option>
                    <option value="7">Every 7 min</option>
                    <option value="10">Every 10 min</option>
                </select>
                <span id="scoutingAutoSyncStatus" style="color:#94a3b8;font-size:0.85em;font-variant-numeric:tabular-nums;"></span>
            </div>
        </div>` : ''}`;

    updateOBEStatus(eventKey);
}

window.clearCache = async function () {
    if (!confirm("Clear all API data (Statbotics + TBA)? This cannot be undone.")) {
        return;
    }

    try {
        await db.teams.clear();
        await db.tbaTeams.clear();
        await db.matches.clear();

        // Clear persisted sync state
        localStorage.removeItem('lastEventKey');
        updateAppEventKey(null);
        localStorage.removeItem('pickListOrder');
        localStorage.removeItem('mockDraftState');
        localStorage.removeItem('realDraftState');
        localStorage.removeItem('draftState');
        for (const key of ['statboticsLive', 'tbaOPR', 'tbaMatches']) {
            localStorage.removeItem(`lastSync_${key}`);
            const el = document.getElementById(`ts-${key}`);
            if (el) el.textContent = '';
        }
        Object.keys(localStorage).filter(k => k.startsWith('archiveCoverage_')).forEach(k => localStorage.removeItem(k));
        updateOBEStatus(null);

        // Clear the event key input
        const input = document.getElementById('eventKeyInput');
        if (input) input.value = '';

        const statusDiv = document.getElementById('status');
        if (statusDiv) statusDiv.innerText = 'Cache cleared.';

        displayTeams();
        displaySchedule();

        console.log("Database cache cleared.");
    } catch (err) {
        console.error("Error clearing cache:", err);
        alert("Failed to clear cache. Check console for details.");
    }
};

window.clearEvent = async function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) { alert('No event key set — enter one first.'); return; }
    if (!confirm(`Clear all data for ${eventKey} (API cache, scouting, and pit data)? This cannot be undone.`)) return;

    try {
        await db.teams.clear();
        await db.tbaTeams.clear();
        await db.matches.clear();

        for (const key of ['statboticsLive', 'tbaOPR', 'tbaMatches', 'statboticsProjections']) {
            localStorage.removeItem(`lastSync_${key}`);
            const el = document.getElementById(`ts-${key}`);
            if (el) el.textContent = '';
        }
        localStorage.removeItem(`archiveCoverage_${eventKey}`);
        updateOBEStatus(eventKey);
        localStorage.removeItem(`scoutingData_${eventKey}`);
        localStorage.removeItem(`scoutingFusedStats_${eventKey}`);
        localStorage.removeItem('lastSync_scoutingData');
        localStorage.removeItem(`pitData_${eventKey}`);
        localStorage.removeItem('lastSync_pitData');
        localStorage.removeItem(`tbaAlliances_${eventKey}`);
        localStorage.removeItem('mockDraftState');
        localStorage.removeItem('realDraftState');
        localStorage.removeItem(`rpThresholds_${eventKey}`);
        localStorage.removeItem(`wlCalibrationBeta_${eventKey}`);
        localStorage.removeItem(`wlPreEventSnapshot_${eventKey}`);
        localStorage.removeItem(`webcasts_${eventKey}`);

        // Clear module-level caches so stale data doesn't persist across renders
        _bannerMatchTime = null;
        const _cb = document.getElementById('match-countdown-banner');
        if (_cb) _cb.style.display = 'none';
        wlDetailCache = null;
        wlPreEventCache = null;
        wlComputedAsOf = null;
        wlCalibrationBeta = 0.982;
        watchListDirty = true;

        // Destroy chart instances so old data doesn't show on cleared canvases
        if (teamChartInstance) { teamChartInstance.destroy(); teamChartInstance = null; }
        if (tbaChartInstance) { tbaChartInstance.destroy(); tbaChartInstance = null; }
        if (matchInfluenceChartInstance) { matchInfluenceChartInstance.destroy(); matchInfluenceChartInstance = null; }
        if (dashboardChartInstance) { dashboardChartInstance.destroy(); dashboardChartInstance = null; }

        await displayTeams();
        await displayTBATeams();
        await displaySchedule();
        await renderAtAGlance();
        await renderPickList();
        renderScoutingSection();
        displayScoutingTeams();
    } catch (err) {
        console.error('Error clearing event:', err);
        alert('Failed to clear event data. Check console for details.');
    }
};

window.clearScoutingData = function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) return;
    if (!confirm(`Clear scouting data for ${eventKey}? This cannot be undone.`)) return;
    localStorage.removeItem(`scoutingData_${eventKey}`);
    localStorage.removeItem(`scoutingFusedStats_${eventKey}`);
    localStorage.removeItem('lastSync_scoutingData');
    renderScoutingSection();
    displayScoutingTeams();
};

window.clearPitData = function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) return;
    if (!confirm(`Clear pit scouting data for ${eventKey}? This cannot be undone.`)) return;
    localStorage.removeItem(`pitData_${eventKey}`);
    localStorage.removeItem('lastSync_pitData');
    renderScoutingSection();
};

window.clearScouting = function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) return;
    if (!confirm(`Clear all scouting data (match + pit) for ${eventKey}? This cannot be undone.`)) return;
    localStorage.removeItem(`scoutingData_${eventKey}`);
    localStorage.removeItem(`scoutingFusedStats_${eventKey}`);
    localStorage.removeItem('lastSync_scoutingData');
    localStorage.removeItem(`pitData_${eventKey}`);
    localStorage.removeItem('lastSync_pitData');
    renderScoutingSection();
    displayScoutingTeams();
};




window.runManualAnalysis = async function () {
    if (!activeTeamNumber) {
        console.error("No active team selected.");
        return;
    }

    // --- FIX: The Bulletproof Fetch ---
    // Try it exactly as stored first, then fallback to Integer just in case
    let team = await db.teams.get(activeTeamNumber);
    if (!team) {
        team = await db.teams.get(parseInt(activeTeamNumber));
    }

    if (!team) {
        alert("Error: Could not load team data from database.");
        return;
    }

    const startInput = parseInt(document.getElementById('mathStart').value);
    const endInput = parseInt(document.getElementById('mathEnd').value);

    // Get only the completed matches with EPA
    const playedMatches = team.rawStatboticsData.filter(m => m.epa?.post);

    // Slice based on match index (1-based for user friendliness)
    const selection = playedMatches.slice(startInput - 1, endInput);
    const epaTimeline = selection.map(m => m.epa.post);

    if (epaTimeline.length < 5) {
        document.getElementById('analysisFeedback').innerText = "❌ Need at least 5 matches in range.";
        return;
    }

    document.getElementById('analysisFeedback').innerText = "Calculating...";

    // Run the Math
    const fitParams = fitExponentialGrowth(epaTimeline);
    const analysis = getBootstrappedCeiling(epaTimeline);

    // Temporarily store it on the object so the chart can see it
    team.analysis = analysis;
    team.analysis.rawParams = fitParams;
    team.analysis.startIndex = startInput - 1; // Used for chart alignment

    // Update UI Stats
    document.getElementById('detailStats').innerHTML = `
        <div style="background:#333; padding:15px; border-radius:8px;">
            <label style="color:#888; font-size:0.8em;">RANGE CURRENT</label>
            <div style="font-size:1.5em; font-weight:bold;">${epaTimeline[epaTimeline.length - 1]}</div>
        </div>
        <div style="background:#333; padding:15px; border-radius:8px;">
            <label style="color:#888; font-size:0.8em;">PROJECTED CEILING</label>
            <div style="font-size:1.5em; font-weight:bold; color:#4ade80;">${analysis.ceiling}</div>
        </div>
        <div style="background:#333; padding:15px; border-radius:8px;">
            <label style="color:#888; font-size:0.8em;">CONFIDENCE</label>
            <div>${analysis.lowerBound} - ${analysis.upperBound}</div>
        </div>
    `;

    // SAVE THE ANALYSIS: This makes the result show up in the main table permanently
    await db.teams.update(team.teamNumber, {
        analysis: team.analysis
    });

    refreshEPADisplays();

    document.getElementById('analysisFeedback').innerText = `✅ Analysis complete for matches ${startInput} to ${Math.min(endInput, playedMatches.length)}.`;

    // Re-draw the chart with the new trendline
    renderChart(team);
};




// 7. UI HOOKS
const eventInput = document.getElementById('eventKeyInput');


function fitExponentialGrowth(timeline) {
    const n = timeline.length;
    const maxObserved = Math.max(...timeline);

    let bestA = 0, bestB = 0, bestK = 0;
    let lowestError = Infinity;

    // We know the true ceiling (A) must be higher than their current highest score.
    // We will test every possible ceiling from just above their max, up to 3x their max.
    const startA = maxObserved + 0.1;
    const endA = maxObserved * 3.0;
    const stepA = 0.5;

    for (let A = startA; A <= endA; A += stepA) {

        // --- LOG-LINEARIZATION ---
        // By looking at ln(A - y), we turn the exponential curve into a straight line.
        // This allows us to use Exact Algebraic Least Squares to find the perfect slope.
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        let validPoints = 0;

        for (let i = 0; i < n; i++) {
            const x = i + 1;
            const y = timeline[i];

            // Calculate the linearized Y value
            const Y = Math.log(A - y);

            sumX += x;
            sumY += Y;
            sumXY += x * Y;
            sumXX += x * x;
            validPoints++;
        }

        // Closed-form linear regression formulas (No learning rates, perfect accuracy)
        const denominator = (validPoints * sumXX) - (sumX * sumX);
        if (denominator === 0) continue;

        const m = ((validPoints * sumXY) - (sumX * sumY)) / denominator;
        const C = (sumY - m * sumX) / validPoints;

        // Convert the linear line back into our exponential variables
        const k = -m;
        const B = Math.exp(C);

        // We only care about positive growth. If the math suggests they are getting worse, ignore it.
        if (k <= 0) continue;

        // --- NON-LINEAR ERROR CHECK ---
        // Check how well these exact parameters fit the actual raw dots on the chart
        let totalSquaredError = 0;
        for (let i = 0; i < n; i++) {
            const x = i + 1;
            const prediction = A - B * Math.exp(-k * x);
            const error = prediction - timeline[i];
            totalSquaredError += error * error; // True Least Squares calculation
        }

        // If this ceiling produced the lowest overall error, save it as the winner
        if (totalSquaredError < lowestError) {
            lowestError = totalSquaredError;
            bestA = A;
            bestB = B;
            bestK = k;
        }
    }

    // Fallback if the data is entirely flat
    if (lowestError === Infinity) {
        return { A: maxObserved, B: 0, k: 0.1, n };
    }

    return { A: bestA, B: bestB, k: bestK, n };
}

function getBootstrappedCeiling(timeline) {
    if (timeline.length < 5) return { ceiling: "N/A" };

    const originalFit = fitExponentialGrowth(timeline);

    const residuals = timeline.map((y, i) => {
        const x = i + 1;
        return y - (originalFit.A - originalFit.B * Math.exp(-originalFit.k * x));
    });

    const bootstrapResults = [];
    for (let b = 0; b < 100; b++) {
        const syntheticTimeline = timeline.map((y, i) => {
            const x = i + 1;
            const randomResid = residuals[Math.floor(Math.random() * residuals.length)];
            const val = (originalFit.A - originalFit.B * Math.exp(-originalFit.k * x)) + randomResid;
            return val;
        });

        const fit = fitExponentialGrowth(syntheticTimeline);
        bootstrapResults.push(fit.A);
    }

    bootstrapResults.sort((a, b) => a - b);

    return {
        ceiling: originalFit.A.toFixed(1),
        lowerBound: bootstrapResults[Math.floor(bootstrapResults.length * 0.05)].toFixed(1),
        upperBound: bootstrapResults[Math.floor(bootstrapResults.length * 0.95)].toFixed(1),
        rawParams: originalFit
    };
}

let currentSortKey = 'ceiling'; // Default sort
let currentSortOrder = 1; // 1 for descending, -1 for ascending
let currentSortColumn = 'ceiling'; // Add this line

window.sortBy = function (column) {
    if (currentSortColumn === column) {
        // If clicking the same column, flip the direction
        currentSortOrder *= -1;
    } else {
        // If clicking a new column, set it as active and default to Highest First
        currentSortColumn = column;
        currentSortOrder = 1;

        // Exception: Team Numbers usually make more sense sorted Lowest First
        if (column === 'teamNumber') currentSortOrder = -1;
    }
    displayTeams(); // Redraw the table with the new sorting rules
};




let teamChartInstance     = null;
let dashboardChartInstance = null;

function renderTeamChart(sortedTeams) {
    const ctx = document.getElementById('teamComparisonChart').getContext('2d');
    if (teamChartInstance) teamChartInstance.destroy();

    const isMobile = document.body.classList.contains('mobile-ui');
    // Prepare labels (Team Numbers)
    const labels = sortedTeams.map(t => t.teamNumber.toString());

    teamChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Auto',
                    data: sortedTeams.map(t => t.autoEPA || 0),
                    backgroundColor: '#fbbf24',
                    stack: 'EPA',
                    order: 10,
                },
                {
                    label: 'Teleop',
                    data: sortedTeams.map(t => t.teleopEPA || 0),
                    backgroundColor: '#3b82f6',
                    stack: 'EPA',
                    order: 10,
                },
                {
                    label: 'Endgame',
                    data: sortedTeams.map(t => t.endgameEPA || 0),
                    backgroundColor: '#10b981',
                    stack: 'EPA',
                    order: 10,
                },
                {
                    type: 'scatter',
                    label: 'EPA',
                    data: sortedTeams.map(t => t.currentEPA || 0),
                    backgroundColor: sortedTeams.map(t => {
                        const c = t.analysis?.ceiling;
                        return (c != null && c !== '—' && c !== 'N/A') ? 'rgba(0,0,0,0)' : '#ffffff';
                    }),
                    borderColor: '#ffffff',
                    borderWidth: 2,
                    pointStyle: 'circle',
                    pointRadius: isMobile ? 2.5 : 5,
                    pointHoverRadius: isMobile ? 4 : 7,
                    order: 1,
                },
                {
                    type: 'line',
                    label: 'Ceiling',
                    data: sortedTeams.map(t => {
                        const c = t.analysis?.ceiling;
                        return (c != null && c !== '—' && c !== 'N/A') ? parseFloat(c) : null;
                    }),
                    borderColor: '#4ade80',
                    borderDash: [5, 5],
                    borderWidth: 1.5,
                    pointBackgroundColor: '#ffffff',
                    pointBorderColor: '#ffffff',
                    pointStyle: 'circle',
                    pointRadius: isMobile ? 3 : 6,
                    pointHoverRadius: isMobile ? 4 : 8,
                    spanGaps: false,
                    fill: false,
                    order: 2,
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    stacked: true,
                    grid: { display: false },
                    ticks: { color: '#94a3b8', font: { size: 10 } }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: '#334155' },
                    ticks: { color: '#94a3b8' },
                    title: { display: true, text: 'Expected Points Added (EPA)', color: '#94a3b8' }
                }
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: { color: '#f8fafc', usePointStyle: true }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            }
        }
    });
}




window.displayTeams = async function () {
    const allTeams = await db.teams.toArray();
    const tableBody = document.getElementById('teamBody');
    //const searchVal = document.getElementById('teamSearch')?.value || '';
    const table = document.getElementById('teamTable');

    if (allTeams.length === 0) {
        table.style.display = 'none';
        return;
    }
    table.style.display = 'table';

    // Compute tier by ceiling EPA rank across all teams
    const sortedForTier = [...allTeams].sort((a, b) =>
        (b.analysis?.ceiling || b.currentEPA || 0) - (a.analysis?.ceiling || a.currentEPA || 0));
    const teamTierMap = new Map(sortedForTier.map((t, i) => [
        t.teamNumber, i < 8 ? 'S' : i < 20 ? 'A' : i < 32 ? 'B' : 'C'
    ]));

    // 2. Sort logic (Maintains your preferred order)
    allTeams.sort((a, b) => {
        let valA, valB;

        switch (currentSortColumn) {
            case 'teamNumber':
                valA = a.teamNumber;
                valB = b.teamNumber;
                break;
            case 'autoEPA':
                valA = a.autoEPA || 0;
                valB = b.autoEPA || 0;
                break;
            case 'teleopEPA':
                valA = a.teleopEPA || 0;
                valB = b.teleopEPA || 0;
                break;
            case 'endgameEPA':
                valA = a.endgameEPA || 0;
                valB = b.endgameEPA || 0;
                break;
            case 'currentEPA':
                valA = a.currentEPA || 0;
                valB = b.currentEPA || 0;
                break;
            case 'ceiling':
            default:
                valA = a.analysis?.ceiling || a.currentEPA || 0;
                valB = b.analysis?.ceiling || b.currentEPA || 0;
                break;
        }

        // parseFloat ensures we are doing math on numbers, not strings
        return (parseFloat(valB) - parseFloat(valA)) * currentSortOrder;
    });

    // 2. Render the Chart with the current list
    renderTeamChart(allTeams);

    tableBody.innerHTML = '';

    allTeams.forEach(team => {
        const analysis = team.analysis || { ceiling: "—", lowerBound: "—", upperBound: "—" };
        const { ceiling, lowerBound, upperBound } = analysis;

        const tier = teamTierMap.get(team.teamNumber) || 'C';
        const row = document.createElement('tr');
        row.style.backgroundColor = TIER_STYLE[tier].bg;
        row.style.borderLeft = `6px solid ${TIER_STYLE[tier].color}`;

        // --- THE FIX ---
        // 1. Change the mouse to a pointer so it feels like a button
        row.style.cursor = 'pointer';

        // 2. Attach the click event to the entire row safely
        row.onclick = () => viewTeamDetail(team.teamNumber, 'epa-opr');

        // Notice we removed the onclick="" from the <td> string
        row.innerHTML = `
            <td>${tierBadge(tier)}</td>
            <td style="white-space:nowrap;"><strong>${team.teamNumber}</strong>${ownStar(team.teamNumber)}</td>
            <td>${team.currentEPA ? team.currentEPA.toFixed(1) : 'N/A'}</td>
            <td class="ceiling-cell"><strong>${ceiling}</strong></td>
            <td style="color:#aaa;">${team.autoEPA ? team.autoEPA.toFixed(1) : '-'}</td>
            <td style="color:#aaa;">${team.teleopEPA ? team.teleopEPA.toFixed(1) : '-'}</td>
            <td style="color:#aaa;">${team.endgameEPA ? team.endgameEPA.toFixed(1) : '-'}</td>
        `;

        tableBody.appendChild(row);
    });
}


// And add this at the very bottom of main.js to load on startup
displayTeams();




window.setSort = function (key) {
    if (currentSortKey === key) {
        currentSortOrder *= -1;
    } else {
        currentSortKey = key;
        currentSortOrder = -1;
    }
    displayTeams();
};

// ─── OPR COMPUTATION ────────────────────────────────────────────────────────

// Works on local db.matches records (red/blue string arrays, redScore/blueScore).
// Returns OPR array indexed the same as teamNumbers, or null if underdetermined.
function computeLocalOPR(matches, teamNumbers) {
    const keys = teamNumbers.map(String);
    const n = keys.length;
    if (n === 0) return null;
    const idx = Object.fromEntries(keys.map((k, i) => [k, i]));
    const rows = [], scores = [];
    for (const m of matches) {
        if ((m.redScore ?? -1) < 0) continue;
        for (const [alliance, score] of [
            [(m.red || []).map(String), m.redScore],
            [(m.blue || []).map(String), m.blueScore]
        ]) {
            const row = new Array(n).fill(0);
            for (const t of alliance) { if (idx[t] !== undefined) row[idx[t]] = 1; }
            rows.push(row);
            scores.push(score);
        }
    }
    if (rows.length < n) return null;
    const ATA = Array.from({ length: n }, () => new Array(n).fill(0));
    const ATb = new Array(n).fill(0);
    for (let k = 0; k < rows.length; k++) {
        for (let i = 0; i < n; i++) {
            if (!rows[k][i]) continue;
            ATb[i] += scores[k];
            for (let j = 0; j < n; j++) ATA[i][j] += rows[k][j];
        }
    }
    return gaussianElim(ATA, ATb);
}

function gaussianElim(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
        let maxRow = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
        }
        [M[col], M[maxRow]] = [M[maxRow], M[col]];
        if (Math.abs(M[col][col]) < 1e-10) continue;
        for (let row = 0; row < n; row++) {
            if (row === col) continue;
            const f = M[row][col] / M[col][col];
            for (let k = col; k <= n; k++) M[row][k] -= f * M[col][k];
        }
    }
    return Array.from({ length: n }, (_, i) => M[i][i] === 0 ? 0 : M[i][n] / M[i][i]);
}

function computeOPR(matches, teamKeys, getScore) {
    const n = teamKeys.length;
    if (n === 0) return null;
    const idx = Object.fromEntries(teamKeys.map((k, i) => [k, i]));
    const rows = [], scores = [];
    for (const m of matches) {
        if (m.comp_level !== 'qm' || !m.alliances) continue;
        for (const color of ['red', 'blue']) {
            const score = m.score_breakdown ? getScore(m.score_breakdown[color]) : null;
            if (score == null || isNaN(score)) continue;
            const row = new Array(n).fill(0);
            for (const key of (m.alliances[color].team_keys || [])) {
                if (idx[key] !== undefined) row[idx[key]] = 1;
            }
            rows.push(row);
            scores.push(score);
        }
    }
    if (rows.length < n) return null;
    const ATA = Array.from({ length: n }, () => new Array(n).fill(0));
    const ATb = new Array(n).fill(0);
    for (let k = 0; k < rows.length; k++) {
        for (let i = 0; i < n; i++) {
            if (!rows[k][i]) continue;
            ATb[i] += scores[k];
            for (let j = 0; j < n; j++) ATA[i][j] += rows[k][j];
        }
    }
    return gaussianElim(ATA, ATb);
}

// ─── TBA OPR SYNC ────────────────────────────────────────────────────────────

window.syncTBAOPR = async function () {
    const eventKey = document.getElementById('eventKeyInput').value.trim().toLowerCase();
    if (!eventKey) return alert("Please enter an Event Key.");
    const statusDiv = document.getElementById('status');
    statusDiv.innerText = "Fetching TBA OPR & COPR data...";
    try {
        const [oprData, coprData] = await Promise.all([
            fetchTBA(`/event/${eventKey}/oprs`),
            fetchTBA(`/event/${eventKey}/coprs`)
        ]);
        if (!oprData?.oprs) throw new Error("No OPR data found. Event may not have played yet.");

        // Detect component fields from COPRs response
        let autoMap = null, teleopMap = null, endgameMap = null;
        if (coprData && typeof coprData === 'object' && !coprData.Errors) {
            const keys = Object.keys(coprData);
            console.log('[TBA COPRs] Available components:', keys.join(', '));
            const autoKey = ['totalAutoPoints', 'autoPoints'].find(k => keys.includes(k));
            const teleopKey = ['totalTeleopPoints', 'teleopPoints'].find(k => keys.includes(k));
            if (autoKey) autoMap = coprData[autoKey];
            if (teleopKey) teleopMap = coprData[teleopKey];
            // Endgame = tower climbing + fuel scored during the endgame window
            const towerMap = coprData['endGameTowerPoints'] || null;
            const endgameFuelMap = coprData['Hub Endgame Fuel Count'] || null;
            if (towerMap || endgameFuelMap) {
                const allKeys = Object.keys(towerMap || endgameFuelMap);
                endgameMap = Object.fromEntries(
                    allKeys.map(k => [k, (towerMap?.[k] || 0) + (endgameFuelMap?.[k] || 0)])
                );
            }
        }

        const teamKeys = Object.keys(oprData.oprs).sort();
        const records = teamKeys.map(key => ({
            teamNumber: parseInt(key.replace('frc', '')),
            teamKey: key,
            eventKey,
            opr: +(oprData.oprs[key] || 0).toFixed(2),
            dpr: +(oprData.dprs[key] || 0).toFixed(2),
            ccwm: +(oprData.ccwms[key] || 0).toFixed(2),
            autoOPR: autoMap ? +(autoMap[key] || 0).toFixed(2) : null,
            teleopOPR: teleopMap ? +(teleopMap[key] || 0).toFixed(2) : null,
            endgameOPR: endgameMap ? +(endgameMap[key] || 0).toFixed(2) : null,
            lastUpdated: Date.now()
        }));
        await db.tbaTeams.bulkPut(records);
        setSyncTimestamp('tbaOPR');
        statusDiv.innerText = `✅ TBA OPR synced for ${records.length} teams.`;
        await displayTBATeams();
    } catch (err) {
        console.error(err);
        statusDiv.innerText = `❌ TBA OPR Sync Failed: ${err.message}`;
    }
};

// Detects score breakdown field names and recomputes component OPRs from stored match data.
async function recomputeComponentOPRs(matches, eventKey) {
    const tbaTeams = await db.tbaTeams.where('eventKey').equals(eventKey).toArray();
    if (tbaTeams.length === 0) return;
    const teamKeys = tbaTeams.map(t => t.teamKey).sort();

    const sampleBd = matches.find(m => m.score_breakdown?.red)?.score_breakdown?.red;
    if (!sampleBd) {
        console.log('[TBA] No score breakdowns available — matches may not have been played yet.');
        return;
    }
    const fields = Object.keys(sampleBd);
    console.log('[TBA] Score breakdown fields:', fields.join(', '));

    const autoF = ['autoPoints'].find(f => fields.includes(f));
    const teleopF = ['teleopPoints'].find(f => fields.includes(f));
    const endgameF = ['endgamePoints', 'endGamePoints', 'endgameBargePoints', 'endgameTotalStagePoints']
        .find(f => fields.includes(f));
    console.log(`[TBA] Mapping → auto:${autoF} | teleop:${teleopF} | endgame:${endgameF}`);

    const autoOPRs = autoF ? computeOPR(matches, teamKeys, bd => bd?.[autoF] ?? null) : null;
    const teleopOPRs = teleopF ? computeOPR(matches, teamKeys, bd => bd?.[teleopF] ?? null) : null;
    const endgameOPRs = endgameF ? computeOPR(matches, teamKeys, bd => bd?.[endgameF] ?? null) : null;

    const updates = tbaTeams.map(team => {
        const i = teamKeys.indexOf(team.teamKey);
        if (i === -1) return team;
        return {
            ...team,
            autoOPR: autoOPRs ? +autoOPRs[i].toFixed(2) : null,
            teleopOPR: teleopOPRs ? +teleopOPRs[i].toFixed(2) : null,
            endgameOPR: endgameOPRs ? +endgameOPRs[i].toFixed(2) : null,
        };
    });
    await db.tbaTeams.bulkPut(updates);
}

window.syncTBAMatches = async function () {
    const eventKey = document.getElementById('eventKeyInput').value.trim().toLowerCase();
    if (!eventKey) return alert("Please enter an Event Key.");
    const statusDiv = document.getElementById('status');
    statusDiv.innerText = "Fetching full match data from TBA...";
    try {
        const matches = await fetchTBA(`/event/${eventKey}/matches`);
        if (!Array.isArray(matches)) throw new Error("Invalid match data from TBA.");

        const qualMatches = matches
            .filter(m => m.comp_level === 'qm')
            .sort((a, b) => a.match_number - b.match_number);

        // Snapshot already-scored matches before overwriting, for new-score notifications
        const scoredBefore = new Set(
            (await db.matches.where('eventKey').equals(eventKey).toArray())
                .filter(m => m.redScore > -1).map(m => m.key)
        );

        const records = qualMatches.map(m => ({
            key: m.key,
            eventKey,
            matchNumber: m.match_number,
            red: (m.alliances?.red?.team_keys || []).map(k => k.replace('frc', '')),
            blue: (m.alliances?.blue?.team_keys || []).map(k => k.replace('frc', '')),
            redScore: m.alliances?.red?.score ?? -1,
            blueScore: m.alliances?.blue?.score ?? -1,
            redBreakdown: m.score_breakdown?.red || null,
            blueBreakdown: m.score_breakdown?.blue || null,
            predictedTime: m.predicted_time || null,
            actualTime: m.actual_time || null,
            videos: (m.videos || []).filter(v => v.type === 'youtube').map(v => v.key),
        }));
        await db.matches.bulkPut(records);

        // Notify for each newly posted score that involves the focused team
        const focused = window.currentFocusedTeam;
        if (focused) {
            for (const r of records) {
                if (r.redScore > -1 && !scoredBefore.has(r.key)) {
                    const allTeams = [...(r.red || []), ...(r.blue || [])];
                    if (allTeams.includes(focused)) {
                        const notifId = `score-${r.key}`;
                        if (!_firedNotifIds.has(notifId)) {
                            _firedNotifIds.add(notifId);
                            const redWon = r.redScore > r.blueScore;
                            const result = redWon ? 'Red wins' : r.blueScore > r.redScore ? 'Blue wins' : 'Tie';
                            fireNotif(
                                `QM ${r.matchNumber} scored — ${result}`,
                                `${r.redScore}–${r.blueScore} · Red: ${(r.red||[]).join(', ')} · Blue: ${(r.blue||[]).join(', ')}`,
                                notifId
                            );
                        }
                    }
                }
            }
        }

        setSyncTimestamp('tbaMatches');
        watchListDirty = true;
        statusDiv.innerText = `✅ TBA Matches synced (${records.length} qual matches).`;
        displaySchedule();
    } catch (err) {
        console.error(err);
        statusDiv.innerText = `❌ TBA Matches Sync Failed: ${err.message}`;
    }
};


// ─── TBA CHART & TABLE ───────────────────────────────────────────────────────

let tbaChartInstance = null;
let tbaSortColumn = 'opr';
let tbaSortOrder = 1;
let matchInfluenceChartInstance = null;
let currentTBATab = 'teams';

window.sortTBABy = function (column) {
    if (tbaSortColumn === column) {
        tbaSortOrder *= -1;
    } else {
        tbaSortColumn = column;
        tbaSortOrder = column === 'teamNumber' ? -1 : 1;
    }
    displayTBATeams();
};

function renderTBAChart(teams, effOPR) {
    const ctx = document.getElementById('tbaComparisonChart').getContext('2d');
    if (tbaChartInstance) tbaChartInstance.destroy();
    const isMobile = document.body.classList.contains('mobile-ui');
    const hasComponents = teams.some(t => t.autoOPR != null);
    const labels = teams.map(t => t.teamNumber.toString());
    const getOPR = effOPR || (t => t.opr || 0);
    const datasets = hasComponents ? [
        { label: 'Auto OPR', data: teams.map(t => t.autoOPR || 0), backgroundColor: '#fbbf24', stack: 'OPR', order: 10 },
        { label: 'Teleop OPR', data: teams.map(t => t.teleopOPR || 0), backgroundColor: '#3b82f6', stack: 'OPR', order: 10 },
        { label: 'Endgame OPR', data: teams.map(t => t.endgameOPR || 0), backgroundColor: '#10b981', stack: 'OPR', order: 10 }
    ] : [
        { label: 'OPR', data: teams.map(t => t.opr || 0), backgroundColor: '#3b82f6', stack: 'OPR', order: 10 }
    ];
    datasets.push({
        type: 'scatter',
        label: 'OPR',
        data: teams.map(getOPR),
        backgroundColor: '#ffffff',
        borderColor: '#ffffff',
        borderWidth: 2,
        pointStyle: 'circle',
        pointRadius: isMobile ? 2.5 : 5,
        pointHoverRadius: isMobile ? 4 : 7,
        order: 1,
    });
    tbaChartInstance = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { stacked: true, grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 } } },
                y: {
                    beginAtZero: true, stacked: true, grid: { color: '#334155' }, ticks: { color: '#94a3b8' },
                    title: { display: true, text: 'OPR', color: '#94a3b8' }
                }
            },
            plugins: {
                legend: { position: 'top', labels: { color: '#f8fafc', usePointStyle: true } },
                tooltip: { mode: 'index', intersect: false }
            }
        }
    });
}

window.displayTBATeams = async function () {
    const allTeams = await db.tbaTeams.toArray();
    const allMatches = await db.matches.toArray();
    const tableBody = document.getElementById('tbaBody');
    const table = document.getElementById('tbaTable');
    const globalIgnoreNote = document.getElementById('tbaGlobalIgnoreNote');
    if (allTeams.length === 0) { table.style.display = 'none'; return; }

    // Recompute OPR excluding any globally ignored matches.
    const globalIgnored = new Set(allMatches.filter(m => m.globallyIgnored).map(m => m.key));
    let globalOPRMap = null;
    if (globalIgnored.size > 0) {
        const teamNums = allTeams.map(t => t.teamNumber);
        const activePlayed = allMatches.filter(m =>
            (m.redScore ?? -1) >= 0 && (m.blueScore ?? -1) >= 0 && !globalIgnored.has(m.key)
        );
        const recomputed = computeLocalOPR(activePlayed, teamNums);
        if (recomputed) {
            globalOPRMap = Object.fromEntries(teamNums.map((num, i) => [num, recomputed[i]]));
        }
    }
    if (globalIgnoreNote) {
        if (globalIgnored.size > 0) {
            globalIgnoreNote.textContent = `OPRs recomputed excluding ${globalIgnored.size} globally ignored match${globalIgnored.size > 1 ? 'es' : ''}.`;
            globalIgnoreNote.style.display = 'block';
        } else {
            globalIgnoreNote.style.display = 'none';
        }
    }

    // Use individually-ignored LOO, then globally-recomputed OPR, then raw TBA OPR.
    const effOPR = t => {
        const keys = getTeamIgnoredKeys(t);
        if (keys.length > 0 && t.adjustedOPR != null && keys.some(k => !globalIgnored.has(k)))
            return t.adjustedOPR;
        if (globalOPRMap) return globalOPRMap[t.teamNumber] ?? (t.opr || 0);
        return t.opr || 0;
    };

    allTeams.sort((a, b) => {
        let valA, valB;
        switch (tbaSortColumn) {
            case 'teamNumber': valA = a.teamNumber; valB = b.teamNumber; break;
            case 'dpr': valA = a.dpr || 0; valB = b.dpr || 0; break;
            case 'ccwm': valA = a.ccwm || 0; valB = b.ccwm || 0; break;
            case 'autoOPR': valA = a.autoOPR ?? 0; valB = b.autoOPR ?? 0; break;
            case 'teleopOPR': valA = a.teleopOPR ?? 0; valB = b.teleopOPR ?? 0; break;
            case 'endgameOPR': valA = a.endgameOPR ?? 0; valB = b.endgameOPR ?? 0; break;
            default: valA = effOPR(a); valB = effOPR(b);
        }
        return (parseFloat(valB) - parseFloat(valA)) * tbaSortOrder;
    });
    const tbaForTier = [...allTeams].sort((a, b) => effOPR(b) - effOPR(a));
    const tbaTierMap = new Map(tbaForTier.map((t, i) => [
        t.teamNumber, i < 8 ? 'S' : i < 20 ? 'A' : i < 32 ? 'B' : 'C'
    ]));
    renderTBAChart(allTeams, effOPR);
    table.style.display = 'table';
    tableBody.innerHTML = '';
    const hasComponents = allTeams.some(t => t.autoOPR != null);
    allTeams.forEach(team => {
        const eff = effOPR(team);
        const tier = tbaTierMap.get(team.teamNumber) || 'C';
        const row = document.createElement('tr');
        row.style.backgroundColor = TIER_STYLE[tier].bg;
        row.style.borderLeft = `6px solid ${TIER_STYLE[tier].color}`;
        row.style.cursor = 'pointer';
        row.onclick = () => viewTeamDetail(team.teamNumber, 'epa-opr');
        const oprCell = getTeamIgnoredKeys(team).some(k => !globalIgnored.has(k))
            ? `${eff.toFixed(1)}&thinsp;<span style="color:#fbbf24; font-size:0.7em; font-weight:600;">ADJ</span>`
            : eff.toFixed(1);
        row.innerHTML = `
            <td>${tierBadge(tier)}</td>
            <td style="white-space:nowrap;"><strong>${team.teamNumber}</strong>${ownStar(team.teamNumber)}</td>
            <td>${oprCell}</td>
            <td style="color:${team.ccwm >= 0 ? '#4ade80' : '#f87171'}">${team.ccwm.toFixed(1)}</td>
            <td style="color:#aaa;">${hasComponents && team.autoOPR != null ? team.autoOPR.toFixed(1) : '—'}</td>
            <td style="color:#aaa;">${hasComponents && team.teleopOPR != null ? team.teleopOPR.toFixed(1) : '—'}</td>
            <td style="color:#aaa;">${hasComponents && team.endgameOPR != null ? team.endgameOPR.toFixed(1) : '—'}</td>
        `;
        tableBody.appendChild(row);
    });
};


// ─── HOME: AT A GLANCE ───────────────────────────────────────────────────────

let glanceSortColumn = 'rp';
let glanceSortOrder = 1; // 1 = descending

window.switchHomeTab = function (tab) {
    ['setup', 'overview'].forEach(t => {
        const display = t === tab ? (t === 'setup' ? 'grid' : 'block') : 'none';
        document.getElementById(`home-tab-${t}`).style.display = display;
    });
    document.querySelectorAll('#homeTabs .detail-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['setup', 'overview'][i] === tab);
    });
    if (tab === 'overview') renderAtAGlance();
};

window.sortGlanceBy = function (col) {
    if (glanceSortColumn === col) {
        glanceSortOrder *= -1;
    } else {
        glanceSortColumn = col;
        glanceSortOrder = 1;
    }
    renderAtAGlance();
};

let dashboardChartCondensed = true;
let lastDashboardRows       = null;

window.toggleDashboardCondense = function () {
    dashboardChartCondensed = !dashboardChartCondensed;
    const btn = document.getElementById('dashboardCondenseBtn');
    if (btn) btn.textContent = dashboardChartCondensed ? 'Expand' : 'Condense';
    if (lastDashboardRows) renderDashboardChart(lastDashboardRows);
};

function renderDashboardChart(rows) {
    lastDashboardRows = rows;
    const canvas = document.getElementById('dashboardComparisonChart');
    if (!canvas) return;
    if (dashboardChartInstance) { dashboardChartInstance.destroy(); dashboardChartInstance = null; }

    const labels  = rows.map(r => String(r.team.teamNumber));
    const epas    = rows.map(r => r.epaVal   ?? null);
    const oprs    = rows.map(r => r.opr      ?? null);
    const scouts  = rows.map(r => r.scoutEPA ?? null);
    const hasOPR   = oprs.some(v => v != null);
    const hasScout = scouts.some(v => v != null);

    const datasets = [
        { label: 'Statbotics EPA', data: epas,   backgroundColor: '#f59e0baa', borderColor: '#f59e0b', borderWidth: 1 },
        ...(hasOPR   ? [{ label: 'TBA OPR',   data: oprs,   backgroundColor: '#60a5faaa', borderColor: '#60a5fa', borderWidth: 1 }] : []),
        ...(hasScout ? [{ label: 'Scout EPA',  data: scouts, backgroundColor: '#4ade80aa', borderColor: '#4ade80', borderWidth: 1 }] : []),
    ];

    // Per-team column width: condensed aims to fit ~800px; expanded gives comfortable spacing.
    const perTeam = dashboardChartCondensed
        ? Math.max(14, Math.floor(800 / Math.max(rows.length, 1)))
        : 52;
    const w = Math.max(640, rows.length * perTeam);
    canvas.width  = w;  canvas.style.width  = w + 'px';
    canvas.height = 240; canvas.style.height = '240px';

    // Subtle tier-colored background band behind each team's bar group.
    const TIER_RGBA = { S: 'rgba(245,158,11,0.13)', A: 'rgba(74,222,128,0.10)',
                        B: 'rgba(168,85,247,0.09)',  C: 'rgba(100,116,139,0.05)' };
    const tierColors = rows.map(r => TIER_RGBA[r.tier] ?? TIER_RGBA.C);

    const tierBgPlugin = {
        id: 'dashboardTierBg',
        beforeDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            if (!chartArea) return;
            const step = scales.x.width / Math.max(labels.length, 1);
            const half = step / 2;
            ctx.save();
            tierColors.forEach((color, i) => {
                const cx = scales.x.getPixelForValue(i);
                ctx.fillStyle = color;
                ctx.fillRect(cx - half, chartArea.top, step, chartArea.bottom - chartArea.top);
            });
            ctx.restore();
        },
    };

    const condensed = dashboardChartCondensed;
    dashboardChartInstance = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels, datasets },
        plugins: [tierBgPlugin],
        options: {
            responsive: false,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { labels: { color: '#94a3b8', font: { size: 11 } } },
                tooltip: { callbacks: { title: ctx => 'Team ' + ctx[0].label } },
            },
            scales: {
                x: {
                    ticks: {
                        color: '#94a3b8',
                        font: { size: condensed ? 8 : 10 },
                        maxRotation: condensed ? 90 : 0,
                        minRotation: condensed ? 90 : 0,
                    },
                    grid: { color: '#1e293b' },
                },
                y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: '#334155' }, beginAtZero: true },
            },
        },
    });
}

async function renderAtAGlance() {
    const statusEl = document.getElementById('atAGlanceStatus');
    const table = document.getElementById('atAGlanceTable');
    const tbody = document.getElementById('atAGlanceBody');
    if (!statusEl || !table || !tbody) return;

    const eventKey   = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    const tbaLink    = document.getElementById('dashboardTBALink');
    const statLink   = document.getElementById('dashboardStatboticsLink');
    const linksRow   = document.getElementById('dashboardEventLinks');
    if (eventKey && tbaLink && statLink && linksRow) {
        tbaLink.href  = `https://www.thebluealliance.com/event/${eventKey}`;
        statLink.href = `https://www.statbotics.io/event/${eventKey}`;
        linksRow.style.display = 'flex';
    } else if (linksRow) {
        linksRow.style.display = 'none';
    }

    const [allTeams, allTBATeams, allMatches] = await Promise.all([
        db.teams.toArray(), db.tbaTeams.toArray(), db.matches.toArray()
    ]);

    if (!allTeams.length) {
        statusEl.textContent = 'No team data — sync team list/history or Statbotics Live first.';
        table.style.display = 'none';
        if (tbody) tbody.innerHTML = '';
        return;
    }

    // ── Effective OPR (mirrors displayTBATeams) ──────────────────────────────
    const globalIgnored = new Set(allMatches.filter(m => m.globallyIgnored).map(m => m.key));
    const tbaTeamMap = Object.fromEntries(allTBATeams.map(t => [t.teamNumber, t]));

    let globalOPRMap = null;
    if (globalIgnored.size > 0) {
        const teamNums = allTBATeams.map(t => t.teamNumber);
        const activePlayed = allMatches.filter(m =>
            (m.redScore ?? -1) >= 0 && (m.blueScore ?? -1) >= 0 && !globalIgnored.has(m.key)
        );
        const recomputed = computeLocalOPR(activePlayed, teamNums);
        if (recomputed) globalOPRMap = Object.fromEntries(teamNums.map((n, i) => [n, recomputed[i]]));
    }

    const effOPR = tba => {
        if (!tba) return null;
        const keys = getTeamIgnoredKeys(tba);
        if (keys.length > 0 && tba.adjustedOPR != null && keys.some(k => !globalIgnored.has(k)))
            return tba.adjustedOPR;
        if (globalOPRMap) return globalOPRMap[tba.teamNumber] ?? tba.opr ?? null;
        return tba.opr ?? null;
    };

    // ── Ranking points from match history ────────────────────────────────────
    const rpMap = {};
    const playedMatches = allMatches.filter(m => (m.redScore ?? -1) >= 0);
    let hasBreakdown = false;

    for (const m of playedMatches) {
        const redWon = m.redScore > m.blueScore;
        const blueWon = m.blueScore > m.redScore;
        const tie = m.redScore === m.blueScore;

        // Use TBA's pre-computed rankingPoints when available; otherwise compute from
        // match result (3/1/0) + 2026 bonus RPs (Energized, Supercharged, Traversal).
        const bonusRP = bd => bd ? (
            (bd.energizedAchieved ? 1 : 0) +
            (bd.superchargedAchieved ? 1 : 0) +
            (bd.traversalAchieved ? 1 : 0)
        ) : 0;
        const redRP = m.redBreakdown?.rp ?? ((redWon ? 3 : tie ? 1 : 0) + bonusRP(m.redBreakdown));
        const blueRP = m.blueBreakdown?.rp ?? ((blueWon ? 3 : tie ? 1 : 0) + bonusRP(m.blueBreakdown));
        if (m.redBreakdown != null) hasBreakdown = true;

        for (const team of (m.red || [])) {
            if (!rpMap[team]) rpMap[team] = { rp: 0, played: 0, wins: 0, ties: 0, losses: 0, totalScore: 0 };
            rpMap[team].rp += redRP; rpMap[team].played++; rpMap[team].totalScore += m.redScore;
            if (redWon) rpMap[team].wins++; else if (tie) rpMap[team].ties++; else rpMap[team].losses++;
        }
        for (const team of (m.blue || [])) {
            if (!rpMap[team]) rpMap[team] = { rp: 0, played: 0, wins: 0, ties: 0, losses: 0, totalScore: 0 };
            rpMap[team].rp += blueRP; rpMap[team].played++; rpMap[team].totalScore += m.blueScore;
            if (blueWon) rpMap[team].wins++; else if (tie) rpMap[team].ties++; else rpMap[team].losses++;
        }
    }

    // ── Scouting EPA ─────────────────────────────────────────────────────────
    const scoutEPAMap = {};
    if (eventKey) {
        const rawStr = localStorage.getItem(`scoutingData_${eventKey}`);
        if (rawStr) {
            const fusedCache = (() => { try { return JSON.parse(localStorage.getItem(`scoutingFusedStats_${eventKey}`)); } catch { return null; } })();
            const processed = processScoutingData(eventKey, JSON.parse(rawStr), getScoutingColumnOverrides(eventKey));
            if (processed?.config?.computeEPABreakdown) {
                const { config, byTeam } = processed;
                for (const [tn, rawRows] of Object.entries(byTeam)) {
                    const tbaEntry = tbaTeamMap[parseInt(tn)];
                    const scoutIgnoreKeys = tbaEntry?.scoutingIgnoreActive ? getTeamIgnoredKeys(tbaEntry) : [];
                    let { rows: deduped } = deduplicateTeamRows(rawRows);
                    let ignoredMatchNums = new Set();
                    if (scoutIgnoreKeys.length > 0) {
                        ignoredMatchNums = new Set(allMatches.filter(m => scoutIgnoreKeys.includes(m.key)).map(m => m.matchNumber));
                        deduped = deduped.filter(r => !ignoredMatchNums.has(r.matchNumber));
                    }
                    const rawStats = config.aggregateTeam(deduped);
                    const fusedResult = fusedCache?.teams?.[tn];
                    const effectiveFused = (fusedResult?.available && ignoredMatchNums.size > 0)
                        ? refilteredFusedStats(fusedResult, ignoredMatchNums) : fusedResult;
                    const isFused = !!(effectiveFused?.available && config.computeFusedEPABreakdown);
                    const breakdown = isFused
                        ? config.computeFusedEPABreakdown(effectiveFused.stats)
                        : config.computeEPABreakdown(rawStats);
                    scoutEPAMap[tn] = { total: breakdown.total, isFused, isAdj: ignoredMatchNums.size > 0 };
                }
            }
        }
    }

    // ── Build rows ────────────────────────────────────────────────────────────
    const rows = allTeams.map(team => {
        const tn = parseInt(team.teamNumber);
        const tba = tbaTeamMap[tn];
        const rp = rpMap[String(tn)] || { rp: 0, played: 0, wins: 0, ties: 0, losses: 0 };
        const opr = effOPR(tba);
        const analysis = team.analysis || {};
        const hasCeil = analysis.ceiling != null && analysis.ceiling !== '—';
        const epaVal = hasCeil ? parseFloat(analysis.ceiling) : (team.currentEPA || 0);
        const hasLOO = getTeamIgnoredKeys(tba).some(k => !globalIgnored.has(k)) && tba?.adjustedOPR != null;
        const hasAdj = !hasLOO && globalOPRMap != null;
        const scoutData = scoutEPAMap[tn];
        return { team, tba, rp, opr, epaVal, hasCeil, hasLOO, hasAdj,
                 scoutEPA: scoutData?.total ?? null, scoutFused: scoutData?.isFused ?? false, scoutAdj: scoutData?.isAdj ?? false };
    });

    const hasOPR = allTBATeams.length > 0;
    const hasRP = playedMatches.length > 0;

    // ── Composite score + tier (must run before sort) ────────────────────────
    // Composite = average of EPA and OPR percentile ranks (0 = best, 1 = worst).
    // Tier cutoffs: top 8 → S, next 12 → A, next 12 → B, rest → C.
    {
        const pctRank = (arr, val) => {
            const sorted = [...arr].sort((a, b) => b - a);
            const idx = sorted.findIndex(v => v <= val + 0.001);
            return idx < 0 ? 1 : idx / (sorted.length || 1);
        };
        const epaVals = rows.map(r => r.epaVal);
        const oprVals = rows.map(r => r.opr ?? 0);
        const scoutEPAVals = rows.map(r => r.scoutEPA ?? 0);
        const hasAnyOPR = rows.some(r => r.opr != null);
        const hasAnyScout = rows.some(r => r.scoutEPA != null);
        const composite = r => {
            const sources = [pctRank(epaVals, r.epaVal)];
            if (hasAnyOPR)   sources.push(pctRank(oprVals, r.opr ?? 0));
            if (hasAnyScout) sources.push(pctRank(scoutEPAVals, r.scoutEPA ?? 0));
            return sources.reduce((a, b) => a + b, 0) / sources.length;
        };
        rows.forEach(r => { r.composite = composite(r); });
        const tierOrder = [...rows].sort((a, b) => a.composite - b.composite);
        const tierMap = new Map(tierOrder.map((r, i) => [
            r.team.teamNumber,
            i < 8 ? 'S' : i < 20 ? 'A' : i < 32 ? 'B' : 'C'
        ]));
        rows.forEach(r => { r.tier = tierMap.get(r.team.teamNumber); });
    }

    const avgScore = rp => rp.played ? rp.totalScore / rp.played : 0;

    // Sort — default rp desc
    rows.sort((a, b) => {
        let va, vb;
        switch (glanceSortColumn) {
            case 'epa': va = a.epaVal; vb = b.epaVal; break;
            case 'opr': va = a.opr ?? -999; vb = b.opr ?? -999; break;
            case 'scoutEPA': va = a.scoutEPA ?? -999; vb = b.scoutEPA ?? -999; break;
            case 'composite': va = -a.composite; vb = -b.composite; break;
            // Swap a/b so glanceSortOrder=1 means ascending (smallest team number first)
            case 'teamNumber': va = b.team.teamNumber; vb = a.team.teamNumber; break;
            default: va = a.rp.played > 0 ? a.rp.rp / a.rp.played : 0; vb = b.rp.played > 0 ? b.rp.rp / b.rp.played : 0; break;
        }
        return (vb - va) * glanceSortOrder || avgScore(b.rp) - avgScore(a.rp) || (b.epaVal - a.epaVal);
    });

    // Compute RP-based rank separately so it stays stable regardless of current sort
    const avgRP = rp => rp.played > 0 ? rp.rp / rp.played : 0;
    const rpRank = Object.fromEntries(
        [...rows].sort((a, b) => avgRP(b.rp) - avgRP(a.rp) || avgScore(b.rp) - avgScore(a.rp) || b.epaVal - a.epaVal)
            .map((r, i) => [r.team.teamNumber, i + 1])
    );
    const TIER = TIER_STYLE;

    table.style.display = 'table';
    tbody.innerHTML = rows.map(r => {
        const { team, rp, opr, epaVal, hasCeil, hasLOO, hasAdj, composite, scoutEPA, scoutFused, scoutAdj } = r;
        const rank = hasRP ? rpRank[team.teamNumber] : '—';
        const record = hasRP ? `${rp.wins}–${rp.losses}${rp.ties ? `–${rp.ties}` : ''}` : null;
        const rpStr = hasRP ? rp.rp : '—';
        const compStr = composite != null ? ((1 - composite) * 100).toFixed(1) : '—';
        const epaStr = epaVal.toFixed(1);
        const ceilBadge = hasCeil
            ? `<span style="color:#4ade80; font-size:0.65em; font-weight:600; margin-left:3px;">CEIL</span>` : '';
        const oprStr = opr != null ? opr.toFixed(1) : '—';
        const oprBadge = (hasLOO || hasAdj)
            ? `<span style="color:${hasLOO ? '#fbbf24' : '#f97316'}; font-size:0.65em; font-weight:600; margin-left:3px;">ADJ</span>`
            : '';
        const scoutStr = scoutEPA != null ? scoutEPA.toFixed(1) : '—';
        const fusedBadge = scoutFused
            ? `<span style="color:#818cf8; font-size:0.65em; font-weight:600; margin-left:3px;">F</span>` : '';
        const scoutAdjBadge = scoutAdj
            ? `<span style="color:#fbbf24; font-size:0.65em; font-weight:600; margin-left:3px;">ADJ</span>` : '';

        const tier = r.tier;
        const ts = TIER[tier];
        const td = (content, center = true) =>
            `<td style="padding:13px 10px; border-bottom:1px solid #1e293b;${center ? ' text-align:center;' : ''}">${content}</td>`;
        const rankCell = `<td style="padding:13px 10px; border-bottom:1px solid #1e293b; text-align:center; box-shadow:inset 3px 0 0 ${ts.color};">
            <div style="display:flex; flex-direction:column; align-items:center; gap:2px;">
                <span style="color:${ts.color}; font-size:0.75em; font-weight:800; letter-spacing:0.08em;">${tier}</span>
                <span style="color:#64748b; font-weight:700;">${rank}</span>
            </div>
        </td>`;

        const teamCell = `<td style="padding:13px 10px; border-bottom:1px solid #1e293b; white-space:nowrap;">
            <strong style="color:#f8fafc;">${team.teamNumber}</strong>${ownStar(team.teamNumber)}
        </td>
        <td style="padding:13px 10px; border-bottom:1px solid #1e293b;">
            <span style="color:#94a3b8; font-size:0.85em; font-weight:600;">${team.teamName || ''}</span>
        </td>`;

        return `<tr style="cursor:pointer; background:${ts.bg};" onclick="viewTeamDetail(${team.teamNumber})">
            ${rankCell}
            ${teamCell}
            ${td(`<span style="color:${ts.color};">${compStr}</span>`)}
            ${td(`${rpStr}${record ? `<div style="color:#94a3b8;font-size:0.75em;font-weight:600;margin-top:2px;white-space:nowrap;">${record}</div>` : ''}`)}
            ${td(`${epaStr}${ceilBadge}`)}
            ${td(hasOPR ? `${oprStr}${oprBadge}` : '—')}
            ${td(`${scoutStr}${fusedBadge}${scoutAdjBadge}`)}
        </tr>`;
    }).join('');

    renderDashboardChart(rows);

    statusEl.textContent = !hasRP
        ? 'Sync schedule to see records and ranking points.'
        : !hasBreakdown
            ? 'Ranking points show win/tie/loss only — run "Sync TBA Matches" to include bonus RPs.'
            : '';
}

// ─── TBA MATCH INFLUENCE TAB ────────────────────────────────────────────────

window.switchTBATab = function (tab) {
    currentTBATab = tab;
    document.getElementById('tba-tab-teams').style.display = tab === 'teams' ? 'block' : 'none';
    document.getElementById('tba-tab-matches').style.display = tab === 'matches' ? 'block' : 'none';
    document.querySelectorAll('#tbaTabs .detail-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['teams', 'matches'][i] === tab);
    });
    if (tab === 'matches') renderMatchInfluenceTab();
};

// Returns [{m, influence, isIgnored}] for every played match.
// influence = Σ|ΔOPR| across all teams when this match is removed (or added back if ignored).
async function computeMatchInfluences() {
    const allMatches = await db.matches.toArray();
    const globalIgnored = new Set(allMatches.filter(m => m.globallyIgnored).map(m => m.key));
    const allPlayed = allMatches.filter(m => (m.redScore ?? -1) >= 0 && (m.blueScore ?? -1) >= 0);
    const activePlayed = allPlayed.filter(m => !globalIgnored.has(m.key));

    if (!activePlayed.length) return null;

    // Use only teams from active played matches — allows OPR to be solved for early-event
    // states where far fewer than all registered teams have appeared on the field.
    const allTeamNums = [...new Set(
        activePlayed.flatMap(m => [...(m.red ?? []), ...(m.blue ?? [])]).map(Number)
    )];

    const baseOPRs = computeLocalOPR(activePlayed, allTeamNums);
    if (!baseOPRs) return null;

    return allPlayed.map(m => {
        const isIgnored = globalIgnored.has(m.key);
        // Non-ignored: LOO (remove m). Ignored: reverse (add m back to active set).
        const subset = isIgnored ? [...activePlayed, m] : activePlayed.filter(pm => pm.key !== m.key);
        const looOPRs = computeLocalOPR(subset, allTeamNums);
        const influence = looOPRs
            ? baseOPRs.reduce((sum, opr, i) => sum + Math.abs(opr - looOPRs[i]), 0)
            : null;
        return { m, influence, isIgnored };
    });
}

function renderMatchInfluenceChart(sorted) {
    const ctx = document.getElementById('matchInfluenceChart');
    if (!ctx) return;
    if (matchInfluenceChartInstance) matchInfluenceChartInstance.destroy();

    const influences = sorted.map(r => r.influence ?? 0);
    const total = influences.reduce((s, v) => s + v, 0);
    let cum = 0;
    const cdfData = influences.map(v => {
        cum += v;
        return total > 0 ? +((cum / total) * 100).toFixed(1) : 0;
    });

    matchInfluenceChartInstance = new Chart(ctx, {
        data: {
            labels: sorted.map(r => `Q${r.m.matchNumber}`),
            datasets: [
                {
                    type: 'bar',
                    label: 'Influence (Σ|ΔOPR|)',
                    data: influences,
                    backgroundColor: sorted.map(r => r.isIgnored ? '#334155' : '#3b82f6'),
                    yAxisID: 'y',
                    order: 2
                },
                {
                    type: 'line',
                    label: 'Cumulative %',
                    data: cdfData,
                    borderColor: '#f59e0b',
                    backgroundColor: 'transparent',
                    pointRadius: 0,
                    borderWidth: 2,
                    yAxisID: 'y2',
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 }, maxRotation: 45 } },
                y: {
                    beginAtZero: true,
                    grid: { color: '#334155' },
                    ticks: { color: '#94a3b8' },
                    title: { display: true, text: 'Σ|ΔOPR|', color: '#94a3b8' }
                },
                y2: {
                    position: 'right',
                    beginAtZero: true,
                    max: 100,
                    grid: { display: false },
                    ticks: { color: '#f59e0b', callback: v => v + '%' },
                    title: { display: true, text: 'Cumulative %', color: '#f59e0b' }
                }
            },
            plugins: {
                legend: { position: 'top', labels: { color: '#f8fafc', usePointStyle: true } },
                tooltip: { mode: 'index', intersect: false }
            }
        }
    });
}

window.renderMatchInfluenceTab = async function () {
    const statusEl = document.getElementById('matchInfluenceStatus');
    const tableBody = document.getElementById('matchInfluenceBody');
    const tableWrapper = document.getElementById('matchInfluenceTable');
    const chartWrapper = document.getElementById('matchInfluenceChartContainer');
    if (!statusEl || !tableBody) return;

    statusEl.innerText = 'Computing match influences…';
    tableWrapper.style.display = 'none';
    chartWrapper.style.display = 'none';

    const results = await computeMatchInfluences();
    if (!results) {
        statusEl.innerText = 'Run "Sync TBA OPR" and "Sync Schedule" first.';
        return;
    }
    statusEl.innerText = '';

    // Sort by influence descending; globally-ignored shown interleaved by their re-inclusion influence.
    const sorted = [...results].sort((a, b) => (b.influence ?? 0) - (a.influence ?? 0));

    chartWrapper.style.display = 'block';
    tableWrapper.style.display = 'table';
    renderMatchInfluenceChart(sorted);

    tableBody.innerHTML = sorted.map(r => {
        const { m, influence, isIgnored } = r;
        const played = (m.redScore ?? -1) >= 0;
        const redWon = played && m.redScore > m.blueScore;
        const blueWon = played && m.blueScore > m.redScore;
        const resultCell = played
            ? `<span style="color:${redWon ? '#4ade80' : '#94a3b8'}; font-weight:${redWon ? 'bold' : 'normal'}">${m.redScore}</span>
               <span style="color:#475569"> – </span>
               <span style="color:${blueWon ? '#4ade80' : '#94a3b8'}; font-weight:${blueWon ? 'bold' : 'normal'}">${m.blueScore}</span>`
            : '<span style="color:#475569; font-style:italic;">Upcoming</span>';

        const redTeams = (m.red || []).map(t =>
            `<span onclick="event.stopPropagation();viewTeamDetail(${t})" style="color:#ef4444;cursor:pointer;">${t}</span>`
        ).join(' ');
        const blueTeams = (m.blue || []).map(t =>
            `<span onclick="event.stopPropagation();viewTeamDetail(${t})" style="color:#3b82f6;cursor:pointer;">${t}</span>`
        ).join(' ');

        const influenceDisplay = influence != null
            ? `${influence.toFixed(2)}${isIgnored ? '<span title="Re-inclusion influence" style="color:#64748b; font-size:0.8em;">*</span>' : ''}`
            : '—';

        const matchLabel = `Q${m.matchNumber}${isIgnored
            ? ' <span style="color:#f59e0b; font-size:0.7em; font-weight:600;">IGNORED</span>' : ''}`;

        const actionBtn = `<button onclick="event.stopPropagation();setGloballyIgnored('${m.key}',${!isIgnored})"
            style="padding:4px 14px; font-size:0.85em; background:${isIgnored ? '#92400e' : '#1e293b'}; border:1px solid ${isIgnored ? '#d97706' : '#475569'}; color:${isIgnored ? '#fde68a' : '#94a3b8'}; border-radius:4px; cursor:pointer;">
            ${isIgnored ? 'Restore' : 'Ignore'}
        </button>`;

        return `<tr onclick="viewMatchDetail('${m.key}')" style="cursor:pointer; opacity:${isIgnored ? '0.55' : '1'};">
            <td style="padding:12px 8px; font-weight:bold; color:#f8fafc;">${matchLabel}</td>
            <td style="padding:12px 8px;">${redTeams}</td>
            <td style="padding:12px 8px;">${blueTeams}</td>
            <td style="padding:12px 8px; white-space:nowrap;">${resultCell}</td>
            <td style="padding:12px 8px; font-weight:bold; color:#f8fafc;">${influenceDisplay}</td>
            <td style="padding:12px 8px;" onclick="event.stopPropagation();">${actionBtn}</td>
        </tr>`;
    }).join('');
};

window.setGloballyIgnored = async function (matchKey, ignored) {
    await db.matches.update(matchKey, { globallyIgnored: ignored || null });

    // When globally ignoring a match, remove it from any team's individual ignore list.
    if (ignored) {
        const affected = await db.tbaTeams.filter(t =>
            (Array.isArray(t.ignoredMatchKeys) && t.ignoredMatchKeys.includes(matchKey)) ||
            t.ignoredMatchKey === matchKey
        ).toArray();
        if (affected.length > 0) {
            await Promise.all(affected.map(t => {
                const keys = getTeamIgnoredKeys(t).filter(k => k !== matchKey);
                return db.tbaTeams.update(t.teamNumber, {
                    ignoredMatchKeys: keys.length > 0 ? keys : null,
                    ignoredMatchKey:  null,
                    adjustedOPR:      null,
                });
            }));
        }
    }

    await displayTBATeams();
    if (currentTBATab === 'matches') await renderMatchInfluenceTab();
    if (activeTBAData) {
        activeTBAData = await db.tbaTeams.get(activeTBAData.teamNumber);
        await renderTBADetail(activeTBAData.teamNumber, activeTBAData);
        if (activeTeamData) await renderOverview(activeTeamData, activeTBAData);
    }
};

window.viewTeamDetail = async function (teamNumber, tab = lastDetailTab) {
    activeTeamNumber = teamNumber; // <--- ADD THIS LINE
    const team = await db.teams.get(teamNumber);
    if (!team) return;

    const view = document.getElementById('teamDetailView');
    const label = document.getElementById('detailTeamLabel');
    const stats = document.getElementById('detailStats');

    if (!view || !label || !stats) {
        console.error("Missing Detail View elements in HTML.");
        return;
    }

    label.innerText = `Team ${teamNumber}: ${team.teamName || ''}`;

    // Quip: log-scale EPA fraction determines tier + unique within-tier rank
    {
        const quipContainer = document.getElementById('detailTeamQuip');
        const quipTextEl = document.getElementById('detailTeamQuipText');
        const quipsEnabled = localStorage.getItem('quipsEnabled') === 'true';
        if (quipContainer) quipContainer.style.display = quipsEnabled ? '' : 'none';
        if (quipTextEl && quipsEnabled) {
            const allTeams = await db.teams.where('eventKey').equals(team.eventKey).toArray();
            let quipTier = 'B';
            let rankInTier = null;
            if (allTeams.length > 0) {
                // Fused EPA: prefer scouting-fused, fall back to Statbotics currentEPA
                const fusedCache = (() => { try { return JSON.parse(localStorage.getItem(`scoutingFusedStats_${team.eventKey}`)); } catch { return null; } })();
                const gameConfig = getGameConfig(team.eventKey);
                const getEPA = t => {
                    const fr = fusedCache?.teams?.[String(t.teamNumber)];
                    if (fr?.available && gameConfig?.computeFusedEPABreakdown) {
                        return gameConfig.computeFusedEPABreakdown(fr.stats).total;
                    }
                    return t.currentEPA ?? 0;
                };

                const epas = allTeams.map(getEPA);
                const logMin = Math.log(Math.max(Math.min(...epas), 0.1));
                const logMax = Math.log(Math.max(Math.max(...epas), 0.1));
                const getLogFraction = t => logMax > logMin
                    ? Math.max(0, Math.min(1, (Math.log(Math.max(getEPA(t), 0.1)) - logMin) / (logMax - logMin)))
                    : 0.5;

                quipTier = logFractionToTier(getLogFraction(team));

                // Rank within tier by log-fraction descending → unique quip slot per team
                const tierPeers = allTeams
                    .filter(t => logFractionToTier(getLogFraction(t)) === quipTier)
                    .sort((a, b) => getLogFraction(b) - getLogFraction(a));
                rankInTier = Math.max(tierPeers.findIndex(t => t.teamNumber === Number(teamNumber)), 0);
            }
            const randomMode = localStorage.getItem('quipRandomMode') === 'true';
            quipTextEl.textContent = Number(teamNumber) === 1768
                ? 'Mechanis Lupus.'
                : getTeamQuip(Number(teamNumber), quipTier, randomMode, rankInTier, getQuipUserSeed());
            if (quipContainer) {
                quipContainer.dataset.tier = quipTier;
                quipContainer.dataset.team = teamNumber;
            }
        }
    }

    // --- FIX: The Safe Check ---
    // If analysis is null, provide default "blank" values
    const analysis = team.analysis || { ceiling: "—", lowerBound: "—", upperBound: "—" };

    stats.innerHTML = `
        <div style="background:#333; padding:15px; border-radius:8px;">
            <label style="color:#888; font-size:0.8em;">CURRENT EPA</label>
            <div style="font-size:1.5em; font-weight:bold;">${team.currentEPA ? team.currentEPA.toFixed(1) : '0'}</div>
        </div>
        <div style="background:#333; padding:15px; border-radius:8px;">
            <label style="color:#888; font-size:0.8em;">PROJECTED CEILING</label>
            <div style="font-size:1.5em; font-weight:bold; color:#4ade80;">${analysis.ceiling}</div>
        </div>
        <div style="background:#333; padding:15px; border-radius:8px;">
            <label style="color:#888; font-size:0.8em;">90% CONFIDENCE</label>
            <div>${analysis.lowerBound} - ${analysis.upperBound}</div>
        </div>
    `;

    activeTeamData = team;
    activeTBAData = await db.tbaTeams.get(teamNumber) || await db.tbaTeams.get(parseInt(teamNumber));
    if (tab === 'epa-opr') { lastDetailDataSubTab = 'epa'; tab = 'data'; }
    switchDetailTab(tab);

    window.switchView('teamDetailView');
    pushNavState('teamDetail');
    fitDetailLabel();
};

function fitDetailLabel() {
    const el = document.getElementById('detailTeamLabel');
    if (!el) return;
    el.style.fontSize = '';
    const cs = getComputedStyle(el);
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
    const maxH = lineH * 2 + 4; // 2 lines + small rounding buffer
    let size = parseFloat(cs.fontSize);
    const minSize = 13;
    while (el.scrollHeight > maxH && size > minSize) {
        size -= 1;
        el.style.fontSize = size + 'px';
    }
}

window.closeDetail = function () {
    document.getElementById('teamDetailView').style.display = 'none';
};


// At the top of main.js
window.currentView = 'scheduleView';
window.previousView = 'scheduleView';
window.scheduleFilterActive = false;

function applyScheduleFilter() {
    const active = window.scheduleFilterActive && window.currentFocusedTeam;
    const team = window.currentFocusedTeam;
    const isMobile = document.body.classList.contains('mobile-ui');

    // Remove any existing gap rows before re-evaluating
    document.querySelectorAll('#scheduleBody tr.schedule-gap').forEach(r => r.remove());

    document.querySelectorAll('#scheduleBody tr[data-teams]').forEach(row => {
        const teams = (row.dataset.teams || '').split(',');
        const show = !active || teams.includes(team);
        row.style.display = show ? '' : 'none';
        if (isMobile) {
            const next = row.nextElementSibling;
            if (next && !next.dataset.teams) next.style.display = show ? '' : 'none';
        }
    });

    if (!active) return;

    // Insert gap indicator rows between visible match groups
    const allMainRows = [...document.querySelectorAll('#scheduleBody tr[data-teams]')];
    const visibleRows = allMainRows.filter(r => r.style.display !== 'none');
    const cols = isMobile ? 5 : 8;

    visibleRows.forEach((row, i) => {
        if (i === 0) return;
        const prevVisible = visibleRows[i - 1];

        // Walk from after the previous visible match to count hidden matches in between
        // On mobile each visible match has a trailing blue row, so skip it first
        let cursor = isMobile
            ? prevVisible.nextElementSibling?.nextElementSibling
            : prevVisible.nextElementSibling;

        let hiddenCount = 0;
        while (cursor && cursor !== row) {
            if (cursor.dataset.teams) hiddenCount++;
            cursor = cursor.nextElementSibling;
        }

        if (hiddenCount > 0) {
            const gapRow = document.createElement('tr');
            gapRow.className = 'schedule-gap';
            gapRow.innerHTML = `<td colspan="${cols}">· · · ${hiddenCount} match${hiddenCount !== 1 ? 'es' : ''} not shown · · ·</td>`;
            row.parentNode.insertBefore(gapRow, row);
        }
    });
}

window.toggleScheduleFilter = function () {
    window.scheduleFilterActive = !window.scheduleFilterActive;
    document.getElementById('scheduleFilterBtn')?.classList.toggle('active', window.scheduleFilterActive);
    applyScheduleFilter();
};

// ── SCHEDULE SUB-TABS ────────────────────────────────────────────────────────

let watchListDirty = true;
let watchListCutoff = null;   // null = live mode; integer = treat matches > N as unplayed
let wlYourCollapsed = false;
let wlOtherCollapsed = false;
let wlStandingsCollapsed = false;
let wlDetailCache = null;
let wlPreEventCache = null;
let wlComputedAsOf = null; // label shown in banner, e.g. "Q12" or null for pre-event
// Linear calibration factor: p_cal = 0.5 + wlCalibrationBeta*(p - 0.5).
// 1.0 = no correction; <1.0 = shrink toward 50% (fixes overconfidence).
// Set by runBacktest → applyWLCalibration(), resets to 1.0 on page load.
let wlCalibrationBeta = 0.982;

window.switchScheduleTab = function (tab) {
    ['matches', 'watchlist', 'streams'].forEach(t => {
        document.getElementById(`schedule-sub-${t}`).style.display = t === tab ? '' : 'none';
    });
    document.querySelectorAll('#scheduleTabs .detail-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['matches', 'watchlist', 'streams'][i] === tab);
    });
    if (tab === 'watchlist' && watchListDirty) showWatchListStale();
    if (tab === 'streams') renderStreamsTab();
};

function renderStreamsTab() {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    const container = document.getElementById('schedule-sub-streams');
    if (!container) return;

    let webcasts = [];
    try { webcasts = JSON.parse(localStorage.getItem(`webcasts_${eventKey}`) || '[]'); } catch {}

    if (!eventKey || webcasts.length === 0) {
        container.innerHTML = `<p style="color:#64748b;font-style:italic;text-align:center;margin-top:32px;">No streams found. Sync Schedule to check for webcasts.</p>`;
        return;
    }

    container.innerHTML = webcasts.map((w, i) => {
        const thumbId = `stream-thumb-${i}`;
        const dateLabel = w.date ? `<div style="color:#94a3b8;font-size:0.8em;margin-bottom:6px;">${w.date}</div>` : '';
        return `<div style="margin-bottom:24px;">
            ${dateLabel}
            <div id="${thumbId}" onclick="loadYTEmbed('${w.channel}','${thumbId}')"
                style="position:relative;cursor:pointer;border-radius:8px;overflow:hidden;background:#000;max-width:640px;">
                <img src="https://img.youtube.com/vi/${w.channel}/hqdefault.jpg"
                    style="width:100%;display:block;opacity:0.85;"
                    onerror="this.style.display='none'" loading="lazy">
                <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
                    <div style="width:64px;height:44px;background:rgba(255,0,0,0.85);border-radius:10px;display:flex;align-items:center;justify-content:center;">
                        <div style="border-style:solid;border-width:10px 0 10px 20px;border-color:transparent transparent transparent #fff;margin-left:4px;"></div>
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');
}

// ── WATCH LIST ENGINE ────────────────────────────────────────────────────────

// Merge saved per-event threshold overrides onto game config defaults.
function getEffectiveThresholds(gameConfig, eventKey) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(`rpThresholds_${eventKey}`) || '{}'); } catch {}
    return (gameConfig?.rpThresholds ?? []).map(rpt => ({
        ...rpt,
        threshold: saved[rpt.rpField] != null ? Number(saved[rpt.rpField]) : rpt.threshold,
    }));
}

// Average OPR across all known teams; used when a team has no OPR.
function wlEventAvgOPR(tbaMap) {
    const vals = Object.values(tbaMap).map(t => t.opr).filter(v => v != null && v > 0);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 30;
}

// Best available single-number contribution estimate for one team.
// oprWeight (0–1) blends EPA→OPR as more matches are played; both are used when available.
// Adjusted OPR (for teams with individually ignored matches) always takes priority.
function wlPredictedContribution(tn, tbaMap, teamsMap, avg, oprWeight = 1) {
    const tba    = tbaMap[parseInt(tn)];
    const stat   = teamsMap[parseInt(tn)];
    const hasAdj = tba && getTeamIgnoredKeys(tba).length > 0 && tba.adjustedOPR != null;
    if (hasAdj) return tba.adjustedOPR;
    const opr = tba?.opr   ?? null;
    const epa = stat?.currentEPA ?? null;
    if (opr != null && epa != null) return oprWeight * opr + (1 - oprWeight) * epa;
    return opr ?? epa ?? avg;
}

function wlAlliancePredictedScore(teams, tbaMap, teamsMap, avg, oprWeight = 1) {
    return (teams ?? []).reduce((s, tn) => s + (wlPredictedContribution(tn, tbaMap, teamsMap, avg, oprWeight) ?? avg), 0);
}

// Box-Muller standard normal sample.
function wlGaussian() {
    return Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

// Gaussian prior σ as a fraction of predicted score, derived from per-team EPA standard deviations.
// Assumes team scoring contributions are independent: σ_alliance = √(σ₁² + σ₂² + σ₃²).
function wlAllianceSigmaRel(teams, teamsMap, predicted) {
    let sumSq = 0, found = 0;
    for (const tn of (teams ?? [])) {
        const sd = teamsMap[parseInt(tn)]?.epa?.total_points?.sd;
        if (sd != null) { sumSq += sd * sd; found++; }
    }
    if (!found || predicted <= 0) return 0.18;  // flat 18% CV if no EPA SDs available
    return Math.sqrt(sumSq) / predicted;
}

// Blended residual pool: empirical relative residuals + N_PRIOR synthetic Gaussian draws.
// Prior weight = 10 / (empirical_count + 10), shrinking as real data accumulates.
function wlBuildRelPool(relResiduals, teams, teamsMap, predicted) {
    const N_PRIOR  = 500;
    const sigmaRel = wlAllianceSigmaRel(teams, teamsMap, predicted);
    const prior    = Array.from({ length: N_PRIOR }, () => sigmaRel * wlGaussian());
    return [...relResiduals, ...prior];
}

// Differential pool: empirical margin residuals + Gaussian prior for the predicted margin.
// σ_diff = √(σ_red_abs² + σ_blue_abs²) where σ_x_abs = σ_x_rel × predicted_x.
// Sampling from this pool for win probability captures shared match-level noise (both alliances
// affected by field conditions, refs, etc.), preventing probabilities from reaching 100%/0%.
function wlBuildDiffPool(diffResiduals, redTeams, blueTeams, teamsMap, redPred, bluePred) {
    const N_PRIOR   = 500;
    const sigmaRed  = wlAllianceSigmaRel(redTeams,  teamsMap, redPred)  * redPred;
    const sigmaBlue = wlAllianceSigmaRel(blueTeams, teamsMap, bluePred) * bluePred;
    const sigmaDiff = Math.sqrt(sigmaRed * sigmaRed + sigmaBlue * sigmaBlue);
    const prior = Array.from({ length: N_PRIOR }, () => sigmaDiff * wlGaussian());
    return [...diffResiduals, ...prior];
}

// Relative residuals: (actualScore − predicted) / predicted, one per alliance per played match.
// Differential residuals: (actualRed − actualBlue) − (predRed − predBlue), in absolute points.
// oprWeight at match i uses the count of matches played *before* match i, so residuals are
// computed with the same blend the model would have used when predicting that match.
function wlCollectResiduals(playedMatches, tbaMap, teamsMap) {
    const avg = wlEventAvgOPR(tbaMap);
    const relRes  = [];
    const diffRes = [];
    for (let i = 0; i < playedMatches.length; i++) {
        const m = playedMatches[i];
        if ((m.redScore ?? -1) < 0) continue;
        const oprWeight = Math.min(1, i / 30);   // weight at time of this match
        const rp = wlAlliancePredictedScore(m.red,  tbaMap, teamsMap, avg, oprWeight);
        const bp = wlAlliancePredictedScore(m.blue, tbaMap, teamsMap, avg, oprWeight);
        if (rp > 0) relRes.push((m.redScore  - rp) / rp);
        if (bp > 0) relRes.push((m.blueScore - bp) / bp);
        // Absolute differential residual — captures match-level shared noise.
        diffRes.push((m.redScore - m.blueScore) - (rp - bp));
    }
    return { relResiduals: relRes, diffResiduals: diffRes };
}

// Solve a fuel-specific OPR using computeLocalOPR on component scores instead of total scores.
// Falls back to a reduced team set (only teams seen in fuel matches) when the full matrix is
// underdetermined — e.g. early in an event or when using the debug cutoff control.
function wlComputeFuelOPR(playedMatches, allTeamNums, scoreComponent, gameConfig) {
    if (!gameConfig?.componentScores) return null;
    const fuelMs = playedMatches.map(m => {
        const rf = gameConfig.componentScores(m.redBreakdown)?.[scoreComponent];
        const bf = gameConfig.componentScores(m.blueBreakdown)?.[scoreComponent];
        return (rf != null && bf != null) ? { ...m, redScore: rf, blueScore: bf } : null;
    }).filter(Boolean);
    if (fuelMs.length < 2) return null;

    let result = computeLocalOPR(fuelMs, allTeamNums);
    if (result) return result;

    // Underdetermined (fewer matches than teams) — retry with only teams seen in fuel matches,
    // then re-expand back to allTeamNums-indexed array so callers stay unchanged.
    const seenNums = [...new Set(
        fuelMs.flatMap(m => [...(m.red ?? []), ...(m.blue ?? [])]).map(t => parseInt(t)).filter(n => !isNaN(n))
    )];
    const reduced = computeLocalOPR(fuelMs, seenNums);
    if (!reduced) return null;
    const full = new Array(allTeamNums.length).fill(0);
    seenNums.forEach((tn, i) => {
        const idx = allTeamNums.indexOf(tn);
        if (idx !== -1) full[idx] = reduced[i];
    });
    return full;
}

// Historical RP achievement rate for an alliance.  Returns max over 3 teams (optimistic).
function wlHistoricalRPRate(teamNumbers, rpField, playedMatches) {
    const rates = (teamNumbers ?? []).map(tn => {
        const played = playedMatches.filter(m =>
            (m.redScore ?? -1) >= 0 &&
            (m.red?.includes(String(tn)) || m.blue?.includes(String(tn)))
        );
        if (!played.length) return null;
        const hit = played.filter(m => {
            const bd = m.red?.includes(String(tn)) ? m.redBreakdown : m.blueBreakdown;
            return bd?.[rpField];
        });
        return hit.length / played.length;
    }).filter(r => r != null);
    return rates.length ? Math.max(...rates) : 0.5;
}

function wlSample(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// Monte Carlo prediction for one unplayed match.
// Returns { redProb, tieProb, blueProb, redPredicted, bluePredicted, rpProbs: {red, blue} }
// Win probability uses differential residuals so shared match-level noise is captured; RP
// probability uses per-alliance relative residuals since RP thresholds are per-alliance.
function wlSimulateMatch(match, tbaMap, teamsMap, allTeamNums, relResiduals, diffResiduals, gameConfig, effectiveThresholds, playedMatches, fuelOPRCache, N = 500) {
    const avg       = wlEventAvgOPR(tbaMap);
    const oprWeight = Math.min(1, playedMatches.length / 30);
    const redPred   = wlAlliancePredictedScore(match.red,  tbaMap, teamsMap, avg, oprWeight);
    const bluePred  = wlAlliancePredictedScore(match.blue, tbaMap, teamsMap, avg, oprWeight);

    // Differential pool for win probability — models the score margin, not each alliance in isolation.
    const diffPool = wlBuildDiffPool(diffResiduals, match.red, match.blue, teamsMap, redPred, bluePred);
    // Per-alliance pools for RP threshold probability (still need per-alliance score estimates).
    const redPool  = wlBuildRelPool(relResiduals, match.red,  teamsMap, redPred);
    const bluePool = wlBuildRelPool(relResiduals, match.blue, teamsMap, bluePred);

    let redWins = 0, ties = 0;
    const rpRed = {}, rpBlue = {};
    for (const rpt of effectiveThresholds) { rpRed[rpt.rpField] = 0; rpBlue[rpt.rpField] = 0; }

    // Pre-compute predicted fuel per alliance (constant across simulations).
    const fuelPred = {};
    for (const rpt of effectiveThresholds) {
        if (rpt.threshold == null) continue;
        const fuelArr = fuelOPRCache[rpt.scoreComponent];
        // fuelArr is valid only if the OPR solve produced at least one positive value.
        // An all-zeros result (truthy array) occurs when breakdown data is missing/zero —
        // fall through to the EPA fallback in that case.
        const fuelOPRValid = Array.isArray(fuelArr) && fuelArr.some(v => v > 0.5);
        if (fuelOPRValid) {
            // Clip individual team OPR contributions to ≥ 0 — negative OPR is an artifact
            // of the least-squares solve and would wrongly suppress the alliance sum.
            fuelPred[rpt.rpField] = {
                r: (match.red  ?? []).reduce((s, tn) => { const idx = allTeamNums.indexOf(parseInt(tn)); return s + Math.max(0, fuelArr[idx] ?? 0); }, 0),
                b: (match.blue ?? []).reduce((s, tn) => { const idx = allTeamNums.indexOf(parseInt(tn)); return s + Math.max(0, fuelArr[idx] ?? 0); }, 0),
            };
        } else if (rpt.fuelEPAKey) {
            // OPR unavailable or degenerate — sum each team's Statbotics EPA fuel component.
            const epaSum = (tns) => (tns ?? []).reduce((s, tn) =>
                s + Math.max(0, teamsMap[parseInt(tn)]?.epa?.breakdown?.[rpt.fuelEPAKey] ?? 0), 0);
            fuelPred[rpt.rpField] = { r: epaSum(match.red), b: epaSum(match.blue) };
        } else {
            fuelPred[rpt.rpField] = { r: redPred * 0.4, b: bluePred * 0.4 };
        }
    }

    const diffPred = redPred - bluePred;
    for (let i = 0; i < N; i++) {
        const diffSim = diffPred + wlSample(diffPool);
        if (diffSim > 0)                   redWins++;
        else if (Math.abs(diffSim) < 1)    ties++;

        for (const rpt of effectiveThresholds) {
            if (rpt.threshold == null) continue;
            const { r: rf, b: bf } = fuelPred[rpt.rpField];
            const rsim = Math.max(0, rf * (1 + wlSample(redPool)));
            const bsim = Math.max(0, bf * (1 + wlSample(bluePool)));
            if (rsim >= rpt.threshold) rpRed[rpt.rpField]++;
            if (bsim >= rpt.threshold) rpBlue[rpt.rpField]++;
        }
    }

    // Binary RPs use historical rate, not per-trial sampling
    for (const rpt of effectiveThresholds) {
        if (rpt.threshold != null) continue;
        rpRed[rpt.rpField]  = Math.round(wlHistoricalRPRate(match.red,  rpt.rpField, playedMatches) * N);
        rpBlue[rpt.rpField] = Math.round(wlHistoricalRPRate(match.blue, rpt.rpField, playedMatches) * N);
    }

    // Apply linear calibration: p_cal = 0.5 + β(p − 0.5), then renormalize with tieProb intact.
    const β = wlCalibrationBeta;
    const rawRed  = redWins / N;
    const rawBlue = (N - redWins - ties) / N;
    const rawTie  = ties / N;
    const calRed  = Math.max(0, 0.5 + β * (rawRed  - 0.5));
    const calBlue = Math.max(0, 0.5 + β * (rawBlue - 0.5));
    const calSum  = calRed + calBlue + rawTie;

    return {
        redProb: calRed / calSum, tieProb: rawTie / calSum, blueProb: calBlue / calSum,
        redPredicted: redPred, bluePredicted: bluePred,
        rpProbs: {
            red:  Object.fromEntries(effectiveThresholds.map(r => [r.rpField, rpRed[r.rpField]  / N])),
            blue: Object.fromEntries(effectiveThresholds.map(r => [r.rpField, rpBlue[r.rpField] / N])),
        },
    };
}

// Sum actual RPs earned from played matches.
function wlComputeActualRP(playedMatches) {
    const rpMap = {};
    for (const m of playedMatches) {
        if ((m.redScore ?? -1) < 0) continue;
        const rRP = m.redBreakdown?.rp  ?? (m.redScore  > m.blueScore  ? 3 : m.redScore  === m.blueScore  ? 1 : 0);
        const bRP = m.blueBreakdown?.rp ?? (m.blueScore > m.redScore   ? 3 : m.blueScore === m.redScore   ? 1 : 0);
        for (const tn of (m.red  ?? [])) rpMap[String(tn)] = (rpMap[String(tn)] ?? 0) + rRP;
        for (const tn of (m.blue ?? [])) rpMap[String(tn)] = (rpMap[String(tn)] ?? 0) + bRP;
    }
    return rpMap;
}

// Simulate all remaining matches N times. Returns { [teamNumber]: { mean, p10, p90, meanRP } }.
// meanRP is computed analytically (sum of expected values) rather than by sampling, so it is
// stable across recomputes. Rank distribution (mean/p10/p90) still uses Monte Carlo.
function wlSimulateStandings(baseRP, unplayed, matchPredictions, effectiveThresholds, N = 1000) {
    // Analytical expected RP: deterministic, no sampling variance.
    const analyticalRP = { ...baseRP };
    for (const m of unplayed) {
        const pred = matchPredictions[m.key];
        if (!pred) continue;
        const blueProb   = Math.max(0, 1 - pred.redProb - pred.tieProb);
        const rExpWin    = 3 * pred.redProb + pred.tieProb;
        const bExpWin    = 3 * blueProb     + pred.tieProb;
        const rExpBonus  = effectiveThresholds.reduce((s, rpt) => s + (pred.rpProbs.red[rpt.rpField]  ?? 0), 0);
        const bExpBonus  = effectiveThresholds.reduce((s, rpt) => s + (pred.rpProbs.blue[rpt.rpField] ?? 0), 0);
        for (const tn of (m.red  ?? [])) analyticalRP[String(tn)] = (analyticalRP[String(tn)] ?? 0) + rExpWin + rExpBonus;
        for (const tn of (m.blue ?? [])) analyticalRP[String(tn)] = (analyticalRP[String(tn)] ?? 0) + bExpWin + bExpBonus;
    }

    // Monte Carlo for rank distribution only.
    const rankSamples = {};
    for (let i = 0; i < N; i++) {
        const simRP = { ...baseRP };
        for (const m of unplayed) {
            const pred = matchPredictions[m.key];
            if (!pred) continue;
            const r = Math.random();
            let rRP, bRP;
            if      (r < pred.redProb)                     { rRP = 3; bRP = 0; }
            else if (r < pred.redProb + pred.tieProb)      { rRP = 1; bRP = 1; }
            else                                            { rRP = 0; bRP = 3; }
            for (const rpt of effectiveThresholds) {
                if (Math.random() < (pred.rpProbs.red[rpt.rpField]  ?? 0)) rRP++;
                if (Math.random() < (pred.rpProbs.blue[rpt.rpField] ?? 0)) bRP++;
            }
            for (const tn of (m.red  ?? [])) simRP[String(tn)] = (simRP[String(tn)] ?? 0) + rRP;
            for (const tn of (m.blue ?? [])) simRP[String(tn)] = (simRP[String(tn)] ?? 0) + bRP;
        }
        Object.entries(simRP).sort((a, b) => b[1] - a[1]).forEach(([tn], idx) => {
            (rankSamples[tn] = rankSamples[tn] ?? []).push(idx + 1);
        });
    }
    return Object.fromEntries(Object.keys(analyticalRP).map(tn => {
        const rs = (rankSamples[tn] ?? []).sort((a, b) => a - b);
        return [tn, {
            mean:   rs.length ? +(rs.reduce((s, r) => s + r, 0) / rs.length).toFixed(1) : null,
            p10:    rs[Math.floor(rs.length * 0.10)] ?? null,
            p90:    rs[Math.floor(rs.length * 0.90)] ?? null,
            meanRP: +analyticalRP[tn].toFixed(1),
        }];
    }));
}

// Estimate how much a single match outcome shifts the focused team's projected rank.
// Runs two fixed-outcome simulations (red wins / blue wins) and returns the larger delta.
function wlComputeImpact(focusedTN, baselineMean, matchKey, unplayed, matchPredictions, baseRP, effectiveThresholds, N = 500) {
    const runFixed = (forceRed) => {
        const sums = [];
        for (let i = 0; i < N; i++) {
            const simRP = { ...baseRP };
            for (const m of unplayed) {
                const pred = matchPredictions[m.key];
                if (!pred) continue;
                let rRP, bRP;
                if (m.key === matchKey) {
                    if (forceRed > 0)       { rRP = 3; bRP = 0; }
                    else if (forceRed === 0){ rRP = 1; bRP = 1; }
                    else                    { rRP = 0; bRP = 3; }
                } else {
                    const r = Math.random();
                    if      (r < pred.redProb)                    { rRP = 3; bRP = 0; }
                    else if (r < pred.redProb + pred.tieProb)     { rRP = 1; bRP = 1; }
                    else                                           { rRP = 0; bRP = 3; }
                }
                for (const rpt of effectiveThresholds) {
                    if (Math.random() < (pred.rpProbs.red[rpt.rpField]  ?? 0)) rRP++;
                    if (Math.random() < (pred.rpProbs.blue[rpt.rpField] ?? 0)) bRP++;
                }
                for (const tn of (m.red  ?? [])) simRP[String(tn)] = (simRP[String(tn)] ?? 0) + rRP;
                for (const tn of (m.blue ?? [])) simRP[String(tn)] = (simRP[String(tn)] ?? 0) + bRP;
            }
            const ranked = Object.entries(simRP).sort((a, b) => b[1] - a[1]);
            const idx = ranked.findIndex(([tn]) => tn === String(focusedTN));
            sums.push(idx >= 0 ? idx + 1 : ranked.length + 1);
        }
        return sums.reduce((s, r) => s + r, 0) / sums.length;
    };
    const redMean  = runFixed(1);
    const blueMean = runFixed(-1);
    return {
        impact: Math.max(Math.abs(baselineMean - redMean), Math.abs(baselineMean - blueMean)),
        rankIfRedWins:  redMean,
        rankIfBlueWins: blueMean,
    };
}

// ── PRE-EVENT BASELINE SNAPSHOT ──────────────────────────────────────────────

function computePreEventSnapshot(eventKey, allMatches, teamsMap, tbaMap, allTeamNums, gameConfig, effectiveThresholds) {
    const matchPredictions = {};
    for (const m of allMatches) {
        matchPredictions[m.key] = wlSimulateMatch(
            m, tbaMap, teamsMap, allTeamNums,
            [], [],       // empty residuals → Gaussian prior only
            gameConfig, effectiveThresholds,
            [],           // no played matches
            {}            // empty fuel OPR → EPA fallback via fuelEPAKey
        );
    }
    const rankDistrib = wlSimulateStandings({}, allMatches, matchPredictions, effectiveThresholds);
    const snapshot = { computed: new Date().toISOString(), rankDistrib, matchPredictions };
    localStorage.setItem(`wlPreEventSnapshot_${eventKey}`, JSON.stringify(snapshot));
    return snapshot;
}

window.resetPreEventSnapshot = function(eventKey) {
    if (!wlDetailCache) return;
    const { allMatches, teamsMap, tbaMap, allTeamNums, gameConfig, effectiveThresholds } = wlDetailCache;
    localStorage.removeItem(`wlPreEventSnapshot_${eventKey}`);
    wlPreEventCache = computePreEventSnapshot(eventKey, allMatches, teamsMap, tbaMap, allTeamNums, gameConfig, effectiveThresholds);
    wlMatchesRenderedFor = null;
    renderWatchList();
};

// ── WATCH LIST CONTROLS (also rendered in Dev tab) ───────────────────────────

function buildWLControlsHTML(eventKey, effectiveThresholds, totalMatchCount, tbaMap) {
    const cutoffN = watchListCutoff;

    const thresholdCtrls = effectiveThresholds.filter(r => r.threshold != null).map(rpt => `
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="color:#94a3b8;font-size:0.85em;white-space:nowrap;">${rpt.label} threshold</span>
            <input type="number" min="0" step="1" value="${rpt.threshold}"
                style="width:64px;padding:3px 6px;background:#0f172a;border:1px solid #334155;color:#f8fafc;border-radius:4px;font-size:0.9em;"
                onchange="saveWatchRPThreshold('${rpt.rpField}',this.value,'${eventKey}')">
            <span style="color:#64748b;font-size:0.85em;">fuel</span>
        </div>`).join('');

    const resetBtn = effectiveThresholds.some(r => r.threshold != null)
        ? `<button onclick="resetWatchRPThresholds('${eventKey}')" style="background:transparent;color:#64748b;border:1px solid #334155;border-radius:4px;padding:3px 10px;font-size:0.82em;cursor:pointer;">Reset thresholds</button>`
        : '';

    const cutoffCtrl = `
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="color:#94a3b8;font-size:0.85em;white-space:nowrap;">Simulate from after Q</span>
            <input type="number" min="1" max="${totalMatchCount}" value="${cutoffN ?? ''}" placeholder="all"
                style="width:56px;padding:3px 6px;background:#0f172a;border:1px solid #334155;color:#f8fafc;border-radius:4px;font-size:0.9em;"
                onchange="setWatchListCutoff(this.value||null)">
            <span style="color:#64748b;font-size:0.85em;">/ ${totalMatchCount}</span>
            ${cutoffN != null ? `<button onclick="setWatchListCutoff(null)" style="background:transparent;color:#64748b;border:1px solid #334155;border-radius:4px;padding:3px 8px;font-size:0.82em;cursor:pointer;">Live</button>` : ''}
        </div>`;

    const snapDate = wlPreEventCache
        ? new Date(wlPreEventCache.computed).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '—';
    const hasOPR = Object.values(tbaMap).some(t => t.opr != null);
    const baselineTip = 'Pre-event baseline: frozen snapshot using EPA only (no OPR, no residuals). Differences from live sim are expected if data was re-synced or OPR has since become available. Click Reset to recompute.';
    const oprNote = hasOPR ? ' <span style="color:#475569;font-size:0.82em;" title="OPR is now available — baseline was computed without it">+OPR available</span>' : '';
    const baselineCtrl = `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;" title="${baselineTip}">
            <span style="color:#94a3b8;font-size:0.85em;white-space:nowrap;">Baseline snapshot: ${snapDate}${oprNote}</span>
            <button onclick="resetPreEventSnapshot('${eventKey}')"
                style="background:transparent;color:#64748b;border:1px solid #334155;border-radius:4px;padding:3px 8px;font-size:0.82em;cursor:pointer;">Recompute</button>
        </div>`;

    return `<div style="display:flex;flex-direction:column;gap:10px;padding:10px 0;">
        ${thresholdCtrls}
        ${resetBtn}
        ${cutoffCtrl}
        ${baselineCtrl}
    </div>`;
}

// ── WATCH LIST RENDERER ──────────────────────────────────────────────────────

function showWatchListStale() {
    const updateBtn = document.getElementById('wl-update-btn');
    if (updateBtn) {
        // Watch list already rendered — just surface the Update button in the banner.
        updateBtn.style.display = '';
        return;
    }
    // No rendered content yet — show a compute placeholder.
    const container = document.getElementById('schedule-sub-watchlist');
    if (!container) return;
    container.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 20px;gap:14px;">
            <button onclick="renderWatchList()"
                style="background:#1d4ed8;color:#f8fafc;border:none;border-radius:8px;padding:10px 28px;font-size:1em;font-weight:600;cursor:pointer;letter-spacing:0.02em;">
                Compute Watch List
            </button>
        </div>`;
}

window.renderWatchList = async function renderWatchList() {
    watchListDirty = false;
    const container = document.getElementById('schedule-sub-watchlist');
    if (!container) return;
    container.innerHTML = `<p style="color:#64748b;padding:20px 0;">Computing Watch List…</p>`;

    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (eventKey) {
        const saved = parseFloat(localStorage.getItem(`wlCalibrationBeta_${eventKey}`));
        wlCalibrationBeta = isNaN(saved) ? 1.0 : saved;
    }
    if (!eventKey) {
        container.innerHTML = `<p style="color:#64748b;padding:20px 0;">Enter an event key first.</p>`;
        return;
    }

    const gameConfig = getGameConfig(eventKey);
    const effectiveThresholds = getEffectiveThresholds(gameConfig, eventKey);

    const [allMatches, allTBATeams, allTeams] = await Promise.all([
        db.matches.where('eventKey').equals(eventKey).toArray(),
        db.tbaTeams.toArray(),
        db.teams.toArray(),
    ]);

    if (!allMatches.length) {
        container.innerHTML = `<p style="color:#64748b;padding:20px 0;">No schedule loaded — sync TBA matches first.</p>`;
        return;
    }

    const tbaMap   = Object.fromEntries(allTBATeams.map(t => [t.teamNumber, t]));
    const teamsMap = Object.fromEntries(allTeams.map(t => [t.teamNumber, t]));
    const allTeamNums = [...new Set(
        allMatches.flatMap(m => [...(m.red ?? []), ...(m.blue ?? [])]).map(tn => parseInt(tn)).filter(n => !isNaN(n))
    )];
    const cutoffN  = watchListCutoff;
    const totalMatchCount = allMatches.length;

    // Load or silently compute pre-event baseline (run once per event key)
    const snapshotKey = `wlPreEventSnapshot_${eventKey}`;
    const storedSnap = localStorage.getItem(snapshotKey);
    wlPreEventCache = storedSnap ? JSON.parse(storedSnap) : null;
    if (!wlPreEventCache) {
        wlPreEventCache = computePreEventSnapshot(eventKey, allMatches, teamsMap, tbaMap, allTeamNums, gameConfig, effectiveThresholds);
    }

    const playedMatches = allMatches.filter(m =>
        (m.redScore ?? -1) >= 0 && (cutoffN == null || m.matchNumber <= cutoffN)
    );
    const unplayed = allMatches.filter(m =>
        (m.redScore ?? -1) < 0 || (cutoffN != null && m.matchNumber > cutoffN)
    );

    const lastPlayedNum = playedMatches.length > 0
        ? Math.max(...playedMatches.map(m => m.matchNumber)) : null;
    wlComputedAsOf = cutoffN != null ? `Q${cutoffN}` : lastPlayedNum != null ? `Q${lastPlayedNum}` : null;

    const focusedTN  = String(window.currentFocusedTeam || OWN_TEAM);
    const { relResiduals, diffResiduals } = wlCollectResiduals(playedMatches, tbaMap, teamsMap);

    // Pre-build fuel OPR for each unique score component used in threshold RPs.
    // Falls back to Statbotics EPA (fuelEPAKey) when OPR is underdetermined.
    const fuelOPRCache = {};
    for (const rpt of effectiveThresholds) {
        if (rpt.threshold != null && rpt.scoreComponent && !(rpt.scoreComponent in fuelOPRCache)) {
            fuelOPRCache[rpt.scoreComponent] = wlComputeFuelOPR(playedMatches, allTeamNums, rpt.scoreComponent, gameConfig);
        }
    }

    // Predict all unplayed matches
    const matchPredictions = {};
    for (const m of unplayed) {
        matchPredictions[m.key] = wlSimulateMatch(m, tbaMap, teamsMap, allTeamNums, relResiduals, diffResiduals, gameConfig, effectiveThresholds, playedMatches, fuelOPRCache);
    }


    const baseRP      = wlComputeActualRP(playedMatches);
    const rankDistrib = wlSimulateStandings(baseRP, unplayed, matchPredictions, effectiveThresholds);

    wlDetailCache = { allMatches, matchPredictions, baseRP, playedMatches, effectiveThresholds, rankDistrib, teamsMap,
                      tbaMap, allTeamNums, relResiduals, diffResiduals, fuelOPRCache, gameConfig };

    const focDist = rankDistrib[focusedTN] ?? { mean: '?', p10: '?', p90: '?' };
    const focRP   = baseRP[focusedTN] ?? 0;
    const top12Set = new Set(
        Object.entries(rankDistrib).sort((a, b) => a[1].mean - b[1].mean).slice(0, 12).map(([tn]) => tn)
    );
    const focusedRank = typeof rankDistrib[focusedTN]?.mean === 'number' ? rankDistrib[focusedTN].mean : null;

    const yourMatches  = unplayed.filter(m =>  m.red?.includes(focusedTN) || m.blue?.includes(focusedTN));
    const otherMatches = unplayed.filter(m => !m.red?.includes(focusedTN) && !m.blue?.includes(focusedTN));

    // ── Controls (rendered into Dev tab, not Watch List banner) ──────────────
    const devCtrlEl = document.getElementById('dev-wl-controls-content');
    if (devCtrlEl) devCtrlEl.innerHTML = buildWLControlsHTML(eventKey, effectiveThresholds, totalMatchCount, tbaMap);

    const debugBanner = cutoffN != null
        ? `<div style="background:rgba(251,191,36,0.08);border:1px solid #b45309;border-radius:6px;padding:8px 14px;margin-bottom:12px;color:#fbbf24;font-size:0.85em;">
               ⚠ Debug mode — simulating from match ${cutoffN} (${playedMatches.length} played, ${unplayed.length} remaining)
           </div>` : '';

    // ── Standings table ───────────────────────────────────────────────────────

    const standingsRows = Object.entries(rankDistrib)
        .sort((a, b) => a[1].mean - b[1].mean)
        .slice(0, 12)
        .map(([tn, d], i) => {
            const isFoc  = tn === focusedTN;
            const stat   = teamsMap[parseInt(tn)];
            const epa    = stat?.currentEPA;
            const sd     = stat?.epa?.total_points?.sd;
            const epaStr = epa != null
                ? `<span style="color:#64748b;font-size:0.78em;font-weight:400;margin-left:5px;">${epa.toFixed(0)}${sd != null ? ` ±${sd.toFixed(0)}` : ''}</span>`
                : '';
            const preD = wlPreEventCache?.rankDistrib?.[tn];
            const prePart = preD ? `<span style="color:#475569;font-size:0.78em;"> · pre&nbsp;${preD.mean}</span>` : '';
            return `<tr onclick="viewTeamDetail(${tn},'matches')" style="cursor:pointer;${isFoc ? 'background:rgba(251,191,36,0.06);font-weight:600;' : ''}">
                <td style="padding:4px 8px;text-align:center;color:#64748b;">${i + 1}</td>
                <td style="padding:4px 8px;${isFoc ? 'color:#fbbf24;' : ''}">${tn}${ownStar(tn)}${epaStr}</td>
                <td style="padding:4px 8px;text-align:center;color:#94a3b8;">${baseRP[tn] ?? 0}</td>
                <td style="padding:4px 8px;text-align:center;">${d.mean}${prePart} <span style="color:#64748b;font-size:0.82em;font-weight:400;">(${d.meanRP.toFixed(1)} RP)</span></td>
                <td style="padding:4px 8px;text-align:center;color:#64748b;font-size:0.82em;">${d.p10}–${d.p90}</td>
            </tr>`;
        }).join('');

    // ── Match card builder ────────────────────────────────────────────────────

    const matchCard = (m, pred, impactLabel = '', rankInfo = null) => {
        if (!m || !pred) return '';
        const redFoc  = m.red?.includes(focusedTN);
        const blueFoc = m.blue?.includes(focusedTN);

        // Focused team's alliance always on the left; default red-left
        const leftIsBlue  = blueFoc && !redFoc;
        const leftTeams   = leftIsBlue ? (m.blue ?? []) : (m.red  ?? []);
        const rightTeams  = leftIsBlue ? (m.red  ?? []) : (m.blue ?? []);
        const leftLabel   = leftIsBlue ? 'BLU' : 'RED';
        const rightLabel  = leftIsBlue ? 'RED' : 'BLU';
        const leftColor   = leftIsBlue ? '#3b82f6' : '#ef4444';
        const rightColor  = leftIsBlue ? '#ef4444' : '#3b82f6';
        const leftBarClr  = leftIsBlue ? 'rgba(59,130,246,0.5)'  : 'rgba(239,68,68,0.5)';
        const rightBarClr = leftIsBlue ? 'rgba(239,68,68,0.5)'   : 'rgba(59,130,246,0.5)';
        const leftPctNum  = leftIsBlue ? pred.blueProb  : pred.redProb;
        const rightPctNum = leftIsBlue ? pred.redProb   : pred.blueProb;
        const leftPred    = leftIsBlue ? pred.bluePredicted : pred.redPredicted;
        const rightPred   = leftIsBlue ? pred.redPredicted  : pred.bluePredicted;
        const leftRank    = rankInfo ? (leftIsBlue  ? rankInfo.rankIfBlueWins : rankInfo.rankIfRedWins)  : null;
        const rightRank   = rankInfo ? (leftIsBlue  ? rankInfo.rankIfRedWins  : rankInfo.rankIfBlueWins) : null;

        const leftPct  = Math.round(leftPctNum  * 100);
        const rightPct = Math.round(rightPctNum * 100);

        // Favorable = focused team's own alliance (always left), or whichever side gives a better rank
        let favorableLeft = null;
        if (redFoc || blueFoc) {
            favorableLeft = true;
        } else if (leftRank !== null && rightRank !== null && leftRank !== rightRank) {
            favorableLeft = leftRank < rightRank;  // lower rank number = better
        }

        const teamSpan = (tn) => {
            const isFoc = String(tn) === focusedTN;
            let skull = '';
            if (!isFoc && focusedRank !== null && top12Set.has(String(tn))) {
                const tnRank = rankDistrib[String(tn)]?.mean;
                if (typeof tnRank === 'number') {
                    const color = tnRank < focusedRank ? '#ef4444' : '#fbbf24';
                    const title = tnRank < focusedRank
                        ? `Projected ahead of ${focusedTN} (~rank ${tnRank.toFixed(1)})`
                        : `Projected behind ${focusedTN} (~rank ${tnRank.toFixed(1)})`;
                    skull = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="${color}" fill-rule="evenodd" style="vertical-align:middle;margin-left:2px;flex-shrink:0;" title="${title.replace(/"/g,'&quot;')}"><path d="M12,2A9,9 0 0,1 21,11C21,14.03 19.5,16.82 17,18.5V21A1,1 0 0,1 16,22H8A1,1 0 0,1 7,21V18.5C4.5,16.82 3,14.03 3,11A9,9 0 0,1 12,2M9,9A2,2 0 0,0 7,11A2,2 0 0,0 9,13A2,2 0 0,0 11,11A2,2 0 0,0 9,9M15,9A2,2 0 0,0 13,11A2,2 0 0,0 15,13A2,2 0 0,0 17,11A2,2 0 0,0 15,9M12,17A1,1 0 0,0 11,18A1,1 0 0,0 12,19A1,1 0 0,0 13,18A1,1 0 0,0 12,17Z"/></svg>`;
                }
            }
            return `<span onclick="event.stopPropagation();highlightTeam('${tn}')" style="cursor:pointer;${isFoc?'color:#fbbf24;font-weight:700;':''}">${tn}${ownStar(tn)}${skull}</span>`;
        };

        const rankRow = `
            <div style="display:flex;justify-content:space-between;font-size:0.78em;color:#64748b;margin-top:3px;">
                <span>${leftRank != null ? `rank if won: ${leftRank.toFixed(1)}` : '…'}</span>
                <span>${rightRank != null ? `rank if won: ${rightRank.toFixed(1)}` : '…'}</span>
            </div>`;

        const rpRow = effectiveThresholds.length ? `
            <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:7px;font-size:0.78em;color:#94a3b8;">
                ${effectiveThresholds.map(rpt => {
                    const prob = redFoc ? (pred.rpProbs.red[rpt.rpField] ?? 0)
                               : blueFoc ? (pred.rpProbs.blue[rpt.rpField] ?? 0)
                               : Math.max(pred.rpProbs.red[rpt.rpField] ?? 0, pred.rpProbs.blue[rpt.rpField] ?? 0);
                    const pct = Math.round(prob * 100);
                    const fill = `linear-gradient(to right,#22c55e ${pct}%,#1e293b ${pct}%)`;
                    return `<span>${rpt.label} <span style="display:inline-block;width:44px;height:6px;border-radius:3px;background:${fill};vertical-align:middle;margin:0 3px;"></span>${pct}%</span>`;
                }).join('')}
            </div>` : '';

        return `<div id="wmc-${m.key}" onclick="viewMatchDetail('${m.key}')" style="cursor:pointer;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px 14px;margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">
                <strong style="color:#3b82f6;cursor:pointer;" onclick="event.stopPropagation();viewMatchPrep('${m.key}')">Q${m.matchNumber}</strong>
                ${impactLabel ? `<span style="color:#64748b;font-size:0.78em;">rank impact ±${impactLabel}</span>` : ''}
            </div>
            <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:6px;gap:8px;">
                <div>
                    <div style="color:${leftColor};font-size:0.72em;font-weight:700;letter-spacing:0.05em;margin-bottom:2px;">${leftLabel}</div>
                    <div style="font-size:0.88em;">${leftTeams.map(teamSpan).join(' · ')}</div>
                </div>
                <div style="text-align:right;">
                    <div style="color:${rightColor};font-size:0.72em;font-weight:700;letter-spacing:0.05em;margin-bottom:2px;">${rightLabel}</div>
                    <div style="font-size:0.88em;">${rightTeams.map(teamSpan).join(' · ')}</div>
                </div>
            </div>
            <div style="display:flex;height:18px;border-radius:4px;overflow:hidden;">
                <div style="flex:${Math.max(leftPct,1)};background:${leftBarClr};display:flex;align-items:center;padding:0 6px;font-size:0.75em;font-weight:700;${favorableLeft===true?'box-shadow:inset 0 0 0 2px rgba(255,255,255,0.55);':''}">
                    <span style="color:${leftIsBlue?'#93c5fd':'#fca5a5'};">${leftPct}%</span>
                </div>
                <div style="flex:${Math.max(rightPct,1)};background:${rightBarClr};display:flex;align-items:center;justify-content:flex-end;padding:0 6px;font-size:0.75em;font-weight:700;${favorableLeft===false?'box-shadow:inset 0 0 0 2px rgba(255,255,255,0.55);':''}">
                    <span style="color:${leftIsBlue?'#fca5a5':'#93c5fd'};">${rightPct}%</span>
                </div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.82em;color:#475569;margin-top:5px;">
                <span>${leftPred.toFixed(0)} pts</span>
                <span>${rightPred.toFixed(0)} pts</span>
            </div>
            ${rankRow}
            ${rpRow}
        </div>`;
    };

    // ── Initial render ────────────────────────────────────────────────────────

    container.innerHTML = `
        ${debugBanner}
        <div id="wl-main-banner" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 14px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;margin-bottom:14px;">
            <span style="color:#f8fafc;font-weight:600;">Watching: ${focusedTN}</span>
            <span style="color:#334155;">|</span>
            <span style="color:#94a3b8;font-size:0.88em;">${focRP} RP · Proj rank ${focDist.p10}–${focDist.p90} (avg ${focDist.mean})${wlComputedAsOf ? ` · as of ${wlComputedAsOf}` : ''}</span>
            <button id="wl-update-btn" onclick="renderWatchList()" style="display:none;margin-left:auto;background:#1d4ed8;color:#f8fafc;border:none;border-radius:6px;padding:4px 14px;font-size:0.82em;font-weight:600;cursor:pointer;">Update</button>
        </div>

        <div id="wl-progress-wrap" style="margin-bottom:14px;">
            <div style="display:flex;justify-content:space-between;font-size:0.75em;color:#64748b;margin-bottom:4px;">
                <span>Computing impact analysis…</span>
                <span id="wl-progress-pct">0%</span>
            </div>
            <div style="height:4px;background:#1e293b;border-radius:2px;">
                <div id="wl-progress-bar" style="height:100%;width:0%;background:#3b82f6;border-radius:2px;transition:width 0.15s;"></div>
            </div>
        </div>

        <div style="margin-bottom:20px;">
            <div onclick="window.toggleWLSection('standings')" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;color:#94a3b8;font-size:0.75em;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px;user-select:none;">
                <span>Projected Standings (top 12)</span>
                <span id="wl-standings-arrow" style="font-size:0.9em;">${wlStandingsCollapsed ? '▶' : '▼'}</span>
            </div>
            <div id="wl-standings-body" style="${wlStandingsCollapsed ? 'display:none' : ''}">
                <div style="overflow-x:auto;">
                    <table style="width:100%;border-collapse:collapse;font-size:0.85em;">
                        <thead><tr style="color:#64748b;font-size:0.78em;text-transform:uppercase;letter-spacing:0.04em;">
                            <th style="padding:4px 8px;text-align:center;">#</th>
                            <th style="padding:4px 8px;">Team · EPA ±SD</th>
                            <th style="padding:4px 8px;text-align:center;">RP Now</th>
                            <th style="padding:4px 8px;text-align:center;">Proj. Rank · Total RP</th>
                            <th style="padding:4px 8px;text-align:center;">Range</th>
                        </tr></thead>
                        <tbody>${standingsRows}</tbody>
                    </table>
                </div>
            </div>
        </div>

        <div onclick="window.toggleWLSection('your')" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;color:#94a3b8;font-size:0.75em;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px;user-select:none;">
            <span>Your Remaining Matches (${yourMatches.length})</span>
            <span id="wl-your-arrow" style="font-size:0.9em;">${wlYourCollapsed ? '▶' : '▼'}</span>
        </div>
        <div id="wl-your-matches" style="${wlYourCollapsed ? 'display:none' : ''}">
            ${yourMatches.length
                ? yourMatches.map(m => matchCard(m, matchPredictions[m.key], '…')).join('')
                : `<p style="color:#475569;font-size:0.85em;margin-bottom:16px;">No remaining matches for team ${focusedTN}.</p>`}
        </div>

        <div id="wl-other-header" onclick="window.toggleWLSection('other')" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;color:#94a3b8;font-size:0.75em;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin:16px 0 8px;user-select:none;">
            <span id="wl-other-header-text">Matches to Watch — computing impact…</span>
            <span id="wl-other-arrow" style="font-size:0.9em;">${wlOtherCollapsed ? '▶' : '▼'}</span>
        </div>
        <div id="wl-other-matches" style="${wlOtherCollapsed ? 'display:none' : ''}">
            ${otherMatches.map(m => matchCard(m, matchPredictions[m.key], '')).join('')}
        </div>`;

    // ── Async impact analysis ─────────────────────────────────────────────────
    // Process one match per idle frame (your + other combined), then re-render both sections.

    const allWLMatches = [
        ...yourMatches.map(m => ({ match: m, isYours: true })),
        ...otherMatches.map(m => ({ match: m, isYours: false })),
    ];
    const impactResults = [];
    const _focusedTN   = focusedTN;
    const _baselineMean = +focDist.mean;
    const _unplayed    = unplayed;
    const _matchPred   = matchPredictions;
    const _baseRP      = baseRP;
    const _thresholds  = effectiveThresholds;
    const _matchCard   = matchCard;
    const _yourLen     = yourMatches.length;
    let _idx = 0;

    const sched = typeof requestIdleCallback !== 'undefined'
        ? (fn) => requestIdleCallback(fn, { timeout: 200 })
        : (fn) => setTimeout(fn, 0);

    const _total = allWLMatches.length;

    const updateProgress = (done) => {
        const pct = _total > 0 ? Math.round((done / _total) * 100) : 100;
        const bar  = document.getElementById('wl-progress-bar');
        const pctEl = document.getElementById('wl-progress-pct');
        if (bar)   bar.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
    };

    const processNext = () => {
        if (_idx >= _total) {
            // Hide progress bar
            const wrap = document.getElementById('wl-progress-wrap');
            if (wrap) wrap.style.display = 'none';

            // Re-render "Your Matches" in match-number order with impact labels
            if (_yourLen > 0) {
                const yourResults = impactResults
                    .filter(r => r.isYours)
                    .sort((a, b) => a.match.matchNumber - b.match.matchNumber);
                const yourSection = document.getElementById('wl-your-matches');
                if (yourSection) yourSection.innerHTML =
                    yourResults.map(r => _matchCard(r.match, _matchPred[r.match.key], r.impact.toFixed(1) + ' pos', { rankIfRedWins: r.rankIfRedWins, rankIfBlueWins: r.rankIfBlueWins })).join('');
            }

            // Re-render "Matches to Watch" sorted by impact × uncertainty
            const significant = impactResults
                .filter(r => !r.isYours && r.impact >= 0.05)
                .sort((a, b) => b.score - a.score)
                .slice(0, 10);
            const headerText = document.getElementById('wl-other-header-text');
            const section    = document.getElementById('wl-other-matches');
            if (headerText) headerText.textContent = `Matches to Watch (${significant.length}) — by impact × uncertainty`;
            if (section) section.innerHTML = significant.length
                ? significant.map(r => _matchCard(r.match, _matchPred[r.match.key], r.impact.toFixed(1) + ' pos', { rankIfRedWins: r.rankIfRedWins, rankIfBlueWins: r.rankIfBlueWins })).join('')
                : `<p style="color:#475569;font-size:0.85em;">No matches found that significantly affect ${_focusedTN}'s ranking.</p>`;
            return;
        }
        const { match: m, isYours } = allWLMatches[_idx++];
        const pred = _matchPred[m.key];
        const uncertainty = 1 - Math.abs((pred?.redProb ?? 0.5) - (pred?.blueProb ?? 0.5));
        const scaledN = Math.max(25, Math.round(500 * uncertainty));
        const { impact, rankIfRedWins, rankIfBlueWins } = wlComputeImpact(_focusedTN, _baselineMean, m.key, _unplayed, _matchPred, _baseRP, _thresholds, scaledN);
        impactResults.push({ match: m, isYours, impact, score: impact * uncertainty, rankIfRedWins, rankIfBlueWins });
        updateProgress(_idx);
        sched(processNext);
    };
    sched(processNext);
}

window.saveWatchRPThreshold = function (rpField, value, eventKey) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(`rpThresholds_${eventKey}`) || '{}'); } catch {}
    saved[rpField] = Number(value);
    localStorage.setItem(`rpThresholds_${eventKey}`, JSON.stringify(saved));
    renderWatchList();
};

window.resetWatchRPThresholds = function (eventKey) {
    localStorage.removeItem(`rpThresholds_${eventKey}`);
    renderWatchList();
};

window.setWatchListCutoff = function (val) {
    watchListCutoff = val == null ? null : parseInt(val);
    renderWatchList();
};

// Apply a linear calibration factor derived from backtesting.
// p_cal = 0.5 + beta*(p − 0.5). Resets to 1.0 (no-op) on page reload.
window.applyWLCalibration = function (beta) {
    wlCalibrationBeta = parseFloat(beta) || 1.0;
    const evk = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (evk) localStorage.setItem(`wlCalibrationBeta_${evk}`, String(wlCalibrationBeta));
    watchListDirty = true;
    if (document.getElementById('schedule-sub-watchlist')?.style.display !== 'none') {
        renderWatchList();
    }
    // Re-run backtest so the badge updates immediately to show the new current β
    runBacktest();
};

// --- Backtest event data fetcher ---

// Session-level cache so repeated runs don't re-fetch the same events.
const btEventCache = new Map();

// Fetch match results, OPR, and Statbotics EPA for any event key that isn't the current event.
// Returns { matches, tbaMap, teamsMap } in the same shape wlSimulateMatch expects.
async function btFetchEventData(eventKey) {
    if (btEventCache.has(eventKey)) return btEventCache.get(eventKey);

    const [matchResp, oprResp, sbResp] = await Promise.all([
        fetchTBA(`/event/${eventKey}/matches`),
        fetchTBA(`/event/${eventKey}/oprs`),
        fetch(`https://api.statbotics.io/v3/team_events?event=${eventKey}`).then(r => r.json()),
    ]);

    const matches = (Array.isArray(matchResp) ? matchResp : [])
        .filter(m => m.comp_level === 'qm')
        .sort((a, b) => a.match_number - b.match_number)
        .map(m => ({
            key:           m.key,
            matchNumber:   m.match_number,
            red:           m.alliances.red.team_keys.map(k => k.replace('frc', '')),
            blue:          m.alliances.blue.team_keys.map(k => k.replace('frc', '')),
            redScore:      m.alliances.red.score,
            blueScore:     m.alliances.blue.score,
            redBreakdown:  m.score_breakdown?.red  ?? null,
            blueBreakdown: m.score_breakdown?.blue ?? null,
        }));

    const tbaMap = {};
    for (const [teamKey, opr] of Object.entries(oprResp?.oprs ?? {})) {
        const tn = parseInt(teamKey.replace('frc', ''));
        tbaMap[tn] = { teamNumber: tn, opr };
    }

    const sbList = Array.isArray(sbResp) ? sbResp : (sbResp?.data ?? sbResp?.results ?? []);
    const teamsMap = {};
    for (const t of sbList) {
        teamsMap[t.team] = {
            teamNumber: t.team,
            currentEPA: t.epa?.total_points?.mean ?? null,
            epa:        t.epa ?? null,
        };
    }

    const result = { matches, tbaMap, teamsMap };
    btEventCache.set(eventKey, result);
    return result;
}

// --- Statistical helpers for backtest calibration ---

// Standard normal CDF (Abramowitz & Stegun 26.2.17, accurate to ~7 decimal places)
function btNormalCDF(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
    return z >= 0 ? p : 1 - p;
}
function btP2(z) { return 2 * (1 - btNormalCDF(Math.abs(z))); }

// Chi-squared upper-tail p-value via Wilson-Hilferty normal approximation (good for df >= 3)
function btChi2P(chi2, df) {
    if (chi2 <= 0 || df < 1) return 1;
    const z = (Math.pow(chi2 / df, 1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
    return 1 - btNormalCDF(z);
}

// Spiegelhalter (1986) Z-test — tests calibration without binning.
// Z = Σ(y_i − p_i)(1 − 2p_i) / √(Σ p_i(1−p_i)(1−2p_i)²)
// Z > 0: overconfident (probs too extreme). Z < 0: underconfident (probs too conservative).
// H0: Z ~ N(0,1). High p-value = no significant miscalibration.
function btSpiegelhalter(results) {
    let num = 0, denom = 0;
    for (const { p, won } of results) {
        const y = won ? 1 : 0;
        num   += (y - p) * (1 - 2 * p);
        denom += p * (1 - p) * (1 - 2 * p) ** 2;
    }
    if (denom <= 0) return { z: 0, p: 1 };
    const z = num / Math.sqrt(denom);
    return { z, p: btP2(z) };
}

// Hosmer-Lemeshow C-statistic (bin-based chi-squared calibration test).
// C = Σ_k (O_k − E_k)² / (n_k · p̄_k · (1 − p̄_k)),  C ~ χ²(bins_used − 2)
// E_k = sum of predicted p_i in bin k (not just midpoint × count).
function btHosmerLemeshow(bins) {
    let C = 0, used = 0;
    for (const b of bins) {
        if (b.count < 1) continue;
        const Ek = b.predicted;     // sum of p_i, i.e. expected wins in bin
        const pk = Ek / b.count;
        if (pk <= 0 || pk >= 1) continue;
        C += (b.actual - Ek) ** 2 / (b.count * pk * (1 - pk));
        used++;
    }
    const df = Math.max(1, used - 2);
    return { C, df, p: btChi2P(C, df) };
}

// Wilson score 95% confidence interval for a proportion.
function btWilson(k, n) {
    if (n === 0) return [0, 1];
    const z = 1.96, p = k / n;
    const denom = 1 + z * z / n;
    const center = (p + z * z / (2 * n)) / denom;
    const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
    return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// Backtest the win-probability model across one or more event keys.
// For each match i within an event, predicts using only matches 0..i-1 (forward simulation).
// The current event is read from IndexedDB; all others are fetched from TBA + Statbotics.
window.runBacktest = async function () {
    const resultsEl = document.getElementById('algo-backtest-results');
    if (!resultsEl) return;

    const currentEv = localStorage.getItem('selectedEvent') || '';
    const input     = document.getElementById('bt-event-keys');
    if (input && !input.value.trim()) input.value = currentEv;

    const eventKeys = (input?.value || currentEv)
        .split(/[\s,]+/)
        .map(k => k.trim().toLowerCase())
        .filter(Boolean);

    if (!eventKeys.length) {
        resultsEl.innerHTML = '<p style="color:#64748b;">Enter at least one event key.</p>';
        return;
    }

    // Pre-load current event data from IndexedDB once
    const [rawMatchesDB, tbaArrDB, teamsArrDB] = await Promise.all([
        db.matches.toArray(),
        db.tbaTeams.toArray(),
        db.teams.toArray(),
    ]);
    const dbTBAMap   = {};  tbaArrDB.forEach(t   => { dbTBAMap[t.teamNumber]   = t; });
    const dbTeamsMap = {};  teamsArrDB.forEach(t  => { dbTeamsMap[t.teamNumber] = t; });
    const dbPlayed   = rawMatchesDB
        .filter(m => (m.redScore ?? -1) >= 0)
        .sort((a, b) => a.matchNumber - b.matchNumber);

    const results = [];        // { eventKey, matchNum, p, won }
    const eventRows = [];      // { key, count, error } — one per event for the header table

    for (let ei = 0; ei < eventKeys.length; ei++) {
        const eventKey = eventKeys[ei];
        resultsEl.innerHTML = `<p style="color:#64748b;font-style:italic;">Fetching ${eventKey} (${ei + 1}/${eventKeys.length})…</p>`;

        let matches, tbaMap, teamsMap;
        try {
            if (eventKey === currentEv) {
                matches  = dbPlayed;
                tbaMap   = dbTBAMap;
                teamsMap = dbTeamsMap;
            } else {
                ({ matches, tbaMap, teamsMap } = await btFetchEventData(eventKey));
                matches = matches.filter(m => (m.redScore ?? -1) >= 0);
            }
        } catch (e) {
            eventRows.push({ key: eventKey, count: 0, error: `Fetch failed: ${e.message ?? e}` });
            continue;
        }

        const played = [...matches].sort((a, b) => a.matchNumber - b.matchNumber);
        if (played.length < 3) {
            eventRows.push({ key: eventKey, count: 0, error: 'Too few played matches' });
            continue;
        }

        const evGameConfig = getGameConfig(eventKey);
        let evCount = 0;

        for (let i = 0; i < played.length; i++) {
            const m = played[i];
            if (m.redScore === m.blueScore) continue;   // skip ties

            const history = played.slice(0, i);
            const { relResiduals, diffResiduals } = wlCollectResiduals(history, tbaMap, teamsMap);

            const pred = wlSimulateMatch(
                m, tbaMap, teamsMap, [],
                relResiduals, diffResiduals,
                evGameConfig, [],   // win probability only, no RP thresholds
                history, {},
                400
            );

            results.push({ eventKey, matchNum: m.matchNumber, p: pred.redProb, won: m.redScore > m.blueScore });
            evCount++;
            if (i % 8 === 0) await new Promise(r => setTimeout(r, 0));
        }

        eventRows.push({ key: eventKey, count: evCount, error: null });
    }

    if (!results.length) {
        resultsEl.innerHTML = '<p style="color:#64748b;">No non-tie matches found across the selected events.</p>';
        return;
    }

    // Fold to "favorite" perspective: favP ∈ [0.5, 1] always represents the predicted winner.
    // Doubles effective n per bucket vs the red/blue framing and eliminates the asymmetric tail.
    // Spiegelhalter Z and β_opt are provably invariant to this folding.
    const favResults = results.map(r => ({
        p:   Math.max(r.p, 1 - r.p),
        won: (r.p >= 0.5) === r.won,   // did the predicted favorite actually win?
    }));

    // 5-bin calibration (50–60% … 90–100%) — track predicted (sum of p_i) for proper H-L E_k
    const bins = Array.from({ length: 5 }, (_, i) => ({
        label: `${50 + i * 10}–${60 + i * 10}%`, midpoint: 55 + i * 10,
        actual: 0, predicted: 0, count: 0,
    }));
    for (const r of favResults) {
        const b = Math.min(4, Math.floor((r.p - 0.5) * 10));
        bins[b].actual    += r.won ? 1 : 0;
        bins[b].predicted += r.p;
        bins[b].count++;
    }

    // Summary stats (Brier score and accuracy are invariant to the favorite-folding)
    const brier    = favResults.reduce((s, r) => s + (r.p - (r.won ? 1 : 0)) ** 2, 0) / favResults.length;
    const accuracy = favResults.filter(r => r.won).length / favResults.length;

    // Statistical tests (Spiegelhalter Z is also invariant to folding — proved in comments above)
    const sp = btSpiegelhalter(favResults);
    const hl = btHosmerLemeshow(bins);

    // β_opt = Σ(y-0.5)(p-0.5) / Σ(p-0.5)² — also invariant to folding
    let betaNum = 0, betaDenom = 0;
    for (const { p, won } of favResults) {
        betaNum   += ((won ? 1 : 0) - 0.5) * (p - 0.5);
        betaDenom += (p - 0.5) ** 2;
    }
    const betaOpt = betaDenom > 0 ? Math.max(0.1, Math.min(2.0, betaNum / betaDenom)) : 1.0;
    const betaCurrent = wlCalibrationBeta;

    const pBadge = (p, label) => {
        const [color, verdict] = p > 0.10 ? ['#22c55e', 'calibrated']
                               : p > 0.05 ? ['#f59e0b', 'marginal']
                               :            ['#ef4444', 'miscalibrated'];
        const pStr = p < 0.001 ? '<0.001' : p.toFixed(3);
        return `<span style="color:${color};font-weight:600">${verdict}</span> <span style="color:#64748b">(${label}, p = ${pStr})</span>`;
    };

    // Calibration table rows — each bucket gets a Wilson 95% CI bar
    const rows = bins.map(b => {
        if (!b.count) {
            return `<tr><td style="color:#2d3f57;padding:5px 8px;font-size:0.82em">${b.label}</td>
                <td colspan="3" style="color:#2d3f57;text-align:center;font-size:0.82em">—</td></tr>`;
        }
        const [lo, hi]  = btWilson(b.actual, b.count);
        const actualPct = b.actual / b.count * 100;
        const midInCI   = b.midpoint >= lo * 100 && b.midpoint <= hi * 100;
        const barColor  = midInCI ? '#3b82f6' : '#f59e0b';

        // 100px bar = 0–100%; CI band + actual tick + expected tick
        const toBar = (pct) => Math.max(0, Math.min(100, Math.round(pct)));
        const loW  = toBar(lo  * 100);
        const hiW  = toBar(hi  * 100);
        const actW = toBar(actualPct);
        const midW = toBar(b.midpoint);
        const bar = `<div style="position:relative;height:10px;width:100px;background:#1e293b;border-radius:3px;display:inline-block;vertical-align:middle;">
            <div style="position:absolute;top:0;left:${loW}px;width:${Math.max(1,hiW-loW)}px;height:100%;background:${barColor};opacity:0.22;"></div>
            <div style="position:absolute;top:0;left:${midW}px;width:1px;height:100%;background:#475569;"></div>
            <div style="position:absolute;top:0;left:${Math.max(0,actW-1)}px;width:2px;height:100%;background:${barColor};border-radius:1px;"></div>
        </div>`;
        const ciText = `${(lo*100).toFixed(0)}–${(hi*100).toFixed(0)}%`;
        const checkMark = midInCI
            ? `<span style="color:#22c55e">✓</span>`
            : `<span style="color:#f59e0b" title="Expected midpoint ${b.midpoint}% falls outside 95% CI">⚠</span>`;

        return `<tr>
            <td style="color:#94a3b8;padding:5px 8px;font-size:0.82em">${b.label}</td>
            <td style="text-align:center;padding:5px 8px;font-size:0.82em">${b.count}</td>
            <td style="padding:5px 8px">${bar}</td>
            <td style="text-align:center;padding:5px 8px;font-size:0.82em;color:#94a3b8">${actualPct.toFixed(0)}% <span style="color:#475569">[${ciText}]</span></td>
            <td style="text-align:center;padding:5px 8px;font-size:0.82em">${checkMark}</td>
        </tr>`;
    }).join('');

    // Per-event summary pills
    const evPills = eventRows.map(ev => {
        if (ev.error) {
            return `<span style="display:inline-flex;align-items:center;gap:5px;background:#1c0f0f;border:1px solid #7f1d1d;border-radius:4px;padding:2px 8px;font-size:0.78em;color:#fca5a5;">${ev.key} <span style="color:#64748b">— ${ev.error}</span></span>`;
        }
        return `<span style="display:inline-flex;align-items:center;gap:5px;background:#0c1929;border:1px solid #1e3a5f;border-radius:4px;padding:2px 8px;font-size:0.78em;color:#93c5fd;">${ev.key} <span style="color:#475569">${ev.count} matches</span></span>`;
    }).join(' ');

    resultsEl.innerHTML = `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">${evPills}</div>
        <div style="display:flex;gap:24px;margin-bottom:14px;flex-wrap:wrap;">
            <div><span style="color:#64748b;font-size:0.82em;">Matches tested</span><br><b style="font-size:1.1em">${results.length}</b></div>
            <div><span style="color:#64748b;font-size:0.82em;">Accuracy</span><br><b style="font-size:1.1em">${(accuracy * 100).toFixed(0)}%</b></div>
            <div><span style="color:#64748b;font-size:0.82em;">Brier score</span><br><b style="font-size:1.1em">${brier.toFixed(3)}</b><span style="color:#475569;font-size:0.79em;margin-left:5px;">(random = 0.25)</span></div>
        </div>
        <div style="background:#0c1929;border:1px solid #1e293b;border-radius:7px;padding:12px 14px;margin-bottom:14px;font-size:0.83em;line-height:1.9;">
            <div>Spiegelhalter Z = ${sp.z.toFixed(2)} &nbsp;→&nbsp; ${pBadge(sp.p, 'no binning')}
                <span style="color:#475569;font-size:0.9em;margin-left:6px;">
                    ${sp.z > 0 ? '(overconfident — probabilities too extreme)' : '(underconfident — probabilities too conservative)'}
                </span>
            </div>
            <div>Hosmer-Lemeshow C = ${hl.C.toFixed(2)}, df = ${hl.df} &nbsp;→&nbsp; ${pBadge(hl.p, 'bin-based χ²')}</div>
        </div>
        <div style="background:#0c1929;border:1px solid #1e3a5f;border-radius:7px;padding:12px 14px;margin-bottom:14px;font-size:0.83em;">
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                <div>
                    <span style="color:#64748b;">Optimal calibration β</span>
                    <b style="margin-left:6px;font-size:1.05em;color:${betaOpt < 0.97 ? '#f59e0b' : betaOpt > 1.03 ? '#60a5fa' : '#22c55e'}">${betaOpt.toFixed(3)}</b>
                    <span style="color:#475569;margin-left:6px;font-size:0.9em;">
                        ${betaOpt < 0.97 ? 'shrinks probabilities toward 50%' : betaOpt > 1.03 ? 'sharpens probabilities away from 50%' : 'no adjustment needed'}
                    </span>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <button onclick="applyWLCalibration(${betaOpt.toFixed(4)})"
                        style="background:#1e3a5f;color:#93c5fd;border:1px solid #2563eb;border-radius:5px;padding:4px 12px;font-size:0.85em;font-weight:600;cursor:pointer;">
                        Apply β = ${betaOpt.toFixed(3)} to Watch List
                    </button>
                    ${betaCurrent !== 1.0 ? `<button onclick="applyWLCalibration(1.0)"
                        style="background:#1a1a2e;color:#64748b;border:1px solid #334155;border-radius:5px;padding:4px 12px;font-size:0.85em;cursor:pointer;">
                        Reset (currently β = ${betaCurrent.toFixed(3)})
                    </button>` : ''}
                </div>
            </div>
            <p style="color:#475569;font-size:0.85em;margin:8px 0 0;line-height:1.5;">
                β = Σ(y−½)(p−½) / Σ(p−½)² — OLS estimate of the true calibration slope.
                Applying it corrects systematic over/underconfidence without changing the model's ranking of matches.
            </p>
        </div>
        <table style="width:100%;border-collapse:collapse;">
            <thead>
                <tr style="color:#475569;font-size:0.78em;text-align:left;border-bottom:1px solid #1e293b;">
                    <th style="padding:5px 8px;">Predicted Favorite Win%</th>
                    <th style="text-align:center;padding:5px 8px;">n</th>
                    <th style="padding:5px 8px;">Actual rate <span style="font-weight:400;color:#334155;">(95% CI band)</span></th>
                    <th style="text-align:center;padding:5px 8px;">Actual [95% CI]</th>
                    <th style="text-align:center;padding:5px 8px;">Expected in CI?</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
        <p style="color:#475569;font-size:0.79em;margin-top:12px;line-height:1.6;">
            Predictions are folded to the favorite's perspective (favP = max(redP, blueP)), doubling the effective sample per bucket.
            The bar shows a 95% Wilson CI (shaded) with the actual win rate (solid tick) and expected midpoint (gray tick).
            ✓ = the expected midpoint falls inside the CI. Spiegelhalter Z and β are invariant to this folding.
        </p>`;
};

window.toggleAlgoSection = function (id) {
    const body  = document.getElementById(id);
    const arrow = document.getElementById(id + '-arrow');
    if (!body) return;
    const collapsed = body.style.display === 'none';
    body.style.display  = collapsed ? '' : 'none';
    if (arrow) arrow.textContent = collapsed ? '▼' : '▶';
};

window.toggleWLSection = function (section) {
    if (section === 'standings') {
        wlStandingsCollapsed = !wlStandingsCollapsed;
        document.getElementById('wl-standings-body').style.display = wlStandingsCollapsed ? 'none' : '';
        document.getElementById('wl-standings-arrow').textContent = wlStandingsCollapsed ? '▶' : '▼';
    } else if (section === 'your') {
        wlYourCollapsed = !wlYourCollapsed;
        document.getElementById('wl-your-matches').style.display = wlYourCollapsed ? 'none' : '';
        document.getElementById('wl-your-arrow').textContent = wlYourCollapsed ? '▶' : '▼';
    } else {
        wlOtherCollapsed = !wlOtherCollapsed;
        document.getElementById('wl-other-matches').style.display = wlOtherCollapsed ? 'none' : '';
        document.getElementById('wl-other-arrow').textContent = wlOtherCollapsed ? '▶' : '▼';
    }
};

function pushCurrentRightPanel() {
    if (!document.body.classList.contains('split-ui')) return;
    for (const id of ['teamDetailView', 'matchDetailView', 'matchPrepView']) {
        const el = document.getElementById(id);
        const d = el?.style.display;
        if (d && d !== 'none') {
            rightPanelHistory.push({ id, display: d });
            el.style.display = 'none';
            return;
        }
    }
}

function popRightPanel() {
    if (rightPanelHistory.length === 0) return false;
    const { id, display } = rightPanelHistory.pop();
    document.getElementById(id).style.display = display;
    return true;
}

// Push a history entry so the native back gesture can dismiss overlays
function pushNavState(overlay) {
    history.pushState({ overlay }, '');
}

// Native back gesture/button: close the topmost visible overlay
window.addEventListener('popstate', () => {
    if (document.getElementById('scoutingBreakdownModal').style.display !== 'none') {
        window.closeScoutingBreakdown();
    } else if (document.getElementById('photoLightbox').style.display !== 'none') {
        window.closeLightbox();
    } else if (document.getElementById('matchDetailView').style.display !== 'none') {
        window.closeMatchDetail();
    } else if (document.getElementById('teamDetailView').style.display !== 'none') {
        window.goBack();
    } else if (window.currentView === 'matchPrepView') {
        window.switchView('scheduleView');
    }
});

window.setUIMode = function (mode) {
    localStorage.setItem('uiMode', mode);
    document.body.classList.toggle('mobile-ui', mode === 'mobile');
    document.body.classList.toggle('split-ui', mode === 'split');
    document.getElementById('desktopModeBtn')?.classList.toggle('active', mode === 'desktop');
    document.getElementById('mobileModeBtn')?.classList.toggle('active', mode === 'mobile');
    document.getElementById('splitModeBtn')?.classList.toggle('active', mode === 'split');
    displaySchedule();
};

function initUIMode() {
    const saved = localStorage.getItem('uiMode');
    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const mode = saved || (isMobile ? 'mobile' : 'desktop');
    window.setUIMode(mode);
}

window.setColorMode = function (mode) {
    localStorage.setItem('colorMode', mode);
    document.body.classList.toggle('light-mode', mode === 'light');
    document.getElementById('darkModeBtn')?.classList.toggle('active', mode === 'dark');
    document.getElementById('lightModeBtn')?.classList.toggle('active', mode === 'light');
};

window.toggleConfigPanel = function () {
    document.getElementById('config-panel')?.classList.toggle('open');
};

document.addEventListener('click', e => {
    const panel = document.getElementById('config-panel');
    const btn   = document.getElementById('configBtn');
    if (panel?.classList.contains('open') && !panel.contains(e.target) && !btn?.contains(e.target)) {
        panel.classList.remove('open');
    }
});

window.rerollQuip = function () {
    const container = document.getElementById('detailTeamQuip');
    const textEl = document.getElementById('detailTeamQuipText');
    if (!container || !container.dataset.tier || !textEl) return;
    // Re-roll always uses random tier-based quip, bypassing any event-specific quip
    textEl.textContent = getTeamQuip(Number(container.dataset.team), container.dataset.tier, true);
    container.dataset.hasEventQuip = 'false';
};

window.toggleQuipsEnabled = function () {
    const nowEnabled = !(localStorage.getItem('quipsEnabled') === 'true');
    localStorage.setItem('quipsEnabled', String(nowEnabled));
    const el = document.getElementById('detailTeamQuip');
    if (el) el.style.display = nowEnabled ? '' : 'none';
    renderDevTab();
};

function getQuipUserSeed() {
    let seed = parseInt(localStorage.getItem('quipUserSeed'), 10);
    if (!seed || isNaN(seed)) {
        seed = Math.floor(Math.random() * 0xffffffff);
        localStorage.setItem('quipUserSeed', String(seed));
    }
    return seed;
}

function initColorMode() {
    const saved = localStorage.getItem('colorMode') || 'dark';
    window.setColorMode(saved);
}

window.switchView = function (viewId, btn) {
    // In split mode, showing the team detail uses pushCurrentRightPanel to save
    // whatever is open (including matchPrepView) — handle it first, before the
    // prep-close block below would interfere.
    if (document.body.classList.contains('split-ui') && viewId === 'teamDetailView') {
        pushCurrentRightPanel();
        window.previousView = window.currentView;
        document.getElementById('teamDetailView').style.display = 'flex';
        updateDetailBackButton();
        return;
    }

    // In split mode, close the prep panel when navigating to a main left-panel view.
    if (document.body.classList.contains('split-ui')) {
        const prep = document.getElementById('matchPrepView');
        if (prep && prep.style.display === 'block') {
            prep.style.display = 'none';
            if (!popRightPanel()) {
                document.getElementById('splitRightPanel').style.display = 'flex';
            }
        }
    }

    // 1. Hide the current view
    const current = document.getElementById(window.currentView);
    if (current) current.style.display = 'none';

    // 2. Store the current view as 'previous' before we swap
    if (window.currentView !== viewId) {
        window.previousView = window.currentView;
    }

    // 3. Show the new view
    const next = document.getElementById(viewId);
    if (next) {
        next.style.display = viewId === 'teamDetailView' ? 'flex' : 'block';
        window.currentView = viewId;
    }

    // 4. Sync all nav items (top-nav and mobile bottom nav) by data-view attribute
    const MAIN_VIEWS = new Set(['homeView', 'scheduleView', 'dataView', 'toolsView']);
    if (MAIN_VIEWS.has(viewId)) {
        document.querySelectorAll('[data-view]').forEach(b => {
            b.classList.toggle('active', b.dataset.view === viewId);
        });
    }

    // 5. Lazy-render tools tab when first opened
    if (viewId === 'toolsView' && currentToolsTab === 'picklist') renderPickList();
    if (viewId === 'toolsView' && currentToolsTab === 'draft') renderDraft();

    // 6. Update the Back button label on the Team Detail page
    updateDetailBackButton();
};

let currentDataTab = 'statbotics';
let dataChartVisible = true;

window.toggleDataChart = function () {
    dataChartVisible = !dataChartVisible;
    const display = dataChartVisible ? '' : 'none';
    const label   = dataChartVisible ? 'Hide Chart' : 'Show Chart';
    ['statboticsChartContainer', 'tbaChartContainer', 'scoutingChartContainer', 'dashboardChartContainer']
        .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = display; });
    ['dataChartToggleBtn', 'dashboardChartToggleBtn']
        .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = label; });
};

window.switchDataTab = function (tab) {
    currentDataTab = tab;
    ['statbotics', 'tba', 'scouting', 'algorithms'].forEach(t => {
        document.getElementById(`data-tab-${t}`).style.display = t === tab ? 'block' : 'none';
    });
    document.querySelectorAll('#dataTabs .detail-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['statbotics', 'tba', 'scouting', 'algorithms'][i] === tab);
    });
    if (tab === 'scouting') {
        displayScoutingTeams();   // immediate render from cache or raw scouting
        computeScoutingFusion();  // async — re-renders when fusion completes
    }
};

// ─── SCOUTING DATA TAB ────────────────────────────────────────────────────────

let scoutingChartInstance = null;
let scoutingSortCol = 'total';
let scoutingSortDir = 1;
let scoutingTableView   = 'epa';    // 'epa' | 'functional'
let scoutingTableFormat = 'tiered'; // 'tiered' | 'gradient'

window.sortScoutingBy = function (col) {
    if (scoutingSortCol === col) scoutingSortDir *= -1;
    else { scoutingSortCol = col; scoutingSortDir = col === 'teamNumber' ? -1 : 1; }
    displayScoutingTeams();
};

window.setScoutingTableView = function (view) {
    scoutingTableView = view;
    displayScoutingTeams();
};

window.setScoutingTableFormat = function (fmt) {
    scoutingTableFormat = fmt;
    displayScoutingTeams();
};

function renderScoutingChart(rows) {
    const ctx = document.getElementById('scoutingComparisonChart').getContext('2d');
    if (scoutingChartInstance) scoutingChartInstance.destroy();
    const isMobile = document.body.classList.contains('mobile-ui');
    const labels = rows.map(r => r.teamNumber);
    scoutingChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Auto',    data: rows.map(r => r.auto.toFixed(1)),    backgroundColor: '#f59e0b', stack: 'epa' },
                { label: 'Teleop',  data: rows.map(r => r.teleop.toFixed(1)),  backgroundColor: '#3b82f6', stack: 'epa' },
                { label: 'Endgame', data: rows.map(r => r.endgame.toFixed(1)), backgroundColor: '#10b981', stack: 'epa' },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { stacked: true, grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 } } },
                y: { stacked: true, beginAtZero: true, grid: { color: '#334155' }, ticks: { color: '#94a3b8' },
                     title: { display: true, text: 'Scouting EPA (pts/match)', color: '#94a3b8' } },
            },
            plugins: {
                legend: { position: 'top', labels: { color: '#f8fafc', usePointStyle: true } },
                tooltip: { mode: 'index', intersect: false },
            },
        },
    });
}

window.computeScoutingFusion = async function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) return;
    const statusEl = document.getElementById('scouting-fusion-status');

    const rawStr = localStorage.getItem(`scoutingData_${eventKey}`);
    if (!rawStr) { if (statusEl) statusEl.textContent = 'No scouting data to fuse.'; return; }

    if (statusEl) statusEl.textContent = 'Computing…';

    const tbaMatches = await db.matches.where('eventKey').equals(eventKey).toArray();
    if (!tbaMatches.some(m => m.redBreakdown)) {
        if (statusEl) statusEl.textContent = 'No TBA breakdowns — run "Sync TBA Matches" first.';
        return;
    }

    const processed = processScoutingData(eventKey, JSON.parse(rawStr), getScoutingColumnOverrides(eventKey));
    if (!processed) { if (statusEl) statusEl.textContent = 'No game config for this event.'; return; }

    const { config, byTeam, observations } = processed;
    const allByMatch = indexObservationsByMatch(observations);
    const teams = {};

    for (const [teamNumber, rawRows] of Object.entries(byTeam)) {
        const { rows } = deduplicateTeamRows(rawRows);
        teams[teamNumber] = fuseScoutingWithTBA(teamNumber, rows, allByMatch, tbaMatches, config);
    }

    const fusedCount = Object.values(teams).filter(r => r.available).length;
    const now = new Date().toLocaleTimeString();
    localStorage.setItem(`scoutingFusedStats_${eventKey}`, JSON.stringify({ computed: now, teams }));
    if (statusEl) statusEl.textContent = `${fusedCount}/${Object.keys(teams).length} teams fused · ${now}`;
    displayScoutingTeams();
};

window.displayScoutingTeams = async function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    const table = document.getElementById('scoutingTeamTable');
    const body  = document.getElementById('scoutingTeamBody');
    if (!table || !body) return;

    const rawStr = localStorage.getItem(`scoutingData_${eventKey}`);
    if (!rawStr) { table.style.display = 'none'; return; }

    const processed = processScoutingData(eventKey, JSON.parse(rawStr), getScoutingColumnOverrides(eventKey));
    if (!processed || !processed.config.computeEPABreakdown) { table.style.display = 'none'; return; }

    const { config, byTeam } = processed;

    // Load cached fusion results if available
    const fusedCache = (() => {
        try { return JSON.parse(localStorage.getItem(`scoutingFusedStats_${eventKey}`)); } catch { return null; }
    })();

    const statusEl = document.getElementById('scouting-fusion-status');
    if (fusedCache && statusEl && !statusEl.textContent.includes('fused')) {
        const fusedCount = Object.values(fusedCache.teams).filter(r => r.available).length;
        statusEl.textContent = `${fusedCount}/${Object.keys(byTeam).length} teams fused · ${fusedCache.computed}`;
    }

    // When fusion data is present, filter to teams that appear in TBA match alliances.
    // Typo'd team numbers won't appear in any alliance and are excluded.
    let knownTeams = null;
    if (fusedCache) {
        const tbaMatches = await db.matches.where('eventKey').equals(eventKey).toArray();
        if (tbaMatches.length > 0) {
            knownTeams = new Set();
            for (const m of tbaMatches) {
                for (const t of [...(m.red || []), ...(m.blue || [])]) knownTeams.add(t);
            }
        }
    }

    // Load TBA team records so we can respect per-team scouting exclusions
    const allTBATeamsForScout = await db.tbaTeams.toArray();
    const tbaTeamMapForScout  = Object.fromEntries(allTBATeamsForScout.map(t => [String(t.teamNumber), t]));
    const allMatchesForScout  = await db.matches.toArray();

    // Build rows: use fused EPA breakdown when available, raw scouting otherwise
    let rows = Object.entries(byTeam)
        .filter(([teamNumber]) => !knownTeams || knownTeams.has(teamNumber))
        .map(([teamNumber, rawRows]) => {
        const tbaEntry = tbaTeamMapForScout[teamNumber];
        const scoutIgnoreKeys = tbaEntry?.scoutingIgnoreActive ? getTeamIgnoredKeys(tbaEntry) : [];
        let { rows: deduped } = deduplicateTeamRows(rawRows);
        let ignoredMatchNums = new Set();
        if (scoutIgnoreKeys.length > 0) {
            ignoredMatchNums = new Set(allMatchesForScout.filter(m => scoutIgnoreKeys.includes(m.key)).map(m => m.matchNumber));
            deduped = deduped.filter(r => !ignoredMatchNums.has(r.matchNumber));
        }
        const rawStats = config.aggregateTeam(deduped);
        const fusedResult = fusedCache?.teams?.[teamNumber];
        const effectiveFused = (fusedResult?.available && ignoredMatchNums.size > 0)
            ? refilteredFusedStats(fusedResult, ignoredMatchNums) : fusedResult;
        const isFused = effectiveFused?.available && config.computeFusedEPABreakdown;
        const breakdown = isFused
            ? config.computeFusedEPABreakdown(effectiveFused.stats)
            : config.computeEPABreakdown(rawStats);
        const funcVals = {};
        if (config.functionalColumns) {
            for (const col of config.functionalColumns) {
                funcVals[col.sortKey] = col.getValue(rawStats, effectiveFused) ?? null;
            }
        }
        return { teamNumber, matches: rawStats.matches, isFused, ...breakdown, ...funcVals };
    });

    // Sort
    rows.sort((a, b) => {
        const va = scoutingSortCol === 'teamNumber' ? parseInt(a.teamNumber) : (a[scoutingSortCol] ?? 0);
        const vb = scoutingSortCol === 'teamNumber' ? parseInt(b.teamNumber) : (b[scoutingSortCol] ?? 0);
        return (vb - va) * scoutingSortDir;
    });

    // Tier by scout EPA rank
    const sorted = [...rows].sort((a, b) => b.total - a.total);
    const tierOf = (tn) => {
        const i = sorted.findIndex(r => r.teamNumber === tn);
        return i < 8 ? 'S' : i < 20 ? 'A' : i < 32 ? 'B' : 'C';
    };

    renderScoutingChart([...rows].sort((a, b) => b.total - a.total));
    table.style.display = 'table';

    // Inject view + format toggles
    const toggleEl = document.getElementById('scouting-table-toggle');
    if (toggleEl) {
        const isEpa  = scoutingTableView === 'epa';
        const isTier = scoutingTableFormat === 'tiered';
        const btn = (label, onclick, active, activeColor = '#f8fafc') =>
            `<button onclick="${onclick}" style="border:none;padding:4px 12px;font-size:0.72em;cursor:pointer;font-weight:600;${active?`background:#1e293b;color:${activeColor}`:'background:transparent;color:#64748b'}">${label}</button>`;
        const viewPart = config.functionalColumns
            ? `<div style="display:inline-flex;gap:0;border:1px solid #334155;border-radius:5px;overflow:hidden;">
                   ${btn('EPA Breakdown', "window.setScoutingTableView('epa')",        isEpa,  '#f8fafc')}
                   ${btn('Functional',    "window.setScoutingTableView('functional')", !isEpa, '#60a5fa')}
               </div>`
            : '';
        const fmtPart = `<div style="display:inline-flex;gap:0;border:1px solid #334155;border-radius:5px;overflow:hidden;">
                   ${btn('Tiered',   "window.setScoutingTableFormat('tiered')",   isTier,  '#f8fafc')}
                   ${btn('Gradient', "window.setScoutingTableFormat('gradient')", !isTier, '#a78bfa')}
               </div>`;
        toggleEl.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">${viewPart}${fmtPart}</div>`;
    }

    // Update column headers to match view
    const theadRow = document.querySelector('#scoutingTeamTable thead tr');
    if (theadRow) {
        if (scoutingTableView === 'functional' && config.functionalColumns) {
            theadRow.innerHTML =
                `<th></th><th onclick="sortScoutingBy('teamNumber')" style="cursor:pointer;">Team ↕</th>` +
                config.functionalColumns.map(c =>
                    `<th onclick="sortScoutingBy('${c.sortKey}')" style="cursor:pointer;">${c.label} ↕</th>`
                ).join('') +
                `<th onclick="sortScoutingBy('matches')" style="cursor:pointer;">Matches ↕</th>`;
        } else {
            theadRow.innerHTML =
                `<th></th><th onclick="sortScoutingBy('teamNumber')" style="cursor:pointer;">Team ↕</th>` +
                `<th onclick="sortScoutingBy('total')" style="cursor:pointer;">Scout EPA ↕</th>` +
                `<th onclick="sortScoutingBy('auto')" style="cursor:pointer;">Auto ↕</th>` +
                `<th onclick="sortScoutingBy('teleop')" style="cursor:pointer;">Teleop ↕</th>` +
                `<th onclick="sortScoutingBy('endgame')" style="cursor:pointer;">Endgame ↕</th>` +
                `<th onclick="sortScoutingBy('matches')" style="cursor:pointer;">Matches ↕</th>`;
        }
    }

    const isFuncView  = scoutingTableView === 'functional' && config.functionalColumns;
    const isGradient  = scoutingTableFormat === 'gradient';

    // Per-column min/max for gradient shading
    const gradCols = isFuncView
        ? config.functionalColumns.map(c => c.sortKey)
        : ['total', 'auto', 'teleop', 'endgame'];
    const colMin = {}, colMax = {};
    if (isGradient) {
        for (const col of gradCols) {
            const vals = rows.map(r => r[col]).filter(v => v != null && isFinite(v));
            colMin[col] = vals.length > 0 ? Math.min(...vals) : 0;
            colMax[col] = vals.length > 0 ? Math.max(...vals) : 1;
        }
    }
    // Returns a CSS background declaration for a cell given its value and column key.
    // Interpolates hue green(142)→amber(42)→red(0) as value goes from best to worst.
    const gradBg = (val, col) => {
        if (!isGradient || val == null) return '';
        const range = colMax[col] - colMin[col];
        const t = range > 0 ? 1 - (val - colMin[col]) / range : 0.5;
        // RGB interpolation avoids hue-space paths that pass through unwanted colors.
        // Anchors: green rgb(35,67,47) → bg rgb(15,23,42) → red rgb(67,35,35)
        const p = t < 0.5 ? t * 2 : (t - 0.5) * 2;
        const r = t < 0.5 ? Math.round(35 - 20 * p) : Math.round(15 + 52 * p);
        const g = t < 0.5 ? Math.round(67 - 44 * p) : Math.round(23 + 12 * p);
        const b = t < 0.5 ? Math.round(47 -  5 * p) : Math.round(42 -  7 * p);
        return `background:rgb(${r},${g},${b});`;
    };

    body.innerHTML = rows.map(r => {
        const tier = tierOf(r.teamNumber);
        const rowStyle = isGradient
            ? `background:#0f172a;border-left:3px solid #334155;cursor:pointer;`
            : `background:${TIER_STYLE[tier].bg};border-left:6px solid ${TIER_STYLE[tier].color};cursor:pointer;`;
        const tierCell = isGradient
            ? `<td style="color:#475569;font-size:0.75em;font-weight:700;padding:4px 6px;">${tier}</td>`
            : `<td>${tierBadge(tier)}</td>`;

        if (isFuncView) {
            return `<tr style="${rowStyle}" onclick="viewTeamDetail(${r.teamNumber}, 'scouting')">
                ${tierCell}
                <td style="white-space:nowrap;"><strong>${r.teamNumber}</strong>${ownStar(r.teamNumber)}</td>
                ${config.functionalColumns.map(c => {
                    const val = r[c.sortKey];
                    const display = val == null ? '—'
                        : c.suffix === '%' ? Math.round(val) + '%'
                        : c.decimals != null ? val.toFixed(c.decimals)
                        : String(Math.round(val));
                    return `<td style="${gradBg(val, c.sortKey)}">${display}</td>`;
                }).join('')}
                <td style="color:#64748b;">${r.matches}</td>
            </tr>`;
        }
        const fusedDot = r.isFused
            ? `<span title="TBA-fused" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#4ade80;margin-left:5px;vertical-align:middle;"></span>`
            : '';
        return `<tr style="${rowStyle}" onclick="viewTeamDetail(${r.teamNumber}, 'scouting')">
            ${tierCell}
            <td style="white-space:nowrap;"><strong>${r.teamNumber}</strong>${ownStar(r.teamNumber)}</td>
            <td style="${gradBg(r.total,'total')}white-space:nowrap;"><strong>${r.total.toFixed(1)}</strong>${fusedDot}</td>
            <td style="${gradBg(r.auto,'auto')}color:#f59e0b;">${r.auto.toFixed(1)}</td>
            <td style="${gradBg(r.teleop,'teleop')}color:#3b82f6;">${r.teleop.toFixed(1)}</td>
            <td style="${gradBg(r.endgame,'endgame')}color:#10b981;">${r.endgame.toFixed(1)}</td>
            <td style="color:#64748b;">${r.matches}</td>
        </tr>`;
    }).join('');
};

// ─── SCOUTING SUB-TABS ──────────────────────────────────────────────────────

let currentScoutingSubTab = 'teams';
window.switchScoutingSubTab = function (tab) {
    currentScoutingSubTab = tab;
    ['teams', 'curation'].forEach(t => {
        document.getElementById(`scouting-subtab-${t}`).style.display = t === tab ? 'block' : 'none';
    });
    document.querySelectorAll('#scoutingSubTabs .detail-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['teams', 'curation'][i] === tab);
    });
    if (tab === 'curation') renderCurationTab();
};

async function renderCurationTab() {
    const container = document.getElementById('scouting-curation-content');
    if (!container) return;

    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    const rawStr    = localStorage.getItem(`scoutingData_${eventKey}`);
    const pitRawStr = localStorage.getItem(`pitData_${eventKey}`);
    if (!rawStr && !pitRawStr) {
        container.innerHTML = '<p style="color:#64748b;font-style:italic;margin-top:20px;">No scouting data loaded.</p>';
        return;
    }

    container.innerHTML = '<p style="color:#64748b;font-style:italic;margin-top:20px;">Computing…</p>';

    let config = null, byTeam = {}, observations = [];
    let dedupedByTeam = {}, scoutIndex = {};
    let reportingMode = 'unknown', isCumulative = true;

    if (rawStr) {
        const processed = processScoutingData(eventKey, JSON.parse(rawStr), getScoutingColumnOverrides(eventKey));
        if (!processed) { container.innerHTML = '<p style="color:#64748b;font-style:italic;">No game config for this event.</p>'; return; }
        ({ config, byTeam, observations } = processed);
        for (const [tn, rows] of Object.entries(byTeam)) {
            dedupedByTeam[tn] = deduplicateTeamRows(rows).rows;
        }
        for (const [tn, rows] of Object.entries(dedupedByTeam)) {
            for (const r of rows) {
                if (!scoutIndex[r.matchNumber]) scoutIndex[r.matchNumber] = {};
                scoutIndex[r.matchNumber][tn] = r;
            }
        }
    }

    const tbaMatches    = await db.matches.where('eventKey').equals(eventKey).toArray();
    const hasBreakdowns = tbaMatches.some(m => m.redBreakdown);

    if (rawStr && config) {
        reportingMode = hasBreakdowns
            ? detectCumulativeReportingMode(tbaMatches, config.teleopFuseStats ?? [])
            : 'unknown';
        isCumulative = reportingMode !== 'separate';
    }

    let html = '';
    if (!rawStr) {
        html += '<p style="color:#64748b;font-style:italic;font-size:0.85em;margin:0 0 16px;">No match scouting data loaded — showing pit scouting only.</p>';
    }

    // ── 1. MATCH COVERAGE ───────────────────────────────────────────────────
    const allMatchNums = tbaMatches.map(m => m.matchNumber).sort((a, b) => a - b);
    const matchCoverage = allMatchNums.map(mn => {
        const m = tbaMatches.find(x => x.matchNumber === mn);
        const sc = scoutIndex[mn] || {};
        const redScouted  = (m?.red  || []).filter(t => sc[t]).length;
        const blueScouted = (m?.blue || []).filter(t => sc[t]).length;
        return { mn, m, sc, redScouted, blueScouted,
            redTotal: (m?.red || []).length, blueTotal: (m?.blue || []).length };
    });

    const fullyUnscouted = matchCoverage.filter(c => c.redScouted === 0 && c.blueScouted === 0);
    const partial        = matchCoverage.filter(c => (c.redScouted > 0 || c.blueScouted > 0) &&
                                                      (c.redScouted < c.redTotal || c.blueScouted < c.blueTotal));
    const fullyCovered   = matchCoverage.filter(c => c.redScouted === c.redTotal && c.blueScouted === c.blueTotal);

    const summaryStyle = (color) => `cursor:pointer;list-style:none;display:flex;align-items:center;gap:0;margin-bottom:0;padding:6px 0;`;
    const hdrStyle = (color) => `font-size:0.7em;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;border-left:3px solid ${color};padding-left:10px;color:#94a3b8;flex:1;`;
    const chevron = `<span class="curation-chevron" style="color:#475569;font-size:0.9em;margin-left:8px;transition:transform 0.15s;">▼</span>`;

    if (rawStr) html += `
    <details style="margin-bottom:20px;">
        <summary style="${summaryStyle('#64748b')}">
            <span style="${hdrStyle('#64748b')}">Match Coverage</span>
            <span style="font-size:0.75em;color:#64748b;margin-right:8px;"><span style="color:#4ade80;">${fullyCovered.length}</span> full · <span style="color:#f59e0b;">${partial.length}</span> partial · <span style="color:#ef4444;">${fullyUnscouted.length}</span> unscouted</span>
            ${chevron}
        </summary>
        <div style="margin-top:12px;">
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;">
            <div style="background:#0f2010;border:1px solid #166534;border-radius:6px;padding:10px 16px;text-align:center;">
                <div style="color:#4ade80;font-size:1.4em;font-weight:700;">${fullyCovered.length}</div>
                <div style="color:#64748b;font-size:0.72em;">Fully scouted</div>
            </div>
            <div style="background:#1a1500;border:1px solid #854d0e;border-radius:6px;padding:10px 16px;text-align:center;">
                <div style="color:#f59e0b;font-size:1.4em;font-weight:700;">${partial.length}</div>
                <div style="color:#64748b;font-size:0.72em;">Partially scouted</div>
            </div>
            <div style="background:#1a0a0a;border:1px solid #7f1d1d;border-radius:6px;padding:10px 16px;text-align:center;">
                <div style="color:#ef4444;font-size:1.4em;font-weight:700;">${fullyUnscouted.length}</div>
                <div style="color:#64748b;font-size:0.72em;">Unscouted</div>
            </div>
        </div>
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.78em;">
            <thead><tr style="color:#64748b;border-bottom:1px solid #334155;">
                <th style="text-align:left;padding:4px 8px;">Match</th>
                <th style="text-align:center;padding:4px 8px;">Red scouted</th>
                <th style="text-align:center;padding:4px 8px;">Blue scouted</th>
                <th style="text-align:left;padding:4px 8px;">Missing teams</th>
            </tr></thead>
            <tbody>
            ${matchCoverage.map(({ mn, m, sc, redScouted, blueScouted, redTotal, blueTotal }) => {
                const full = redScouted === redTotal && blueScouted === blueTotal;
                const none = redScouted === 0 && blueScouted === 0;
                const missing = [...(m?.red || []).filter(t => !sc[t]), ...(m?.blue || []).filter(t => !sc[t])];
                return `<tr style="border-bottom:1px solid #1e293b;">
                    <td style="padding:4px 8px;color:#60a5fa;">QM ${mn}</td>
                    <td style="text-align:center;padding:4px 8px;color:${redScouted === redTotal ? '#4ade80' : '#f59e0b'};">${redScouted}/${redTotal}</td>
                    <td style="text-align:center;padding:4px 8px;color:${blueScouted === blueTotal ? '#4ade80' : '#f59e0b'};">${blueScouted}/${blueTotal}</td>
                    <td style="padding:4px 8px;color:#94a3b8;">${missing.length ? missing.join(', ') : '—'}</td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>
        </div>
        </div>
    </details>`;

    // ── 2. PIT SCOUTING COVERAGE ─────────────────────────────────────────────
    {
        // Build full team list: TBA match alliances → scouting byTeam → db.teams (synced team list)
        const eventTeams = new Set();
        for (const m of tbaMatches) {
            for (const t of [...(m.red || []), ...(m.blue || [])]) eventTeams.add(t);
        }
        if (!eventTeams.size) {
            for (const tn of Object.keys(byTeam)) eventTeams.add(tn);
        }
        if (!eventTeams.size) {
            const dbTeams = await db.teams.where('eventKey').equals(eventKey).toArray();
            for (const t of dbTeams) eventTeams.add(String(t.teamNumber));
        }

        if (!pitRawStr) {
            html += `
            <details style="margin-bottom:20px;">
                <summary style="${summaryStyle('#64748b')}">
                    <span style="${hdrStyle('#64748b')}">Pit Scouting Coverage</span>
                    <span style="font-size:0.75em;color:#475569;margin-right:8px;">No pit data loaded</span>
                    ${chevron}
                </summary>
                <div style="margin-top:12px;">
                    <p style="color:#475569;font-size:0.85em;font-style:italic;">Sync a pit scouting sheet from the Home tab to see coverage.</p>
                </div>
            </details>`;
        } else {
            const pitRows = JSON.parse(pitRawStr);

            // Find which event teams have a pit row (value-match heuristic)
            const pittedTeams = new Set();
            for (const row of pitRows) {
                for (const v of Object.values(row)) {
                    const trimmed = String(v).trim();
                    if (eventTeams.has(trimmed)) { pittedTeams.add(trimmed); break; }
                }
            }

            const sort = arr => [...arr].sort((a, b) => parseInt(a) - parseInt(b));
            const missing  = sort([...eventTeams].filter(t => !pittedTeams.has(t)));
            const scouted  = sort([...eventTeams].filter(t => pittedTeams.has(t)));

            const chip = (tn, color) =>
                `<span onclick="viewTeamDetail(${tn}, 'pit-data')" style="cursor:pointer;display:inline-block;padding:2px 8px;border-radius:12px;background:${color}22;border:1px solid ${color}55;color:${color};font-size:0.78em;font-weight:600;margin:2px;">${tn}</span>`;

            html += `
            <details style="margin-bottom:20px;">
                <summary style="${summaryStyle('#64748b')}">
                    <span style="${hdrStyle('#64748b')}">Pit Scouting Coverage</span>
                    <span style="font-size:0.75em;color:#64748b;margin-right:8px;"><span style="color:#4ade80;">${scouted.length}</span> scouted · <span style="color:#ef4444;">${missing.length}</span> missing</span>
                    ${chevron}
                </summary>
                <div style="margin-top:12px;">
                    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;">
                        <div style="background:#0f2010;border:1px solid #166534;border-radius:6px;padding:10px 16px;text-align:center;">
                            <div style="color:#4ade80;font-size:1.4em;font-weight:700;">${scouted.length}</div>
                            <div style="color:#64748b;font-size:0.72em;">Pit scouted</div>
                        </div>
                        <div style="background:#1a0a0a;border:1px solid #7f1d1d;border-radius:6px;padding:10px 16px;text-align:center;">
                            <div style="color:#ef4444;font-size:1.4em;font-weight:700;">${missing.length}</div>
                            <div style="color:#64748b;font-size:0.72em;">Not scouted</div>
                        </div>
                        <div style="background:#0c1220;border:1px solid #1e3a5f;border-radius:6px;padding:10px 16px;text-align:center;">
                            <div style="color:#60a5fa;font-size:1.4em;font-weight:700;">${pitRows.length}</div>
                            <div style="color:#64748b;font-size:0.72em;">Pit entries total</div>
                        </div>
                    </div>
                    ${missing.length ? `
                    <div style="margin-bottom:12px;">
                        <div style="color:#ef4444;font-size:0.72em;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Not yet scouted</div>
                        <div>${missing.map(t => chip(t, '#ef4444')).join('')}</div>
                    </div>` : `<p style="color:#4ade80;font-size:0.85em;margin:0 0 12px;">All ${eventTeams.size} teams have been pit scouted.</p>`}
                    ${scouted.length ? `
                    <div>
                        <div style="color:#4ade80;font-size:0.72em;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Scouted</div>
                        <div>${scouted.map(t => chip(t, '#4ade80')).join('')}</div>
                    </div>` : ''}
                </div>
            </details>`;
        }
    }

    // ── 3. FOUL POINTS ──────────────────────────────────────────────────────
    if (hasBreakdowns) {
        const foulRows = [];
        for (const m of tbaMatches) {
            for (const [alliance, breakdown, oppBreakdown] of [
                ['red',  m.redBreakdown,  m.blueBreakdown],
                ['blue', m.blueBreakdown, m.redBreakdown],
            ]) {
                if (!breakdown || !oppBreakdown) continue;
                // foulPoints on the breakdown = pts awarded TO this alliance FROM opponent fouls
                const foulPts = breakdown.foulPoints ?? 0;
                foulRows.push({ mn: m.matchNumber, alliance, foulPts, teams: m[alliance] || [] });
            }
        }
        const avgFoul = foulRows.length ? foulRows.reduce((s, r) => s + r.foulPts, 0) / foulRows.length : 0;
        const perRobot = (avgFoul / 3).toFixed(1);

        html += `
        <details style="margin-bottom:20px;">
            <summary style="${summaryStyle('#a78bfa')}">
                <span style="${hdrStyle('#a78bfa')}">Foul Points Received</span>
                <span style="font-size:0.75em;color:#64748b;margin-right:8px;"><span style="color:#f8fafc;">${avgFoul.toFixed(1)}</span> pts/alliance · <span style="color:#f8fafc;">${perRobot}</span> pts/robot</span>
                ${chevron}
            </summary>
            <div style="margin-top:12px;">
            <p style="color:#94a3b8;font-size:0.82em;margin:0 0 10px;">Average <strong style="color:#f8fafc;">${avgFoul.toFixed(1)} pts/alliance/match</strong> received from opponent fouls — roughly <strong style="color:#f8fafc;">${perRobot} pts/robot/match</strong> not captured by scouting.</p>
            <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:0.78em;">
                <thead><tr style="color:#64748b;border-bottom:1px solid #334155;">
                    <th style="text-align:left;padding:4px 8px;">Match</th>
                    <th style="padding:4px 8px;">Alliance</th>
                    <th style="text-align:right;padding:4px 8px;">Foul pts received</th>
                    <th style="text-align:right;padding:4px 8px;">Per robot</th>
                </tr></thead>
                <tbody>
                ${foulRows.map(r => `
                    <tr style="border-bottom:1px solid #1e293b;">
                        <td style="padding:4px 8px;color:#60a5fa;">QM ${r.mn}</td>
                        <td style="padding:4px 8px;color:${r.alliance==='red'?'#f87171':'#60a5fa'};">${r.alliance}</td>
                        <td style="text-align:right;padding:4px 8px;color:${r.foulPts>10?'#f59e0b':'#94a3b8'};">${r.foulPts}</td>
                        <td style="text-align:right;padding:4px 8px;color:#64748b;">${(r.foulPts/3).toFixed(1)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
            </div>
            </div>
        </details>`;
    }

    // ── 4. OUTLIER MATCHES ──────────────────────────────────────────────────
    if (rawStr) {
        const fusedCache = (() => { try { return JSON.parse(localStorage.getItem(`scoutingFusedStats_${eventKey}`)); } catch { return null; } })();

        const getMatchEPA = (tn, row) => {
            const matchFused = fusedCache?.teams?.[tn]?.fusedByMatch?.[String(row.matchNumber)];
            if (matchFused && config.computeFusedEPABreakdown) {
                return config.computeFusedEPABreakdown(matchFused).total;
            }
            return config.computeMatchEPA ? config.computeMatchEPA(row) : 0;
        };

        const outliers = [];
        for (const [tn, rows] of Object.entries(dedupedByTeam)) {
            const played = rows.filter(r => !r.noShow);
            if (played.length < 2) continue;
            const epas = played.map(r => ({ r, epa: getMatchEPA(tn, r) }));
            const mean = epas.reduce((s, x) => s + x.epa, 0) / epas.length;
            const std  = Math.sqrt(epas.reduce((s, x) => s + (x.epa - mean) ** 2, 0) / epas.length);
            for (const { r, epa } of epas) {
                const z = std > 0 ? (epa - mean) / std : 0;
                if (Math.abs(z) >= 1.5) outliers.push({ tn, mn: r.matchNumber, epa, mean, z });
            }
        }
        outliers.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

        html += `
        <details style="margin-bottom:20px;">
            <summary style="${summaryStyle('#f59e0b')}">
                <span style="${hdrStyle('#f59e0b')}">Match Outliers <span style="color:#475569;font-weight:400;font-size:0.9em;">(≥1.5σ from team mean)</span></span>
                <span style="font-size:0.75em;color:#64748b;margin-right:8px;"><span style="color:${outliers.length>0?'#f59e0b':'#4ade80'};">${outliers.length}</span> found</span>
                ${chevron}
            </summary>
            <div style="margin-top:12px;">
            ${outliers.length === 0 ? '<p style="color:#64748b;font-style:italic;font-size:0.85em;">No significant outliers found.</p>' : `
            <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:0.78em;">
                <thead><tr style="color:#64748b;border-bottom:1px solid #334155;">
                    <th style="text-align:left;padding:4px 8px;">Team</th>
                    <th style="text-align:left;padding:4px 8px;">Match</th>
                    <th style="text-align:right;padding:4px 8px;">Match EPA</th>
                    <th style="text-align:right;padding:4px 8px;">Team avg</th>
                    <th style="text-align:right;padding:4px 8px;">Deviation</th>
                </tr></thead>
                <tbody>
                ${outliers.slice(0, 30).map(o => {
                    const dir = o.z > 0 ? '+' : '';
                    const c   = o.z > 0 ? '#4ade80' : '#ef4444';
                    return `<tr style="border-bottom:1px solid #1e293b;cursor:pointer;" onclick="viewTeamDetail(${o.tn}, 'scouting')">
                        <td style="padding:4px 8px;color:#f8fafc;font-weight:600;white-space:nowrap;">${o.tn}</td>
                        <td style="padding:4px 8px;color:#60a5fa;white-space:nowrap;">QM ${o.mn}</td>
                        <td style="text-align:right;padding:4px 8px;white-space:nowrap;">${o.epa.toFixed(1)}</td>
                        <td style="text-align:right;padding:4px 8px;color:#64748b;white-space:nowrap;">${o.mean.toFixed(1)}</td>
                        <td style="text-align:right;padding:4px 8px;white-space:nowrap;color:${c};">${dir}${o.z.toFixed(2)}σ</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
            </div>`}
            </div>
        </details>`;
    }

    // ── 5. EPA COMPARISON ───────────────────────────────────────────────────
    if (rawStr) {
        const statboticsTeams = await db.teams.toArray();
        const statByTeam = Object.fromEntries(statboticsTeams.map(t => [String(t.teamNumber), t]));
        const fusedCache = (() => { try { return JSON.parse(localStorage.getItem(`scoutingFusedStats_${eventKey}`)); } catch { return null; } })();
        const compRows = Object.entries(dedupedByTeam).map(([tn, rows]) => {
            const rawStats = config.aggregateTeam(rows);
            const fusedResult = fusedCache?.teams?.[tn];
            const breakdown = (fusedResult?.available && config.computeFusedEPABreakdown)
                ? config.computeFusedEPABreakdown(fusedResult.stats)
                : config.computeEPABreakdown(rawStats);
            const statTeam = statByTeam[tn];
            const statEPA = statTeam?.currentEPA ?? null;
            return { tn, scoutEPA: breakdown.total, statEPA, diff: statEPA != null ? breakdown.total - statEPA : null, matches: rawStats.matches, fused: !!fusedResult?.available };
        }).filter(r => r.statEPA != null).sort((a, b) => b.statEPA - a.statEPA);

        const avgGap = compRows.length ? (compRows.reduce((s,r) => s + r.diff, 0) / compRows.length) : 0;
        html += `
        <details style="margin-bottom:20px;">
            <summary style="${summaryStyle('#10b981')}">
                <span style="${hdrStyle('#10b981')}">EPA Comparison <span style="color:#475569;font-weight:400;font-size:0.9em;">(scouting vs Statbotics)</span></span>
                <span style="font-size:0.75em;color:#64748b;margin-right:8px;"><span style="color:${avgGap < -5 ? '#ef4444' : avgGap > 5 ? '#f59e0b' : '#4ade80'};">${avgGap>=0?'+':''}${avgGap.toFixed(1)}</span> avg gap · ${compRows.length} teams</span>
                ${chevron}
            </summary>
            <div style="margin-top:12px;">
            <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:0.78em;">
                <thead><tr style="color:#64748b;border-bottom:1px solid #334155;">
                    <th style="text-align:left;padding:4px 8px;">Team</th>
                    <th style="text-align:right;padding:4px 8px;">Scout EPA</th>
                    <th style="text-align:right;padding:4px 8px;">Statbotics EPA</th>
                    <th style="text-align:right;padding:4px 8px;">Gap</th>
                    <th style="text-align:right;padding:4px 8px;">Matches</th>
                </tr></thead>
                <tbody>
                ${compRows.map(r => {
                    const gapColor = r.diff > 5 ? '#f59e0b' : r.diff < -5 ? '#ef4444' : '#64748b';
                    const dot = r.fused ? `<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:#4ade80;margin-left:4px;vertical-align:middle;"></span>` : '';
                    return `<tr style="border-bottom:1px solid #1e293b;cursor:pointer;" onclick="viewTeamDetail(${r.tn}, 'scouting')">
                        <td style="padding:4px 8px;font-weight:600;">${r.tn}</td>
                        <td style="text-align:right;padding:4px 8px;">${r.scoutEPA.toFixed(1)}${dot}</td>
                        <td style="text-align:right;padding:4px 8px;color:#64748b;">${r.statEPA.toFixed(1)}</td>
                        <td style="text-align:right;padding:4px 8px;color:${gapColor};">${r.diff>=0?'+':''}${r.diff.toFixed(1)}</td>
                        <td style="text-align:right;padding:4px 8px;color:#475569;">${r.matches}</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
            </div>
            </div>
        </details>`;
    }

    // ── 6. UNKNOWN TEAM NUMBERS ──────────────────────────────────────────────
    if (rawStr) {
        const knownTeams = new Set();
        for (const m of tbaMatches) {
            for (const t of [...(m.red || []), ...(m.blue || [])]) knownTeams.add(t);
        }

        if (knownTeams.size > 0) {
            // Collect all distinct (teamNumber, matchNumber) pairs not in the event roster
            const unknownMap = {}; // teamNum → Set of matchNumbers
            for (const obs of observations) {
                const tn = String(obs.teamNumber);
                if (!tn || tn === '0') continue;
                if (!knownTeams.has(tn)) {
                    if (!unknownMap[tn]) unknownMap[tn] = new Set();
                    unknownMap[tn].add(obs.matchNumber);
                }
            }

            // Per-match index of scouted team numbers (for finding unscouted alliance partners)
            const matchScoutedTeams = {};
            for (const obs of observations) {
                const tn = String(obs.teamNumber);
                if (!tn || tn === '0') continue;
                if (!matchScoutedTeams[obs.matchNumber]) matchScoutedTeams[obs.matchNumber] = new Set();
                matchScoutedTeams[obs.matchNumber].add(tn);
            }
            const matchIndex = Object.fromEntries(tbaMatches.map(m => [m.matchNumber, m]));

            const unknownEntries = Object.entries(unknownMap)
                .sort(([a], [b]) => Number(a) - Number(b));

            html += `
            <details style="margin-bottom:20px;">
                <summary style="${summaryStyle('#f87171')}">
                    <span style="${hdrStyle('#f87171')}">Unknown Team Numbers <span style="color:#475569;font-weight:400;font-size:0.9em;">(not in TBA event roster)</span></span>
                    <span style="font-size:0.75em;color:#64748b;margin-right:8px;"><span style="color:${unknownEntries.length > 0 ? '#ef4444' : '#4ade80'};">${unknownEntries.length}</span> found</span>
                    ${chevron}
                </summary>
                <div style="margin-top:12px;">
                ${unknownEntries.length === 0
                    ? '<p style="color:#4ade80;font-size:0.85em;margin:0;">All scouted team numbers match the TBA event roster.</p>'
                    : `<p style="color:#94a3b8;font-size:0.82em;margin:0 0 10px;">These team numbers appear in scouting data but not in any TBA match alliance. Likely data entry errors — check the matches listed and correct the team number in the sheet.</p>
                    <div style="overflow-x:auto;">
                    <table style="width:100%;border-collapse:collapse;font-size:0.78em;">
                        <thead><tr style="color:#64748b;border-bottom:1px solid #334155;">
                            <th style="text-align:left;padding:4px 8px;">Scouted #</th>
                            <th style="text-align:right;padding:4px 8px;">Rows</th>
                            <th style="text-align:left;padding:4px 8px;">Matches</th>
                            <th style="text-align:left;padding:4px 8px;">Unscouted in those matches</th>
                        </tr></thead>
                        <tbody>
                        ${unknownEntries.map(([tn, mnSet]) => {
                            const sortedMns = [...mnSet].sort((a, b) => a - b);
                            const matches = sortedMns.map(mn => `QM ${mn}`).join(', ');

                            // Teams in those TBA matches that have no scouting row
                            const unscouted = new Set();
                            for (const mn of sortedMns) {
                                const tbaMatch = matchIndex[mn];
                                if (!tbaMatch) continue;
                                const scouted = matchScoutedTeams[mn] || new Set();
                                for (const t of [...(tbaMatch.red || []), ...(tbaMatch.blue || [])]) {
                                    if (!scouted.has(t)) unscouted.add(t);
                                }
                            }
                            const unscoutedStr = unscouted.size > 0
                                ? [...unscouted].sort((a, b) => Number(a) - Number(b)).join(', ')
                                : '<span style="color:#475569;">—</span>';

                            return `<tr style="border-bottom:1px solid #1e293b;">
                                <td style="padding:4px 8px;color:#f87171;font-weight:600;">${tn}</td>
                                <td style="text-align:right;padding:4px 8px;color:#94a3b8;">${mnSet.size}</td>
                                <td style="padding:4px 8px;color:#94a3b8;">${matches}</td>
                                <td style="padding:4px 8px;color:#fbbf24;font-weight:600;">${unscoutedStr}</td>
                            </tr>`;
                        }).join('')}
                        </tbody>
                    </table>
                    </div>`}
                </div>
            </details>`;
        }
    }

    // ── 7. Game-specific curation section ────────────────────────────────────
    if (config?.curationSection) {
        html += config.curationSection(tbaMatches, matchCoverage, scoutIndex, isCumulative, reportingMode, { summaryStyle, hdrStyle, chevron });
    }

    container.innerHTML = html;
}

// ─── TOOLS TAB ──────────────────────────────────────────────────────────────

let currentToolsTab = 'picklist';
let pickListSortCol = 'composite';
let pickListSortDir = 1; // 1 = descending (default for all columns)

window.sortPickListBy = function (col) {
    if (pickListSortCol === col) {
        pickListSortDir *= -1;
    } else {
        pickListSortCol = col;
        pickListSortDir = 1;
    }
    renderPickList();
};

window.switchToolsTab = function (tab) {
    currentToolsTab = tab;
    const allTabs = ['field', 'picklist', 'draft', 'alliances', 'dev'];
    allTabs.forEach(t => {
        document.getElementById(`tools-tab-${t}`).style.display = t === tab ? 'block' : 'none';
    });
    document.querySelectorAll('#toolsTabs .detail-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', allTabs[i] === tab);
    });
    if (tab === 'picklist') renderPickList();
    if (tab === 'draft') renderDraft();
    if (tab === 'field') initFieldTab();
    if (tab === 'alliances') renderAlliancesTab();
    if (tab === 'dev') renderDevTab();
};

// ── Field Drawing Tab ────────────────────────────────────────────────────────
// Strokes: { pts: [{x,y}…] normalized to IMAGE rect (0–1), color }
//
// Key design: _fPt() reads img.getBoundingClientRect() live on every touch/mouse
// event. The canvas fills the wrapper via CSS (inset:0 100%/100%) and its buffer
// is sized to the image rendered dimensions. Coordinate mapping is always fresh —
// no timing-sensitive JS positioning that can fail mid-fullscreen-transition.

let fieldStrokes       = [];
let fieldDrawing       = false;
let fieldCurrentStroke = [];
let fieldCanvas        = null;
let fieldCtx           = null;
let fieldActiveYear    = null;
let fieldDrawMode      = false;
let fieldColor         = '#f8fafc'; // white default

// Match prep radar palette (R1-R3 red shades, B1-B3 blue shades) + white
const _FC = [
    { id:'fcR1', color:'#ef4444', label:'R1' },
    { id:'fcR2', color:'#f87171', label:'R2' },
    { id:'fcR3', color:'#fca5a5', label:'R3' },
    { id:'fcB1', color:'#3b82f6', label:'B1' },
    { id:'fcB2', color:'#60a5fa', label:'B2' },
    { id:'fcB3', color:'#93c5fd', label:'B3' },
    { id:'fcW',  color:'#f8fafc', label:'W'  },
];

function initFieldTab() {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase() || '';
    const year = eventKey.match(/^(\d{4})/)?.[1] || '2026';
    const container = document.getElementById('tools-tab-field');

    if (year !== fieldActiveYear) {
        fieldStrokes = [];
        fieldActiveYear = year;
    }

    const bs = `background:#1e293b;border:1px solid #334155;padding:6px 12px;border-radius:5px;cursor:pointer;font-size:0.82em;font-weight:600;color:`;
    const colorDots = _FC.map(c =>
        `<button id="${c.id}" onclick="fieldSetColor('${c.color}')" title="${c.label}"
            style="width:22px;height:22px;border-radius:4px;background:${c.color};border:2px solid ${c.color===fieldColor?'#fff':'transparent'};cursor:pointer;padding:0;flex-shrink:0;"></button>`
    ).join('');

    container.innerHTML = `
        <div id="fieldWrapper" style="border-radius:8px;overflow:hidden;">
            <div id="fieldToolbar" style="display:flex;gap:8px;align-items:center;padding:10px;flex-wrap:wrap;background:#0f172a;">
                <button id="fieldDrawToggle" onclick="fieldToggleDraw()" style="${bs}#94a3b8;">Draw</button>
                <button onclick="fieldUndo()"       style="${bs}#f8fafc;">Undo</button>
                <button onclick="fieldErase()"      style="${bs}#ef4444;">Erase All</button>
                <button onclick="fieldFullscreen()" style="${bs}#94a3b8;">⛶ Fullscreen</button>
                <div style="display:flex;gap:4px;align-items:center;margin-left:4px;">
                    <span style="color:#475569;font-size:0.72em;white-space:nowrap;">Color:</span>
                    ${colorDots}
                </div>
            </div>
            <div id="fieldImageWrap" style="position:relative;width:100%;max-width:960px;line-height:0;">
                <img id="fieldBgImg" src="${import.meta.env.BASE_URL}field/${year}-field.png"
                    style="display:block;width:100%;user-select:none;pointer-events:none;" draggable="false">
                <canvas id="fieldDrawCanvas"
                    style="position:absolute;inset:0;width:100%;height:100%;touch-action:none;"></canvas>
            </div>
        </div>`;

    fieldCanvas = document.getElementById('fieldDrawCanvas');
    fieldCtx    = fieldCanvas.getContext('2d');
    fieldDrawing = false;
    fieldCurrentStroke = [];
    _fUpdateToggle();

    const img = document.getElementById('fieldBgImg');
    const doSize = () => _fSizeCanvas(img);
    if (img.complete && img.naturalWidth) doSize();
    else img.addEventListener('load', doSize);

    // Bind to the wrapper so touch hits regardless of canvas buffer state.
    // touchstart/touchmove need passive:false to call preventDefault (blocks scroll).
    const wrap = document.getElementById('fieldImageWrap');
    wrap.addEventListener('mousedown',   _fDown);
    wrap.addEventListener('mousemove',   _fMove);
    wrap.addEventListener('mouseup',     _fUp);
    wrap.addEventListener('mouseleave',  _fUp);
    wrap.addEventListener('touchstart',  _fTouchStart, { passive: false });
    wrap.addEventListener('touchmove',   _fTouchMove,  { passive: false });
    wrap.addEventListener('touchend',    _fUp);
    wrap.addEventListener('touchcancel', _fUp);
}

// Resize the canvas drawing buffer to match the image's rendered dimensions.
// The canvas CSS (inset:0 / 100%×100%) already fills the wrapper — only the
// buffer needs updating so stroke line-width stays proportional.
function _fSizeCanvas(img) {
    img = img || document.getElementById('fieldBgImg');
    if (!fieldCanvas || !img) return;
    const r = img.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    fieldCanvas.width  = Math.round(r.width);
    fieldCanvas.height = Math.round(r.height);
    fieldRedraw();
}

// Resize after fullscreen transitions — retry a few times for Android layout settling.
document.addEventListener('fullscreenchange', () => {
    if (!fieldCanvas) return;
    [60, 200, 450].forEach(ms => setTimeout(() => _fSizeCanvas(), ms));
});

function _fUpdateToggle() {
    const btn = document.getElementById('fieldDrawToggle');
    if (!btn) return;
    if (fieldDrawMode) {
        btn.textContent = 'Drawing';
        btn.style.background  = '#166534';
        btn.style.color       = '#4ade80';
        btn.style.borderColor = '#166534';
    } else {
        btn.textContent = 'Draw';
        btn.style.background  = '#1e293b';
        btn.style.color       = '#94a3b8';
        btn.style.borderColor = '#334155';
    }
}

window.fieldToggleDraw = () => { fieldDrawMode = !fieldDrawMode; _fUpdateToggle(); };

window.fieldSetColor = (color) => {
    fieldColor = color;
    _FC.forEach(({ id, color: c }) => {
        const btn = document.getElementById(id);
        if (btn) btn.style.borderColor = c === color ? '#fff' : 'transparent';
    });
};

window.fieldFullscreen = () => {
    const el = document.getElementById('fieldWrapper');
    if (!el) return;

    if (document.fullscreenElement) { document.exitFullscreen(); return; }

    const isFaux = el.classList.contains('field-faux-fs');
    if (isFaux) {
        el.classList.remove('field-faux-fs');
        document.body.style.overflow = '';
        [60, 200].forEach(ms => setTimeout(() => _fSizeCanvas(), ms));
        return;
    }

    // iOS Safari does not support requestFullscreen on arbitrary elements —
    // use a CSS fixed-overlay as a universal fallback.
    const tryFaux = () => {
        el.classList.add('field-faux-fs');
        document.body.style.overflow = 'hidden';
        [60, 200, 450].forEach(ms => setTimeout(() => _fSizeCanvas(), ms));
    };
    if (el.requestFullscreen) el.requestFullscreen().catch(tryFaux);
    else tryFaux();
};

// _fPt reads the IMAGE's live bounding rect for coordinates, not the canvas.
// This is the key fix: accurate at call time regardless of canvas CSS state or
// any fullscreen transition timing.
function _fPt(e) {
    const img = document.getElementById('fieldBgImg');
    const r = img ? img.getBoundingClientRect() : fieldCanvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function _fDown(e)       { if (!fieldDrawMode) return; fieldDrawing = true; fieldCurrentStroke = [_fPt(e)]; }
function _fMove(e)       { if (!fieldDrawing) return; fieldCurrentStroke.push(_fPt(e)); _fDrawLive(); }
function _fUp()          { if (!fieldDrawing) return; fieldDrawing = false; if (fieldCurrentStroke.length) { fieldStrokes.push({ pts: [...fieldCurrentStroke], color: fieldColor }); fieldCurrentStroke = []; fieldRedraw(); } }
function _fTouchStart(e) { e.preventDefault(); if (!fieldDrawMode) return; fieldDrawing = true; fieldCurrentStroke = [_fPt(e.touches[0])]; }
function _fTouchMove(e)  { e.preventDefault(); if (!fieldDrawing) return; fieldCurrentStroke.push(_fPt(e.touches[0])); _fDrawLive(); }

function _fStroke(ctx, stroke) {
    const { pts, color } = stroke;
    const W = fieldCanvas.width, H = fieldCanvas.height;
    if (!pts.length) return;
    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.beginPath();
    if (pts.length === 1) { ctx.arc(pts[0].x * W, pts[0].y * H, 2, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.moveTo(pts[0].x * W, pts[0].y * H);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * W, pts[i].y * H);
    ctx.stroke();
}

function fieldRedraw() {
    if (!fieldCtx) return;
    fieldCtx.clearRect(0, 0, fieldCanvas.width, fieldCanvas.height);
    fieldCtx.lineWidth = 3;
    fieldCtx.lineCap   = 'round';
    fieldCtx.lineJoin  = 'round';
    for (const s of fieldStrokes) _fStroke(fieldCtx, s);
}

function _fDrawLive() {
    fieldRedraw();
    const W = fieldCanvas.width, H = fieldCanvas.height;
    if (fieldCurrentStroke.length < 2) return;
    fieldCtx.strokeStyle = fieldColor;
    fieldCtx.lineWidth   = 3;
    fieldCtx.lineCap     = 'round';
    fieldCtx.lineJoin    = 'round';
    fieldCtx.beginPath();
    fieldCtx.moveTo(fieldCurrentStroke[0].x * W, fieldCurrentStroke[0].y * H);
    for (let i = 1; i < fieldCurrentStroke.length; i++)
        fieldCtx.lineTo(fieldCurrentStroke[i].x * W, fieldCurrentStroke[i].y * H);
    fieldCtx.stroke();
}

window.fieldUndo  = () => { fieldStrokes.pop(); fieldRedraw(); };
window.fieldErase = () => { fieldStrokes = []; fieldDrawing = false; fieldCurrentStroke = []; fieldRedraw(); };

// ── Pick List ────────────────────────────────────────────────────────────────

function loadPickOrder() {
    try { return JSON.parse(localStorage.getItem('pickListOrder')) || []; }
    catch { return []; }
}

function savePickOrder() {
    const order = [...document.querySelectorAll('#pickListBody tr')]
        .map(r => r.dataset.separator ? '---separator---' : (r.dataset.team || null))
        .filter(x => x !== null);
    localStorage.setItem('pickListOrder', JSON.stringify(order));
}

function refreshPickPositions() {
    let pos = 1;
    document.querySelectorAll('#pickListBody tr').forEach(row => {
        if (row.dataset.separator) return;
        const el = row.querySelector('.pick-pos');
        if (el) el.textContent = pos++;
    });
}

window.resetPickList = async function () {
    localStorage.removeItem('pickListOrder');
    await renderPickList();
};

window.exportPickList = function () {
    const order = loadPickOrder();
    if (!order.length) { alert('No pick list to export.'); return; }
    const text = order.map(t => t === '---separator---' ? '---' : t).join('\n');
    navigator.clipboard.writeText(text)
        .then(() => alert('Pick list copied to clipboard.'))
        .catch(() => alert('Copy failed — check clipboard permissions.'));
};

window.showImportPickList = function () {
    const modal = document.getElementById('pickImportModal');
    if (!modal) return;
    document.getElementById('pickImportText').value = '';
    modal.style.display = 'flex';
};

window.closeImportPickList = function () {
    const modal = document.getElementById('pickImportModal');
    if (modal) modal.style.display = 'none';
};

window.confirmImportPickList = async function () {
    const text = document.getElementById('pickImportText').value.trim();
    if (!text) return;
    const order = text.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l)
        .map(l => l === '---' ? '---separator---' : l);
    const teams = order.filter(t => t !== '---separator---');
    if (!teams.length) { alert('No team numbers found.'); return; }
    localStorage.setItem('pickListOrder', JSON.stringify(order));
    window.closeImportPickList();
    await renderPickList();
};

window.dnpTeam = function (teamNumber) {
    const tbody = document.getElementById('pickListBody');
    if (!tbody) return;
    const row = tbody.querySelector(`tr[data-team="${teamNumber}"]`);
    if (!row) return;
    tbody.appendChild(row);       // move to bottom of list
    refreshPickPositions();
    savePickOrder();
};

async function renderPickList() {
    const table = document.getElementById('pickListTable');
    const tbody = document.getElementById('pickListBody');
    const statusEl = document.getElementById('pickListStatus');
    if (!table || !tbody) return;

    const [allTeams, allTBATeams, allMatches] = await Promise.all([
        db.teams.toArray(), db.tbaTeams.toArray(), db.matches.toArray()
    ]);

    if (!allTeams.length) {
        if (statusEl) statusEl.textContent = 'No team data — sync team list/history or Statbotics Live first.';
        table.style.display = 'none';
        return;
    }

    // effOPR — mirrors renderAtAGlance
    const globalIgnored = new Set(allMatches.filter(m => m.globallyIgnored).map(m => m.key));
    const tbaTeamMap = Object.fromEntries(allTBATeams.map(t => [t.teamNumber, t]));
    let globalOPRMap = null;
    if (globalIgnored.size > 0) {
        const teamNums = allTBATeams.map(t => t.teamNumber);
        const activePlayed = allMatches.filter(m =>
            (m.redScore ?? -1) >= 0 && (m.blueScore ?? -1) >= 0 && !globalIgnored.has(m.key)
        );
        const recomputed = computeLocalOPR(activePlayed, teamNums);
        if (recomputed) globalOPRMap = Object.fromEntries(teamNums.map((n, i) => [n, recomputed[i]]));
    }
    const effOPR = tba => {
        if (!tba) return null;
        const keys = getTeamIgnoredKeys(tba);
        if (keys.length > 0 && tba.adjustedOPR != null && keys.some(k => !globalIgnored.has(k)))
            return tba.adjustedOPR;
        if (globalOPRMap) return globalOPRMap[tba.teamNumber] ?? tba.opr ?? null;
        return tba.opr ?? null;
    };

    // RP totals
    const rpMap = {};
    const playedMatches = allMatches.filter(m => (m.redScore ?? -1) >= 0);
    for (const m of playedMatches) {
        const redWon = m.redScore > m.blueScore, blueWon = m.blueScore > m.redScore, tie = m.redScore === m.blueScore;
        const bonusRP = bd => bd ? ((bd.energizedAchieved ? 1 : 0) + (bd.superchargedAchieved ? 1 : 0) + (bd.traversalAchieved ? 1 : 0)) : 0;
        const redRP = m.redBreakdown?.rp ?? ((redWon ? 3 : tie ? 1 : 0) + bonusRP(m.redBreakdown));
        const blueRP = m.blueBreakdown?.rp ?? ((blueWon ? 3 : tie ? 1 : 0) + bonusRP(m.blueBreakdown));
        for (const team of (m.red || [])) {
            if (!rpMap[team]) rpMap[team] = { rp: 0, wins: 0, ties: 0, losses: 0, totalScore: 0, matches: 0 };
            rpMap[team].rp += redRP;
            rpMap[team].totalScore += m.redScore;
            rpMap[team].matches++;
            if (redWon) rpMap[team].wins++; else if (tie) rpMap[team].ties++; else rpMap[team].losses++;
        }
        for (const team of (m.blue || [])) {
            if (!rpMap[team]) rpMap[team] = { rp: 0, wins: 0, ties: 0, losses: 0, totalScore: 0, matches: 0 };
            rpMap[team].rp += blueRP;
            rpMap[team].totalScore += m.blueScore;
            rpMap[team].matches++;
            if (blueWon) rpMap[team].wins++; else if (tie) rpMap[team].ties++; else rpMap[team].losses++;
        }
    }

    // Scouting EPA
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    const scoutEPAMap = {};
    if (eventKey) {
        const rawStr = localStorage.getItem(`scoutingData_${eventKey}`);
        if (rawStr) {
            const fusedCache = (() => { try { return JSON.parse(localStorage.getItem(`scoutingFusedStats_${eventKey}`)); } catch { return null; } })();
            const processed = processScoutingData(eventKey, JSON.parse(rawStr), getScoutingColumnOverrides(eventKey));
            if (processed?.config?.computeEPABreakdown) {
                const { config, byTeam } = processed;
                for (const [tn, rawRows] of Object.entries(byTeam)) {
                    const tbaEntry = tbaTeamMap[parseInt(tn)];
                    const scoutIgnoreKeys = tbaEntry?.scoutingIgnoreActive ? getTeamIgnoredKeys(tbaEntry) : [];
                    let { rows: deduped } = deduplicateTeamRows(rawRows);
                    let ignoredMatchNums = new Set();
                    if (scoutIgnoreKeys.length > 0) {
                        ignoredMatchNums = new Set(allMatches.filter(m => scoutIgnoreKeys.includes(m.key)).map(m => m.matchNumber));
                        deduped = deduped.filter(r => !ignoredMatchNums.has(r.matchNumber));
                    }
                    const rawStats = config.aggregateTeam(deduped);
                    const fusedResult = fusedCache?.teams?.[tn];
                    const effectiveFused = (fusedResult?.available && ignoredMatchNums.size > 0)
                        ? refilteredFusedStats(fusedResult, ignoredMatchNums) : fusedResult;
                    const isFused = !!(effectiveFused?.available && config.computeFusedEPABreakdown);
                    const breakdown = isFused
                        ? config.computeFusedEPABreakdown(effectiveFused.stats)
                        : config.computeEPABreakdown(rawStats);
                    scoutEPAMap[tn] = { total: breakdown.total, isFused, isAdj: ignoredMatchNums.size > 0 };
                }
            }
        }
    }

    // Build rows
    let rows = allTeams.map(team => {
        const tn = parseInt(team.teamNumber);
        const tba = tbaTeamMap[tn];
        const rp = rpMap[String(tn)] || { rp: 0, wins: 0, ties: 0, losses: 0 };
        const opr = effOPR(tba);
        const analysis = team.analysis || {};
        const hasCeil = analysis.ceiling != null && analysis.ceiling !== '—';
        const epaVal = hasCeil ? parseFloat(analysis.ceiling) : (team.currentEPA || 0);
        const hasLOO = getTeamIgnoredKeys(tba).some(k => !globalIgnored.has(k)) && tba?.adjustedOPR != null;
        const hasAdj = !hasLOO && globalOPRMap != null;
        const scoutData = scoutEPAMap[tn];
        return { team, rp, opr, epaVal, hasCeil, hasLOO, hasAdj,
                 scoutEPA: scoutData?.total ?? null, scoutFused: scoutData?.isFused ?? false, scoutAdj: scoutData?.isAdj ?? false };
    });

    // Composite + tier (mirrors renderAtAGlance)
    {
        const pctRank = (arr, val) => {
            const sorted = [...arr].sort((a, b) => b - a);
            const idx = sorted.findIndex(v => v <= val + 0.001);
            return idx < 0 ? 1 : idx / (sorted.length || 1);
        };
        const epaVals = rows.map(r => r.epaVal);
        const oprVals = rows.map(r => r.opr ?? 0);
        const scoutEPAVals = rows.map(r => r.scoutEPA ?? 0);
        const hasAnyOPR = rows.some(r => r.opr != null);
        const hasAnyScout = rows.some(r => r.scoutEPA != null);
        const composite = r => {
            const sources = [pctRank(epaVals, r.epaVal)];
            if (hasAnyOPR)   sources.push(pctRank(oprVals, r.opr ?? 0));
            if (hasAnyScout) sources.push(pctRank(scoutEPAVals, r.scoutEPA ?? 0));
            return sources.reduce((a, b) => a + b, 0) / sources.length;
        };
        rows.forEach(r => { r.composite = composite(r); });
        const tierOrder = [...rows].sort((a, b) => a.composite - b.composite);
        const tierMap = new Map(tierOrder.map((r, i) => [
            r.team.teamNumber, i < 8 ? 'S' : i < 20 ? 'A' : i < 32 ? 'B' : 'C'
        ]));
        rows.forEach(r => { r.tier = tierMap.get(r.team.teamNumber); });
    }

    // Apply saved order; append any new teams at end sorted by composite
    const SEPARATOR = Object.freeze({ separator: true });
    const savedOrder = loadPickOrder();
    if (savedOrder.length) {
        const rowMap = new Map(rows.map(r => [String(r.team.teamNumber), r]));
        const orderedWithSep = [];
        let hasSep = false;
        for (const tn of savedOrder) {
            if (tn === '---separator---') { orderedWithSep.push(SEPARATOR); hasSep = true; }
            else { const r = rowMap.get(tn); if (r) { orderedWithSep.push(r); rowMap.delete(tn); } }
        }
        const rest = [...rowMap.values()].sort((a, b) => a.composite - b.composite);
        rows = [...orderedWithSep, ...rest];
        if (!hasSep) rows.unshift(SEPARATOR);
    } else {
        rows.sort((a, b) => a.composite - b.composite);
        rows.unshift(SEPARATOR);
    }

    const hasOPR = allTBATeams.length > 0;
    const hasRP = playedMatches.length > 0;

    // Sort unranked rows (after separator) by current sort column
    {
        const sepIdx = rows.findIndex(r => r.separator);
        const ranked = sepIdx >= 0 ? rows.slice(0, sepIdx + 1) : [];
        const unranked = sepIdx >= 0 ? rows.slice(sepIdx + 1) : [...rows];
        const getValue = r => {
            switch (pickListSortCol) {
                case 'epa':      return r.epaVal;
                case 'opr':      return r.opr ?? -999;
                case 'scoutEPA': return r.scoutEPA ?? -999;
                default:         return (1 - r.composite) * 100;
            }
        };
        unranked.sort((a, b) => {
            if (pickListSortCol === 'rp') {
                const avgRpA = a.rp.matches > 0 ? a.rp.rp / a.rp.matches : 0;
                const avgRpB = b.rp.matches > 0 ? b.rp.rp / b.rp.matches : 0;
                const rpDiff = avgRpB - avgRpA;
                if (rpDiff !== 0) return rpDiff * pickListSortDir;
                const avgA = a.rp.matches > 0 ? a.rp.totalScore / a.rp.matches : 0;
                const avgB = b.rp.matches > 0 ? b.rp.totalScore / b.rp.matches : 0;
                return (avgB - avgA) * pickListSortDir;
            }
            return (getValue(b) - getValue(a)) * pickListSortDir;
        });
        rows = [...ranked, ...unranked];
    }

    // Rebuild thead with sort arrows
    const arrowFor = col => {
        if (pickListSortCol !== col) return `<span style="opacity:0.3"> ↕</span>`;
        return pickListSortDir === 1 ? ' ↓' : ' ↑';
    };
    const th = (label, col, extra = '') =>
        `<th style="padding:10px 8px;border-bottom:2px solid #334155;color:#94a3b8;text-align:center;cursor:pointer;white-space:nowrap;${extra}" onclick="sortPickListBy('${col}')">${label}${arrowFor(col)}</th>`;
    table.querySelector('thead').innerHTML = `<tr>
        <th style="width:28px;padding:10px 4px;border-bottom:2px solid #334155;"></th>
        <th style="width:56px;padding:10px 8px;border-bottom:2px solid #334155;color:#94a3b8;text-align:center;white-space:nowrap;">#</th>
        <th style="padding:10px 8px;border-bottom:2px solid #334155;color:#94a3b8;text-align:left;white-space:nowrap;">Team</th>
        <th style="padding:10px 8px;border-bottom:2px solid #334155;color:#94a3b8;text-align:left;white-space:nowrap;">Name</th>
        ${th('Score', 'composite')}
        ${th('RP Rank', 'rp')}
        ${th('<img src="./statbotics.ico" height="18" style="vertical-align:middle;opacity:0.85;" title="EPA / Ceiling (Statbotics)">', 'epa')}
        ${th('<img src="./tba.png" height="18" style="vertical-align:middle;opacity:0.85;" title="OPR (TBA)">', 'opr')}
        ${th('<img src="./sheets.png" height="18" style="vertical-align:middle;opacity:0.85;" title="Scouting EPA (Google Sheets)">', 'scoutEPA')}
        <th style="width:60px;padding:10px 8px;border-bottom:2px solid #334155;"></th>
    </tr>`;

    // RP rank (1 = most RP), avg match score as tiebreaker
    const rpRankMap = {};
    if (hasRP) {
        Object.entries(rpMap)
            .sort(([, a], [, b]) => {
                if (b.rp !== a.rp) return b.rp - a.rp;
                const avgA = a.matches > 0 ? a.totalScore / a.matches : 0;
                const avgB = b.matches > 0 ? b.totalScore / b.matches : 0;
                return avgB - avgA;
            })
            .forEach(([tn,], i) => { rpRankMap[tn] = i + 1; });
    }

    const TIER = TIER_STYLE;

    table.style.display = 'table';
    let pickPos = 1;
    tbody.innerHTML = rows.map(r => {
        if (r.separator) {
            return `<tr data-separator="true" style="user-select:none;">
                <td colspan="10" class="drag-handle"
                    style="padding:9px 20px;border-top:2px dashed #334155;border-bottom:2px dashed #334155;background:#080d16;text-align:center;cursor:grab;touch-action:none;color:#475569;font-size:0.8rem;font-weight:700;letter-spacing:0.06em;">
                    ⠿ &nbsp; drag to reposition &nbsp;·&nbsp; unranked below &nbsp; ⠿
                </td>
            </tr>`;
        }
        const rowPos = pickPos++;
        const { team, rp, opr, epaVal, hasCeil, hasLOO, hasAdj, scoutEPA, scoutFused, scoutAdj } = r;
        const ts = TIER[r.tier];
        const record = hasRP ? `${rp.wins}–${rp.losses}${rp.ties ? `–${rp.ties}` : ''}` : null;
        const compStr = ((1 - r.composite) * 100).toFixed(1);
        const ceilBadge = hasCeil ? `<span style="color:#4ade80;font-size:0.65em;font-weight:600;margin-left:3px;">CEIL</span>` : '';
        const oprBadge = (hasLOO || hasAdj)
            ? `<span style="color:${hasLOO ? '#fbbf24' : '#f97316'};font-size:0.65em;font-weight:600;margin-left:3px;">ADJ</span>` : '';
        const scoutStr = scoutEPA != null ? scoutEPA.toFixed(1) : '—';
        const fusedBadge = scoutFused ? `<span style="color:#818cf8;font-size:0.65em;font-weight:600;margin-left:3px;">F</span>` : '';
        const scoutAdjBadge = scoutAdj ? `<span style="color:#fbbf24;font-size:0.65em;font-weight:600;margin-left:3px;">ADJ</span>` : '';
        const td = (content, center = true) =>
            `<td style="padding:13px 10px;border-bottom:1px solid #1e293b;${center ? ' text-align:center;' : ''}">${content}</td>`;

        return `<tr data-team="${team.teamNumber}" style="background:${ts.bg};">
            <td class="drag-handle" style="padding:10px 6px;border-bottom:1px solid #1e293b;text-align:center;cursor:grab;touch-action:none;box-shadow:inset 3px 0 0 ${ts.color};">
                <span style="color:#475569;font-size:1.2em;line-height:1;">⠿</span>
            </td>
            <td style="padding:10px 8px;border-bottom:1px solid #1e293b;text-align:center;">
                <span class="pick-pos" style="color:#64748b;font-weight:700;">${rowPos}</span>
            </td>
            <td style="padding:13px 10px;border-bottom:1px solid #1e293b;cursor:pointer;white-space:nowrap;" onclick="viewTeamDetail(${team.teamNumber})">
                <strong style="color:#f8fafc;">${team.teamNumber}</strong>${ownStar(team.teamNumber)}
            </td>
            <td style="padding:13px 10px;border-bottom:1px solid #1e293b;cursor:pointer;" onclick="viewTeamDetail(${team.teamNumber})">
                <span style="color:#94a3b8;font-size:0.85em;font-weight:600;">${team.teamName || ''}</span>
            </td>
            ${td(`<span style="color:${ts.color};">${compStr}</span>`)}
            ${(() => {
                const rpRank = rpRankMap[String(team.teamNumber)];
                return td(rpRank != null ? `<span style="color:#94a3b8;font-weight:700;">#${rpRank}</span>` : '—');
            })()}
            ${td(`${epaVal.toFixed(1)}${ceilBadge}`)}
            ${td(hasOPR ? `${opr != null ? opr.toFixed(1) : '—'}${oprBadge}` : '—')}
            ${td(`${scoutStr}${fusedBadge}${scoutAdjBadge}`)}
            <td style="padding:13px 10px;border-bottom:1px solid #1e293b;text-align:center;">
                <button onclick="dnpTeam('${team.teamNumber}')"
                    style="background:#1e293b;color:#ef4444;border:1px solid #ef4444;border-radius:6px;padding:5px 10px;font-size:0.8rem;font-weight:700;cursor:pointer;white-space:nowrap;">
                    DNP
                </button>
            </td>
        </tr>`;
    }).join('');

    enablePickListDrag(tbody);
}

function enablePickListDrag(tbody) {
    tbody.addEventListener('pointerdown', e => {
        if (!e.target.closest('.drag-handle')) return;
        e.preventDefault();

        const dragRow = e.target.closest('tr');
        const rect = dragRow.getBoundingClientRect();
        const offsetY = e.clientY - rect.top;

        // Ghost: wrap in a table so <tr> renders correctly outside its parent
        const ghostTable = document.createElement('table');
        Object.assign(ghostTable.style, {
            position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
            width: rect.width + 'px', zIndex: '9999', opacity: '0.92',
            pointerEvents: 'none', borderCollapse: 'collapse',
            boxShadow: '0 6px 24px rgba(0,0,0,0.5)', borderRadius: '4px',
            fontFamily: 'inherit', fontSize: 'inherit',
        });
        const ghostBody = document.createElement('tbody');
        ghostBody.appendChild(dragRow.cloneNode(true));
        ghostTable.appendChild(ghostBody);
        document.body.appendChild(ghostTable);
        dragRow.style.opacity = '0.25';
        document.body.style.cursor = 'grabbing';

        function getTarget(cx, cy) {
            ghostTable.style.visibility = 'hidden';
            const el = document.elementFromPoint(cx, cy);
            ghostTable.style.visibility = '';
            return el?.closest('#pickListBody tr') || null;
        }
        function clearIndicators() {
            tbody.querySelectorAll('.pick-drop-before, .pick-drop-after').forEach(r => {
                r.classList.remove('pick-drop-before', 'pick-drop-after');
            });
        }

        function onMove(e) {
            e.preventDefault();
            ghostTable.style.top = (e.clientY - offsetY) + 'px';
            const target = getTarget(e.clientX, e.clientY);
            clearIndicators();
            if (target && target !== dragRow) {
                const mid = target.getBoundingClientRect();
                target.classList.add(e.clientY < mid.top + mid.height / 2 ? 'pick-drop-before' : 'pick-drop-after');
            }
        }

        function finish(e) {
            ghostTable.remove();
            dragRow.style.opacity = '';
            document.body.style.cursor = '';
            const target = getTarget(e.clientX, e.clientY);
            clearIndicators();
            if (target && target !== dragRow) {
                const mid = target.getBoundingClientRect();
                if (e.clientY < mid.top + mid.height / 2) tbody.insertBefore(dragRow, target);
                else target.after(dragRow);
            }
            refreshPickPositions();
            savePickOrder();
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', cancel);
        }

        function cancel() {
            ghostTable.remove();
            dragRow.style.opacity = '';
            document.body.style.cursor = '';
            clearIndicators();
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', cancel);
        }

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', cancel);
    });
}

// ── Draft ────────────────────────────────────────────────────────────────

const DRAFT_ALLIANCE_COLORS = [
    { solid: '#ef4444', bg: 'rgba(239,68,68,0.10)' },
    { solid: '#f97316', bg: 'rgba(249,115,22,0.10)' },
    { solid: '#eab308', bg: 'rgba(234,179,8,0.10)' },
    { solid: '#22c55e', bg: 'rgba(34,197,94,0.10)' },
    { solid: '#06b6d4', bg: 'rgba(6,182,212,0.10)' },
    { solid: '#3b82f6', bg: 'rgba(59,130,246,0.10)' },
    { solid: '#8b5cf6', bg: 'rgba(139,92,246,0.10)' },
    { solid: '#ec4899', bg: 'rgba(236,72,153,0.10)' },
];
let draftRPRankedTeams = [];
let draftHistory = [];
let draftMode = localStorage.getItem('draftMode') || 'mock';

function loadDraftWeights() {
    try {
        const w = JSON.parse(localStorage.getItem('draftEPAWeights'));
        if (w && typeof w.scout === 'number') return w;
    } catch {}
    return { scout: 50, statbotics: 25, opr: 25 };
}
let draftWeights = loadDraftWeights();

window.saveDraftWeights = function () {
    draftWeights = {
        scout:      Math.max(0, parseFloat(document.getElementById('wScout')?.value)      || 0),
        statbotics: Math.max(0, parseFloat(document.getElementById('wStatbotics')?.value) || 0),
        opr:        Math.max(0, parseFloat(document.getElementById('wOPR')?.value)         || 0),
    };
    localStorage.setItem('draftEPAWeights', JSON.stringify(draftWeights));
    renderDraft();
};

window.setDraftMode = function (mode) {
    draftMode = mode;
    localStorage.setItem('draftMode', mode);
    if (mode === 'real' && !loadDraftState()) {
        const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
        if (eventKey) {
            const raw = localStorage.getItem(`tbaAlliances_${eventKey}`);
            if (raw) {
                try {
                    const data = JSON.parse(raw);
                    const alliances = Array.from({ length: 8 }, (_, i) => {
                        const a = data[i];
                        if (!a) return { captain: null, pick1: null, pick2: null };
                        const strip = key => a.picks[key]?.replace(/^frc/i, '') || null;
                        return { captain: strip(0), pick1: strip(1), pick2: strip(2) };
                    });
                    saveDraftState({ alliances, currentAlliance: 8, currentRound: 2 });
                } catch {}
            }
        }
    }
    renderDraft();
};

function loadDraftState() {
    try { const s = JSON.parse(localStorage.getItem(`${draftMode}DraftState`)); if (s?.alliances?.length === 8) return s; } catch { }
    return null;
}
function saveDraftState(s) { localStorage.setItem(`${draftMode}DraftState`, JSON.stringify(s)); }
function freshDraftState() {
    return { alliances: Array.from({ length: 8 }, () => ({ captain: null, pick1: null, pick2: null })), currentAlliance: 0, currentRound: 1 };
}
function buildDraftPickedSet(alliances) {
    const s = new Set();
    for (const a of alliances) {
        if (a.captain) s.add(String(a.captain));
        if (a.pick1) s.add(String(a.pick1));
        if (a.pick2) s.add(String(a.pick2));
    }
    return s;
}
function draftFillCaptain(state) {
    if (state.currentRound !== 1 || state.currentAlliance >= 8) return;
    const a = state.alliances[state.currentAlliance];
    if (a.captain !== null) return;
    const picked = buildDraftPickedSet(state.alliances);
    const next = draftRPRankedTeams.find(tn => !picked.has(String(tn)));
    if (next != null) a.captain = String(next);
}

window.loadTBAAlliances = async function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) { alert('No event key — enter one on the Home tab first.'); return; }

    const statusEl = document.getElementById('draftAllianceLoadStatus');
    if (statusEl) statusEl.textContent = 'Loading…';

    try {
        const data = await fetchTBA(`/event/${eventKey}/alliances`);
        if (!Array.isArray(data) || !data.length) {
            if (statusEl) statusEl.textContent = 'No alliance data available yet.';
            return;
        }

        const alliances = Array.from({ length: 8 }, (_, i) => {
            const a = data[i];
            if (!a) return { captain: null, pick1: null, pick2: null };
            const strip = key => a.picks[key]?.replace(/^frc/i, '') || null;
            return { captain: strip(0), pick1: strip(1), pick2: strip(2) };
        });

        localStorage.setItem(`tbaAlliances_${eventKey}`, JSON.stringify(data));
        draftHistory = [];
        saveDraftState({ alliances, currentAlliance: 8, currentRound: 2 });
        renderDraft();
        if (statusEl) statusEl.textContent = `Loaded ${data.length} alliance${data.length !== 1 ? 's' : ''} from TBA.`;
    } catch (err) {
        if (statusEl) statusEl.textContent = `Error: ${err.message}`;
    }
};

window.resetDraft = function () {
    draftHistory = [];
    localStorage.removeItem('mockDraftState');
    renderDraft();
};
window.draftUndo = function () {
    if (!draftHistory.length) return;
    saveDraftState(JSON.parse(draftHistory.pop()));
    renderDraft();
};
window.draftPick = function (teamNumber) {
    const tn = String(teamNumber);
    const state = loadDraftState() || freshDraftState();
    if (state.currentAlliance >= 8 || state.currentAlliance < 0) return;
    if (buildDraftPickedSet(state.alliances).has(tn)) return;
    draftHistory.push(JSON.stringify(state));
    const a = state.alliances[state.currentAlliance];
    if (state.currentRound === 1) {
        if (!a.captain || a.pick1 !== null) return;
        a.pick1 = tn;
        state.currentAlliance++;
        if (state.currentAlliance >= 8) { state.currentRound = 2; state.currentAlliance = 7; }
        else draftFillCaptain(state);
    } else {
        if (a.pick2 !== null) return;
        a.pick2 = tn;
        state.currentAlliance--;
    }
    saveDraftState(state);
    renderDraft();
};

async function renderDevTab() {
    const el = document.getElementById('tools-tab-dev');
    if (!el) return;
    el.innerHTML = `<div style="color:#94a3b8;padding:12px;">Loading…</div>`;
    const eventKey = (document.getElementById('eventKeyInput')?.value ?? '').trim().toLowerCase();
    const sources = [];

    const teams    = await db.teams.toArray();
    const tbaTeams = await db.tbaTeams.toArray();
    const matches  = await db.matches.toArray();
    if (teams.length)    sources.push({ name: `db.teams (${teams.length} records)`,    ex: teams[0] });
    if (tbaTeams.length) sources.push({ name: `db.tbaTeams (${tbaTeams.length} records)`, ex: tbaTeams[0] });
    if (matches.length)  sources.push({ name: `db.matches (${matches.length} records)`,  ex: matches[0] });

    if (eventKey) {
        for (const [lsKey, label] of [
            [`scoutingData_${eventKey}`, 'Scouting data'],
            [`pitData_${eventKey}`, 'Pit data'],
        ]) {
            try {
                const rows = JSON.parse(localStorage.getItem(lsKey) ?? 'null');
                if (Array.isArray(rows) && rows.length) sources.push({ name: `${label} (${rows.length} rows)`, ex: rows[0] });
            } catch {}
        }
    }

    const renderValue = (v, depth = 0) => {
        if (v == null) return '<span style="color:#475569;">—</span>';
        if (typeof v !== 'object') return `<span style="color:#64748b;">${String(v)}</span>`;
        const entries = Object.entries(v);
        if (!entries.length) return '<span style="color:#475569;">{}</span>';
        const preview = JSON.stringify(v);
        const short = preview.length <= 60 ? `<span style="color:#475569;font-size:0.9em;">${preview}</span>` : `<span style="color:#475569;font-size:0.9em;">${preview.slice(0, 60)}…</span>`;
        const indent = 4 + depth * 4;
        const inner = entries.map(([k2, v2]) => `
            <tr style="border-bottom:1px solid #0a0f1a;">
                <td style="padding:2px 8px 2px ${indent}px;color:#64748b;white-space:nowrap;font-size:13px;">${k2}</td>
                <td style="padding:2px 8px;font-size:13px;font-family:monospace;word-break:break-all;max-width:340px;">${renderValue(v2, depth + 1)}</td>
            </tr>`).join('');
        return `<details style="display:inline-block;max-width:100%;">
            <summary style="cursor:pointer;color:#475569;font-size:0.85em;list-style:none;white-space:nowrap;">▶ ${short}</summary>
            <table style="border-collapse:collapse;width:100%;background:#040810;">${inner}</table>
        </details>`;
    };
    const renderSource = ({ name, ex }) => {
        const rows = Object.entries(ex).map(([k, v]) => `
            <tr style="border-bottom:1px solid #0f172a;">
                <td style="padding:3px 8px;color:#94a3b8;white-space:nowrap;font-size:14px;">${k}</td>
                <td style="padding:3px 8px;font-size:14px;font-family:monospace;word-break:break-all;max-width:360px;">${renderValue(v)}</td>
            </tr>`).join('');
        return `<details style="margin-bottom:8px;border:1px solid #1e293b;border-radius:6px;overflow:hidden;">
            <summary style="cursor:pointer;color:#e2e8f0;font-weight:600;padding:8px 12px;background:#0f172a;font-size:0.9em;">
                ${name}
            </summary>
            <div style="overflow-x:auto;">
                <table style="border-collapse:collapse;min-width:320px;background:#080d16;">${rows}</table>
            </div>
        </details>`;
    };

    const fieldExplorerHtml = `
        <details style="margin-bottom:16px;border:1px solid #1e293b;border-radius:8px;overflow:hidden;">
            <summary style="cursor:pointer;color:#e2e8f0;font-weight:700;padding:10px 14px;background:#0f172a;font-size:1em;letter-spacing:0.02em;">
                Field Explorer
            </summary>
            <div style="padding:10px;">
                ${sources.length ? sources.map(renderSource).join('') : '<div style="color:#64748b;padding:4px 0;">No data loaded yet. Sync data first.</div>'}
            </div>
        </details>`;

    const tmInputId  = 'devTimeMachineInput';
    const tmStatusId = 'devTimeMachineStatus';
    const timeMachineHtml = `
        <details open style="border:1px solid #1e293b;border-radius:8px;overflow:hidden;">
            <summary style="cursor:pointer;color:#e2e8f0;font-weight:700;padding:10px 14px;background:#0f172a;font-size:1em;letter-spacing:0.02em;">
                Time Machine
            </summary>
            <div style="padding:14px;">
                <p style="color:#94a3b8;font-size:0.85em;margin:0 0 12px;line-height:1.6;">
                    Roll data back to the state after a specific qual match completed.
                    Scrubs scores and breakdowns for later matches from TBA, filters Statbotics
                    match history, and trims scouting entries. The schedule stays intact.
                    <strong style="color:#fbbf24;">You will need to re-sync all sources afterward.</strong>
                </p>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <label style="color:#94a3b8;font-size:0.85em;">After qual match #</label>
                    <input id="${tmInputId}" type="number" min="1" step="1" placeholder="e.g. 12"
                        style="width:80px;padding:4px 8px;background:#0f172a;border:1px solid #334155;color:#f8fafc;border-radius:4px;font-size:0.9em;">
                    <button onclick="applyTimeMachineSnapshot()"
                        style="padding:5px 14px;background:#334155;color:#f8fafc;border:1px solid #475569;border-radius:5px;cursor:pointer;font-size:0.85em;font-weight:600;">
                        Roll back
                    </button>
                </div>
                <div id="${tmStatusId}" style="margin-top:10px;font-size:0.82em;color:#64748b;"></div>
            </div>
        </details>`;

    const wlControlsHtml = `
        <details style="margin-bottom:16px;border:1px solid #1e293b;border-radius:8px;overflow:hidden;" open>
            <summary style="cursor:pointer;color:#e2e8f0;font-weight:700;padding:10px 14px;background:#0f172a;font-size:1em;letter-spacing:0.02em;">
                Watch List Settings
            </summary>
            <div style="padding:10px 14px;" id="dev-wl-controls-content">
                ${wlDetailCache
                    ? buildWLControlsHTML(
                        (document.getElementById('eventKeyInput')?.value ?? '').trim().toLowerCase(),
                        wlDetailCache.effectiveThresholds,
                        wlDetailCache.allMatches.length,
                        wlDetailCache.tbaMap)
                    : '<div style="color:#64748b;font-size:0.85em;">Open the Watch List tab first to load settings.</div>'}
            </div>
        </details>`;

    const calibrationHtml = `
        <details style="margin-bottom:16px;border:1px solid #1e293b;border-radius:8px;overflow:hidden;">
            <summary style="cursor:pointer;color:#e2e8f0;font-weight:700;padding:10px 14px;background:#0f172a;font-size:1em;letter-spacing:0.02em;">
                Watch List — Model Calibration
            </summary>
            <div style="padding:14px;">
                <p style="color:#94a3b8;font-size:0.85em;line-height:1.6;margin:0 0 14px;">
                    Tests the simulation model against the current event's played matches.
                    Each match is predicted using only data from preceding matches — exactly as the model sees it live.
                    Results show how well the predicted probabilities are calibrated against actual outcomes.
                </p>
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
                    <label style="color:#94a3b8;font-size:0.84em;white-space:nowrap;font-weight:600;">Event keys</label>
                    <input id="bt-event-keys" type="text" value="${eventKey}"
                        placeholder="e.g. 2026necmp1, 2026mane"
                        style="flex:1;min-width:180px;background:#0f172a;border:1px solid #334155;border-radius:5px;color:#f1f5f9;padding:6px 10px;font-size:0.83em;">
                    <button onclick="runBacktest()" style="background:#1e3a5f;color:#93c5fd;border:1px solid #2563eb;border-radius:6px;padding:6px 16px;font-size:0.85em;font-weight:600;cursor:pointer;white-space:nowrap;">
                        Run Backtest
                    </button>
                </div>
                <p style="color:#475569;font-size:0.79em;margin:-2px 0 12px;line-height:1.5;">
                    Comma-separated. Other events are fetched from TBA + Statbotics and cached for the session.
                </p>
                <div id="algo-backtest-results"></div>
            </div>
        </details>`;

    // ── Quip Tier Breakdown ─────────────────────────────────────────────────
    const quipsEnabled = localStorage.getItem('quipsEnabled') === 'true';
    let quipTierHtml = `<label style="display:flex;align-items:center;gap:7px;font-size:0.8em;color:#475569;cursor:pointer;margin-bottom:14px;">
        <input type="checkbox" onchange="toggleQuipsEnabled()" ${quipsEnabled ? 'checked' : ''} style="cursor:pointer;accent-color:#4ade80;">
        Show team quips
    </label>`;
    if (quipsEnabled) {
        const eventTeams = eventKey ? await db.teams.where('eventKey').equals(eventKey).toArray() : [];
        if (eventTeams.length > 0) {
            const fusedCache = (() => { try { return JSON.parse(localStorage.getItem(`scoutingFusedStats_${eventKey}`)); } catch { return null; } })();
            const gameConfig = getGameConfig(eventKey);
            const getEPA = t => {
                const fr = fusedCache?.teams?.[String(t.teamNumber)];
                if (fr?.available && gameConfig?.computeFusedEPABreakdown) {
                    return gameConfig.computeFusedEPABreakdown(fr.stats).total;
                }
                return t.currentEPA ?? 0;
            };
            const epas = eventTeams.map(getEPA);
            const logMin = Math.log(Math.max(Math.min(...epas), 0.1));
            const logMax = Math.log(Math.max(Math.max(...epas), 0.1));
            const getLogFrac = t => logMax > logMin
                ? Math.max(0, Math.min(1, (Math.log(Math.max(getEPA(t), 0.1)) - logMin) / (logMax - logMin)))
                : 0.5;

            // Count teams per tier and collect their numbers
            const tierBuckets = Object.fromEntries(QUIP_TIERS.map(({ name }) => [name, []]));
            for (const t of eventTeams) {
                const tier = logFractionToTier(getLogFrac(t));
                tierBuckets[tier].push({ tn: t.teamNumber, frac: getLogFrac(t) });
            }

            const tierColors = { Elite: '#f59e0b', S: '#4ade80', A: '#a78bfa', B: '#60a5fa', C: '#94a3b8' };
            const rows = QUIP_TIERS.map(({ name, min }, i) => {
                const next = QUIP_TIERS[i - 1];
                const range = next ? `${(min * 100).toFixed(0)}–${(next.min * 100).toFixed(0)}%` : `${(min * 100).toFixed(0)}–100%`;
                const bucket = tierBuckets[name] ?? [];
                bucket.sort((a, b) => b.frac - a.frac);
                const chips = bucket.map(({ tn, frac }) =>
                    `<span style="display:inline-block;padding:1px 6px;border-radius:10px;background:${tierColors[name]}22;border:1px solid ${tierColors[name]}55;color:${tierColors[name]};font-size:0.75em;margin:1px;">${tn} <span style="opacity:0.6;">${(frac * 100).toFixed(1)}%</span></span>`
                ).join('');
                return `<tr style="border-bottom:1px solid #1e293b;">
                    <td style="padding:5px 8px;font-weight:700;color:${tierColors[name]};">${name}</td>
                    <td style="padding:5px 8px;color:#64748b;font-size:0.82em;">${range}</td>
                    <td style="padding:5px 8px;text-align:center;color:#e2e8f0;font-weight:600;">${bucket.length}</td>
                    <td style="padding:5px 8px;">${chips}</td>
                </tr>`;
            }).join('');

            quipTierHtml += `
            <details style="margin-bottom:16px;border:1px solid #1e293b;border-radius:8px;overflow:hidden;">
                <summary style="cursor:pointer;color:#e2e8f0;font-weight:700;padding:10px 14px;background:#0f172a;font-size:1em;letter-spacing:0.02em;">
                    Quip Tier Breakdown <span style="color:#475569;font-weight:400;font-size:0.85em;margin-left:8px;">${eventTeams.length} teams · ${eventKey}</span>
                </summary>
                <div style="padding:10px;overflow-x:auto;">
                    <table style="border-collapse:collapse;width:100%;font-size:0.85em;">
                        <thead><tr style="color:#475569;font-size:0.78em;border-bottom:1px solid #334155;">
                            <th style="padding:4px 8px;text-align:left;">Tier</th>
                            <th style="padding:4px 8px;text-align:left;">Log-fraction range</th>
                            <th style="padding:4px 8px;text-align:center;">Count</th>
                            <th style="padding:4px 8px;text-align:left;">Teams (fraction)</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </details>`;
        }
    }

    // ── Stream Seek Test ────────────────────────────────────────────────────
    let streamSeekStreams = [];
    try {
        streamSeekStreams = JSON.parse(localStorage.getItem(`webcasts_${eventKey}`) || '[]')
            .filter(w => w.type === 'youtube' && w.startTimestamp)
            .sort((a, b) => a.startTimestamp - b.startTimestamp);
    } catch {}

    const streamSeekTestHtml = `
        <details style="margin-bottom:16px;border:1px solid #1e293b;border-radius:8px;overflow:hidden;">
            <summary style="cursor:pointer;color:#e2e8f0;font-weight:700;padding:10px 14px;background:#0f172a;font-size:1em;letter-spacing:0.02em;">
                Stream Seek Test
            </summary>
            <div style="padding:14px;">
                <p style="color:#94a3b8;font-size:0.85em;margin:0 0 10px;line-height:1.6;">
                    Sets Match 1's <code style="color:#93c5fd;">actualTime</code> to N minutes after the matching stream starts.
                    The stream is selected by date — large N values will cross into the next day's stream automatically.
                    Open Match 1 afterward to verify the embed seeks to the right spot.
                </p>
                ${streamSeekStreams.length
                    ? `<div style="margin-bottom:12px;">${streamSeekStreams.map(s => {
                        const startLocal = new Date(s.startTimestamp * 1000).toLocaleString();
                        return `<div style="color:#64748b;font-size:0.82em;margin-bottom:2px;">📺 ${s.date} — started ${startLocal}</div>`;
                    }).join('')}</div>`
                    : `<div style="color:#64748b;font-size:0.82em;margin-bottom:12px;">No stream start times — sync schedule with <code style="color:#93c5fd;">VITE_YOUTUBE_KEY</code> set.</div>`
                }
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <label style="color:#94a3b8;font-size:0.85em;">Minutes into stream</label>
                    <input id="dev-stream-minutes" type="number" min="0" step="1" value="30"
                        style="width:80px;padding:4px 8px;background:#0f172a;border:1px solid #334155;color:#f8fafc;border-radius:4px;font-size:0.9em;">
                    <button onclick="devApplyStreamSeekTest()"
                        style="padding:5px 14px;background:#1e3a5f;color:#93c5fd;border:1px solid #2563eb;border-radius:5px;cursor:pointer;font-size:0.85em;font-weight:600;">
                        Apply
                    </button>
                    <button onclick="devResetStreamSeekTest()"
                        style="padding:5px 14px;background:#334155;color:#f8fafc;border:1px solid #475569;border-radius:5px;cursor:pointer;font-size:0.85em;font-weight:600;">
                        Reset
                    </button>
                </div>
                <div id="dev-stream-status" style="margin-top:10px;font-size:0.82em;color:#64748b;"></div>
            </div>
        </details>`;

    // ── Notification Tester ──────────────────────────────────────────────────
    const notifPerm = ('Notification' in window) ? Notification.permission : 'unsupported';
    const permColor = { granted: '#4ade80', denied: '#f87171', default: '#fbbf24', unsupported: '#64748b' }[notifPerm] ?? '#64748b';
    const notifTesterHtml = `
        <details style="margin-bottom:16px;border:1px solid #1e293b;border-radius:8px;overflow:hidden;">
            <summary style="cursor:pointer;color:#e2e8f0;font-weight:700;padding:10px 14px;background:#0f172a;font-size:1em;letter-spacing:0.02em;">
                Notification Tester
            </summary>
            <div style="padding:14px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
                    <span style="font-size:0.82em;color:#64748b;">Permission:</span>
                    <span style="font-size:0.82em;font-weight:700;color:${permColor};">${notifPerm}</span>
                    ${notifPerm === 'default' ? `<button onclick="Notification.requestPermission().then(()=>renderDevTab())"
                        style="margin-left:6px;padding:3px 10px;background:#1e3a5f;color:#93c5fd;border:1px solid #2563eb;border-radius:5px;cursor:pointer;font-size:0.8em;">
                        Request
                    </button>` : ''}
                </div>
                <p style="color:#94a3b8;font-size:0.82em;margin:0 0 12px;line-height:1.5;">
                    Fires a notification directly, bypassing the enabled toggle. Use this to verify permission and OS delivery.
                </p>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button onclick="devTestNotif('warn')"
                        style="padding:5px 14px;background:#1e3a5f;color:#93c5fd;border:1px solid #2563eb;border-radius:5px;cursor:pointer;font-size:0.85em;font-weight:600;">
                        Test: Match Warning
                    </button>
                    <button onclick="devTestNotif('score')"
                        style="padding:5px 14px;background:#1e3a5f;color:#93c5fd;border:1px solid #2563eb;border-radius:5px;cursor:pointer;font-size:0.85em;font-weight:600;">
                        Test: Score Posted
                    </button>
                    <button onclick="devTestNotif('title')"
                        style="padding:5px 14px;background:#334155;color:#f8fafc;border:1px solid #475569;border-radius:5px;cursor:pointer;font-size:0.85em;font-weight:600;">
                        Test: Tab Title
                    </button>
                </div>
                <div id="dev-notif-status" style="margin-top:10px;font-size:0.82em;color:#64748b;"></div>
            </div>
        </details>`;

    el.innerHTML = `<div style="padding:12px;">${quipTierHtml}${wlControlsHtml}${calibrationHtml}${notifTesterHtml}${streamSeekTestHtml}${fieldExplorerHtml}${timeMachineHtml}</div>`;
}

window.devTestNotif = function (type) {
    const statusEl = document.getElementById('dev-notif-status');
    const perm = ('Notification' in window) ? Notification.permission : 'unsupported';

    if (perm === 'unsupported') {
        if (statusEl) statusEl.textContent = 'Notifications are not supported in this browser.';
        return;
    }
    if (perm !== 'granted') {
        if (statusEl) statusEl.textContent = 'Permission not granted — click Request above first.';
        return;
    }

    if (type === 'title') {
        document.title = '🔔 Test notification — 1768 Scouting';
        if (statusEl) statusEl.textContent = 'Tab title updated. Switch to another tab and back to see it reset.';
        return;
    }

    let title, body, tag;
    if (type === 'warn') {
        title = 'QM 12 in ~3 min';
        body  = '254, 1114, 1678 vs 2056, 118, 148';
        tag   = 'dev-warn-test';
    } else {
        title = 'QM 12 scored — Red wins';
        body  = '72–41 · Red: 254, 1114, 1678 · Blue: 2056, 118, 148';
        tag   = 'dev-score-test';
    }

    new Notification(title, { body, tag, icon: '/favicon.ico' });
    if (statusEl) statusEl.textContent = `Fired: "${title}"`;
};

window.devApplyStreamSeekTest = async function () {
    const statusEl = document.getElementById('dev-stream-status');
    const minutes = parseFloat(document.getElementById('dev-stream-minutes')?.value ?? '');
    if (isNaN(minutes) || minutes < 0) { statusEl.textContent = 'Enter a valid number of minutes (≥ 0).'; return; }

    const eventKey = (document.getElementById('eventKeyInput')?.value ?? '').trim().toLowerCase();
    let webcasts = [];
    try { webcasts = JSON.parse(localStorage.getItem(`webcasts_${eventKey}`) || '[]'); } catch {}

    const streams = webcasts
        .filter(w => w.type === 'youtube' && w.startTimestamp)
        .sort((a, b) => a.startTimestamp - b.startTimestamp);
    if (!streams.length) { statusEl.textContent = 'No stream start times — sync schedule with VITE_YOUTUBE_KEY set.'; return; }

    const offsetSecs = Math.round(minutes * 60);
    // Pick the stream whose date still contains the offset time; fall back to last stream.
    const chosenStream = streams.find(s =>
        new Date((s.startTimestamp + offsetSecs) * 1000).toISOString().slice(0, 10) === s.date
    ) ?? streams[streams.length - 1];

    const testActualTime = chosenStream.startTimestamp + offsetSecs;

    const allMatches = await db.matches.toArray();
    if (!allMatches.length) { statusEl.textContent = 'No matches in DB — sync schedule first.'; return; }
    allMatches.sort((a, b) => a.matchNumber - b.matchNumber);
    const firstMatch = allMatches[0];
    await db.matches.update(firstMatch.key, { actualTime: testActualTime });

    const seekMins = Math.floor(offsetSecs / 60);
    const seekSecs = String(offsetSecs % 60).padStart(2, '0');
    statusEl.innerHTML = `Match ${firstMatch.matchNumber} → ${new Date(testActualTime * 1000).toLocaleString()} · stream: ${chosenStream.date} · offset: ${seekMins}m${seekSecs}s. <a href="#" onclick="viewMatchDetail('${firstMatch.key}');return false;" style="color:#60a5fa;text-decoration:none;">Open match →</a>`;
};

window.devResetStreamSeekTest = async function () {
    const statusEl = document.getElementById('dev-stream-status');
    const allMatches = await db.matches.toArray();
    if (!allMatches.length) { if (statusEl) statusEl.textContent = 'No matches in DB.'; return; }
    allMatches.sort((a, b) => a.matchNumber - b.matchNumber);
    const firstMatch = allMatches[0];
    await db.matches.update(firstMatch.key, { actualTime: null });
    if (statusEl) statusEl.textContent = `Match ${firstMatch.matchNumber} actualTime cleared. Re-sync schedule to fully restore.`;
};

window.applyTimeMachineSnapshot = async function () {
    const statusEl = document.getElementById('devTimeMachineStatus');
    const inputEl  = document.getElementById('devTimeMachineInput');
    const cutoff   = parseInt(inputEl?.value ?? '');
    if (isNaN(cutoff) || cutoff < 0) {
        if (statusEl) statusEl.innerHTML = '<span style="color:#f87171;">Enter a valid match number (≥ 0).</span>';
        return;
    }
    const eventKey = (document.getElementById('eventKeyInput')?.value ?? '').trim().toLowerCase();
    if (!eventKey) {
        if (statusEl) statusEl.innerHTML = '<span style="color:#f87171;">Set an event key first.</span>';
        return;
    }
    if (statusEl) statusEl.innerHTML = '<span style="color:#94a3b8;">Applying…</span>';

    let matchesReset = 0, teamsUpdated = 0, scoutRows = 0, timesUpdated = 0;

    // ── 1. Roll back db.matches: erase scores for qual matches > cutoff ──────
    const allMatches = await db.matches.toArray();
    const sortedAll  = [...allMatches].sort((a, b) => (a.matchNumber ?? 0) - (b.matchNumber ?? 0));

    for (const m of allMatches) {
        if ((m.matchNumber ?? 0) > cutoff && (m.redScore ?? -1) >= 0) {
            await db.matches.update(m.key, { redScore: -1, blueScore: -1, redBreakdown: null, blueBreakdown: null });
            matchesReset++;
        }
    }

    // ── 2. Set future predictedTime on post-cutoff matches ────────────────────
    const playedSorted = sortedAll.filter(m => (m.matchNumber ?? 0) <= cutoff && (m.redScore ?? -1) >= 0);
    const postCutoff   = sortedAll.filter(m => (m.matchNumber ?? 0) > cutoff);
    if (postCutoff.length) {
        let gap = 480;
        if (playedSorted.length >= 2) {
            const last = playedSorted[playedSorted.length - 1];
            const prev = playedSorted[playedSorted.length - 2];
            const tLast = last.predictedTime ?? last.time;
            const tPrev = prev.predictedTime ?? prev.time;
            if (tLast && tPrev && tLast > tPrev) gap = Math.max(300, Math.min(900, tLast - tPrev));
        }
        // Always anchor to real now so countdowns show positive values regardless of when the event was
        let t = Math.floor(Date.now() / 1000) + gap;
        for (const m of postCutoff) {
            await db.matches.update(m.key, { predictedTime: t });
            t += gap;
            timesUpdated++;
        }
    }

    // ── 3. Roll back db.teams: filter rawStatboticsData for this event ────────
    const allTeams = await db.teams.toArray();
    for (const team of allTeams) {
        const raw = team.rawStatboticsData ?? [];
        const filtered = raw.filter(m => {
            if (!m.match?.startsWith(eventKey + '_qm')) return true;
            const n = parseInt(m.match.slice(eventKey.length + 3));
            return isNaN(n) || n <= cutoff;
        });
        if (filtered.length === raw.length) continue;
        const played = filtered.filter(m => m.event === eventKey && m.epa?.post != null);
        const latestEPA = played.length ? played[played.length - 1].epa.post : team.currentEPA;
        await db.teams.update(team.teamNumber, { rawStatboticsData: filtered, currentEPA: latestEPA });
        teamsUpdated++;
    }

    // ── 4. Roll back scouting localStorage data (trim by match number) ────────
    try {
        const lsKey = `scoutingData_${eventKey}`;
        const rows = JSON.parse(localStorage.getItem(lsKey) ?? 'null');
        if (Array.isArray(rows)) {
            const before = rows.length;
            const kept = rows.filter(r => (r.matchNumber ?? 0) <= cutoff);
            scoutRows = before - kept.length;
            localStorage.setItem(lsKey, JSON.stringify(kept));
        }
    } catch {}

    // ── 5. Clear all event-scoped sync-state localStorage keys ───────────────
    for (const key of [
        `pitData_${eventKey}`,
        `tbaAlliances_${eventKey}`,
        `scoutingFusedStats_${eventKey}`,
        `archiveCoverage_${eventKey}`,
        `wlPreEventSnapshot_${eventKey}`,
    ]) localStorage.removeItem(key);
    // Draft state (not scoped to event but reflects post-draft selections)
    localStorage.removeItem('realDraftState');

    // ── 6. Reset module-level caches and dirty flags ──────────────────────────
    wlDetailCache       = null;
    wlPreEventCache     = null;
    watchListDirty      = true;
    wlMatchesRenderedFor = null;

    const parts = [
        `reset ${matchesReset} match score${matchesReset !== 1 ? 's' : ''}`,
        `set ${timesUpdated} future timestamp${timesUpdated !== 1 ? 's' : ''}`,
        `updated ${teamsUpdated} team${teamsUpdated !== 1 ? 's' : ''} in Statbotics history`,
        scoutRows ? `removed ${scoutRows} scouting row${scoutRows !== 1 ? 's' : ''}` : null,
    ].filter(Boolean).join(', ');
    if (statusEl) statusEl.innerHTML =
        `<span style="color:#4ade80;">✓ Done — ${parts}. ` +
        `Re-sync OPR, TBA Matches, and Statbotics to restore live data.</span>`;

    // Re-render the schedule so data-predicted-time attributes reflect the new timestamps
    await window.displaySchedule();
};

async function renderAlliancesTab() {
    const el = document.getElementById('tools-tab-alliances');
    if (!el) return;
    el.innerHTML = `<div style="color:#94a3b8;padding:12px;">Loading…</div>`;

    const eventKey = (document.getElementById('eventKeyInput')?.value ?? '').trim().toLowerCase();
    const gameConfig = eventKey ? getGameConfig(eventKey) : null;
    if (!gameConfig) {
        el.innerHTML = `<div style="color:#64748b;padding:12px;">Set an event key first.</div>`;
        return;
    }

    const [allTeamsArr, tbaTeamsArr, matchesArr] = await Promise.all([
        db.teams.toArray(), db.tbaTeams.toArray(), db.matches.toArray()
    ]);
    const teamsMap = Object.fromEntries(allTeamsArr.map(t => [t.teamNumber, t]));
    const tbaMap   = Object.fromEntries(tbaTeamsArr.map(t => [t.teamNumber, t]));
    const playedMatches = matchesArr.filter(m => (m.redScore ?? -1) >= 0);
    const { relResiduals, diffResiduals } = wlCollectResiduals(playedMatches, tbaMap, teamsMap);
    const oprWeight = Math.min(1, playedMatches.length / 30);
    const avg = allTeamsArr.reduce((s, t) => s + (t.currentEPA ?? 0), 0) / (allTeamsArr.length || 1);
    const effectiveThresholds = getEffectiveThresholds(gameConfig, eventKey);

    // Load alliance data: prefer TBA alliances, fall back to draft state
    let alliances = null;
    let source = '';
    const tbaRaw = localStorage.getItem(`tbaAlliances_${eventKey}`);
    if (tbaRaw) {
        try {
            alliances = JSON.parse(tbaRaw).map((a, i) => ({
                num: i + 1,
                teams: (a.picks ?? []).slice(0, 3).map(p => parseInt(p.replace('frc', ''))).filter(Boolean),
            }));
            source = 'TBA Alliances';
        } catch {}
    }
    if (!alliances) {
        const draft = loadDraftState();
        if (draft?.alliances) {
            alliances = draft.alliances.map((a, i) => ({
                num: i + 1,
                teams: [a.captain, a.pick1, a.pick2].filter(Boolean).map(Number),
            })).filter(a => a.teams.length > 0);
            source = 'Draft';
        }
    }
    if (!alliances || !alliances.length) {
        el.innerHTML = `<div style="color:#64748b;padding:12px;">
            No alliance data found. Load TBA alliances (Draft → Real Alliances → Load from TBA) or build a mock draft first.
        </div>`;
        return;
    }

    // Compute scores for all alliances first (needed for color coding and win%)
    const allianceData = alliances.map(({ num, teams }) => {
        const score    = wlAlliancePredictedScore(teams, tbaMap, teamsMap, avg, oprWeight);
        const sigmaRel = wlAllianceSigmaRel(teams, teamsMap, score);
        const sigma    = sigmaRel * score;
        return { num, teams, score, sigma };
    });

    // Expected average across all alliances (for color coding like draft tab)
    const expectedAvg = allianceData.reduce((s, a) => s + a.score, 0) / (allianceData.length || 1);

    // Find which alliance (if any) contains 1768
    const ownAlliance = allianceData.find(a => a.teams.map(String).includes(OWN_TEAM));

    const winPctHeader = ownAlliance
        ? `<th style="padding:6px 8px;text-align:center;font-size:0.82em;color:#fbbf24;">Win% vs Them</th>` : '';

    const rows = allianceData.map(({ num, teams, score, sigma }) => {
        const pct = expectedAvg > 0 ? (score - expectedAvg) / expectedAvg : 0;
        const scoreColor = pct > 0.12 ? '#4ade80' : pct > 0.04 ? '#a3e635' : pct > -0.04 ? '#f8fafc' : pct > -0.12 ? '#fb923c' : '#ef4444';

        const teamLinks = teams.map(tn =>
            `<span onclick="viewTeamDetail(${tn},'overview')" style="cursor:pointer;color:#93c5fd;margin-right:6px;">${tn}</span>`
        ).join('');

        let winPctCell = '';
        if (ownAlliance) {
            if (ownAlliance.num === num) {
                winPctCell = `<td style="padding:6px 8px;text-align:center;color:#475569;font-size:0.8em;">—</td>`;
            } else {
                const own = ownAlliance;
                const diffSigma = Math.sqrt(own.sigma * own.sigma + sigma * sigma);
                const z = diffSigma > 0 ? (own.score - score) / diffSigma : 0;
                const prob = Math.round(btNormalCDF(z) * 100);
                const wColor = prob > 60 ? '#4ade80' : prob > 40 ? '#fbbf24' : '#f87171';
                winPctCell = `<td style="padding:6px 8px;text-align:center;color:${wColor};font-weight:600;">${prob}%</td>`;
            }
        }

        return `<tr style="border-bottom:1px solid #1e293b;${ownAlliance?.num === num ? 'background:#0f1e30;' : ''}">
            <td style="padding:6px 8px;text-align:center;color:#94a3b8;font-weight:700;">${num}</td>
            <td style="padding:6px 8px;">${teamLinks || '<span style="color:#475569;">—</span>'}</td>
            <td style="padding:6px 8px;text-align:center;color:${scoreColor};font-weight:700;">${score.toFixed(1)}</td>
            <td style="padding:6px 8px;text-align:center;color:#64748b;">±${sigma.toFixed(1)}</td>
            ${winPctCell}
        </tr>`;
    }).join('');

    el.innerHTML = `<div style="padding:12px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
            <h3 style="color:#e2e8f0;margin:0;">Alliance Estimates</h3>
            <span style="color:#64748b;font-size:0.82em;">Source: ${source} · ${playedMatches.length} played matches · EPA/OPR blend ${Math.round(oprWeight*100)}% OPR</span>
        </div>
        <div style="overflow-x:auto;">
        <table style="border-collapse:collapse;width:100%;min-width:400px;">
            <thead><tr style="border-bottom:2px solid #334155;">
                <th style="padding:6px 8px;text-align:center;font-size:0.82em;color:#94a3b8;">#</th>
                <th style="padding:6px 8px;font-size:0.82em;color:#94a3b8;">Teams</th>
                <th style="padding:6px 8px;text-align:center;font-size:0.82em;color:#94a3b8;">Exp. Score</th>
                <th style="padding:6px 8px;text-align:center;font-size:0.82em;color:#94a3b8;">±SD</th>
                ${winPctHeader}
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
        </div>
    </div>`;
}

async function renderDraft() {
    const allianceBody = document.getElementById('draftAllianceBody');
    const pickPanel = document.getElementById('draftPickPanel');
    const statusEl = document.getElementById('draftStatus');
    if (!allianceBody || !pickPanel) return;

    const [allTeams, allMatches, allTBATeams] = await Promise.all([db.teams.toArray(), db.matches.toArray(), db.tbaTeams.toArray()]);

    if (!allTeams.length) {
        if (statusEl) statusEl.textContent = 'No team data — sync team list/history or Statbotics Live first.';
        allianceBody.innerHTML = '';
        pickPanel.innerHTML = '<p style="color:#64748b;font-size:0.9em;padding:12px;">No data.</p>';
        return;
    }

    const teamInfoMap = Object.fromEntries(allTeams.map(t => [String(t.teamNumber), t]));
    const tbaTeamMap  = Object.fromEntries(allTBATeams.map(t => [String(t.teamNumber), t]));

    // Build scouting EPA map (same pattern as displayTBATeams / renderPickList)
    const scoutEPAMap = {};
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (eventKey) {
        const rawStr = localStorage.getItem(`scoutingData_${eventKey}`);
        if (rawStr) {
            const fusedCache = (() => { try { return JSON.parse(localStorage.getItem(`scoutingFusedStats_${eventKey}`)); } catch { return null; } })();
            const processed = processScoutingData(eventKey, JSON.parse(rawStr), getScoutingColumnOverrides(eventKey));
            if (processed?.config?.computeEPABreakdown) {
                const { config, byTeam } = processed;
                for (const [tn, rawRows] of Object.entries(byTeam)) {
                    const tbaEntry = tbaTeamMap[tn];
                    const scoutIgnoreKeys = tbaEntry?.scoutingIgnoreActive ? getTeamIgnoredKeys(tbaEntry) : [];
                    let { rows: deduped } = deduplicateTeamRows(rawRows);
                    let ignoredMatchNums = new Set();
                    if (scoutIgnoreKeys.length > 0) {
                        ignoredMatchNums = new Set(allMatches.filter(m => scoutIgnoreKeys.includes(m.key)).map(m => m.matchNumber));
                        deduped = deduped.filter(r => !ignoredMatchNums.has(r.matchNumber));
                    }
                    const rawStats = config.aggregateTeam(deduped);
                    const fusedResult = fusedCache?.teams?.[tn];
                    const effectiveFused = (fusedResult?.available && ignoredMatchNums.size > 0)
                        ? refilteredFusedStats(fusedResult, ignoredMatchNums) : fusedResult;
                    const isFused = !!(effectiveFused?.available && config.computeFusedEPABreakdown);
                    const breakdown = isFused
                        ? config.computeFusedEPABreakdown(effectiveFused.stats)
                        : config.computeEPABreakdown(rawStats);
                    scoutEPAMap[tn] = breakdown.total;
                }
            }
        }
    }

    // Initialize weight inputs from persisted weights on first render
    for (const [id, key] of [['wScout', 'scout'], ['wStatbotics', 'statbotics'], ['wOPR', 'opr']]) {
        const el = document.getElementById(id);
        if (el && !el.dataset.initialized) { el.value = draftWeights[key]; el.dataset.initialized = '1'; }
    }

    const hasScout = Object.keys(scoutEPAMap).length > 0;
    const hasOPR   = allTBATeams.length > 0;

    // Normalized blended EPA — falls back gracefully when a source is unavailable
    const blendedEPA = tn => {
        const t = teamInfoMap[tn];
        if (!t) return 0;
        const statVal  = parseFloat(t.analysis?.ceiling ?? t.currentEPA ?? 0) || 0;
        const oprVal   = tbaTeamMap[tn]?.opr ?? null;
        const scoutVal = scoutEPAMap[tn]   ?? null;
        const sources  = [
            { w: draftWeights.statbotics, v: statVal  },
            { w: draftWeights.opr,        v: oprVal   },
            { w: draftWeights.scout,      v: scoutVal },
        ].filter(s => s.v != null && s.w > 0);
        if (sources.length === 0) return statVal;
        const totalW = sources.reduce((s, x) => s + x.w, 0);
        return totalW > 0 ? sources.reduce((s, x) => s + x.v * (x.w / totalW), 0) : statVal;
    };

    // Update weight info indicator
    const infoEl = document.getElementById('draftWeightInfo');
    if (infoEl) {
        const missing = [];
        if (draftWeights.scout > 0 && !hasScout) missing.push('scouting N/A');
        if (draftWeights.opr   > 0 && !hasOPR)   missing.push('OPR N/A');
        infoEl.textContent = missing.join(' · ');
    }

    // RP totals (mirrors renderPickList logic)
    const rpTotals = {};
    const played = allMatches.filter(m => (m.redScore ?? -1) >= 0);
    for (const m of played) {
        const redWon = m.redScore > m.blueScore, tie = m.redScore === m.blueScore, blueWon = !redWon && !tie;
        const bonusRP = bd => bd ? ((bd.energizedAchieved ? 1 : 0) + (bd.superchargedAchieved ? 1 : 0) + (bd.traversalAchieved ? 1 : 0)) : 0;
        const rRP = m.redBreakdown?.rp ?? ((redWon ? 3 : tie ? 1 : 0) + bonusRP(m.redBreakdown));
        const bRP = m.blueBreakdown?.rp ?? ((blueWon ? 3 : tie ? 1 : 0) + bonusRP(m.blueBreakdown));
        (m.red || []).forEach(t => { rpTotals[t] = (rpTotals[t] || 0) + rRP; });
        (m.blue || []).forEach(t => { rpTotals[t] = (rpTotals[t] || 0) + bRP; });
    }
    // RP-ranked list for captain auto-fill
    draftRPRankedTeams = Object.entries(rpTotals).sort(([, a], [, b]) => b - a).map(([tn]) => tn);
    const rpSet = new Set(draftRPRankedTeams);
    allTeams.forEach(t => { if (!rpSet.has(String(t.teamNumber))) draftRPRankedTeams.push(String(t.teamNumber)); });
    if (!played.length) {
        const po = (() => { try { return JSON.parse(localStorage.getItem('pickListOrder')) || []; } catch { return []; } })()
            .filter(t => t !== '---separator---');
        if (po.length) draftRPRankedTeams = po;
    }

    // Quick tier by blended EPA rank (for pick panel color coding)
    const sortedByEPA = allTeams.slice().sort((a, b) => blendedEPA(String(b.teamNumber)) - blendedEPA(String(a.teamNumber)));
    const epaRankOf = Object.fromEntries(sortedByEPA.map((t, i) => [String(t.teamNumber), i]));
    const quickTier = tn => { const r = epaRankOf[tn] ?? 99; return r < 8 ? 'S' : r < 20 ? 'A' : r < 32 ? 'B' : 'C'; };
    const TIER_CLR = { S: '#f59e0b', A: '#4ade80', B: '#a855f7', C: '#64748b' };

    // Load/init state; auto-fill first captain
    let state = loadDraftState() || freshDraftState();
    draftFillCaptain(state);
    saveDraftState(state);

    const picked = buildDraftPickedSet(state.alliances);
    const isReal = draftMode === 'real';
    const isDone = isReal || state.currentAlliance >= 8 || state.currentAlliance < 0;
    const isUser = !isDone && (state.currentRound === 2 || state.alliances[state.currentAlliance]?.captain !== null);

    // Sync mode toggle appearance and control visibility
    const mockBtn = document.getElementById('draftModeMockBtn');
    const realBtn = document.getElementById('draftModeRealBtn');
    const mockControls = document.getElementById('draftMockControls');
    const realControls = document.getElementById('draftRealControls');
    if (mockBtn) { mockBtn.style.background = isReal ? 'transparent' : '#1e293b'; mockBtn.style.color = isReal ? '#64748b' : '#f8fafc'; }
    if (realBtn) { realBtn.style.background = isReal ? '#1e293b' : 'transparent'; realBtn.style.color = isReal ? '#f8fafc' : '#64748b'; }
    if (mockControls) mockControls.style.display = isReal ? 'none' : 'flex';
    if (realControls) realControls.style.display = isReal ? 'flex' : 'none';

    if (statusEl) {
        if (isReal) {
            const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
            const hasAlliances = eventKey && !!localStorage.getItem(`tbaAlliances_${eventKey}`);
            statusEl.textContent = hasAlliances ? 'Showing real alliance selection.' : 'No alliance data — load from TBA above.';
        } else if (isDone) {
            statusEl.textContent = 'Draft complete.';
        } else if (isUser) {
            const which = state.currentRound === 1 ? '1st pick' : '2nd pick';
            statusEl.textContent = `Alliance ${state.currentAlliance + 1} selecting ${which} — click a team →`;
        } else {
            statusEl.textContent = 'Filling captain…';
        }
    }

    // ── Alliance table ──
    const epaOf = blendedEPA;

    // Expected total = sum of top 24 EPAs divided evenly across 8 alliances
    const top24sum = allTeams.map(t => epaOf(String(t.teamNumber))).sort((a, b) => b - a).slice(0, 24).reduce((s, v) => s + v, 0);
    const expectedTotal = top24sum / 8;

    const teamChip = tn => {
        if (!tn) return `<span style="color:#1e293b;">—</span>`;
        return `<span style="font-weight:800;color:#f8fafc;cursor:pointer;text-decoration:underline;text-underline-offset:2px;"
            onclick="event.stopPropagation();viewTeamDetail(${parseInt(tn)})">${tn}</span>`;
    };
    allianceBody.innerHTML = state.alliances.map((a, i) => {
        const { solid, bg } = DRAFT_ALLIANCE_COLORS[i];
        const isActive = !isDone && state.currentAlliance === i;
        const rowBg = isActive ? bg : (i % 2 ? '#080d16' : '#0f172a');
        const leftBorder = isActive ? `box-shadow:inset 3px 0 0 ${solid};` : '';
        const activePick1 = isActive && state.currentRound === 1 && !!a.captain && !a.pick1;
        const activePick2 = isActive && state.currentRound === 2 && !a.pick2;
        const cell = (content, active) =>
            `<td style="padding:11px 10px;border-bottom:1px solid #1e293b;text-align:center;` +
            (active ? `outline:1px dashed ${solid};outline-offset:-3px;` : '') + `">${content}</td>`;

        const all3 = a.captain && a.pick1 && a.pick2;
        const presentMembers = [a.captain, a.pick1, a.pick2].filter(Boolean);
        const total = presentMembers.length > 0 ? presentMembers.reduce((s, tn) => s + epaOf(tn), 0) : null;
        const pct = all3 && expectedTotal > 0 ? (total - expectedTotal) / expectedTotal : null;
        const totalColor = pct != null
            ? (pct > 0.12 ? '#4ade80' : pct > 0.04 ? '#a3e635' : pct > -0.04 ? '#f8fafc' : pct > -0.12 ? '#fb923c' : '#ef4444')
            : (total != null ? '#94a3b8' : '#334155');

        return `<tr style="background:${rowBg};${leftBorder}">
            <td style="padding:11px 8px;border-bottom:1px solid #1e293b;text-align:center;">
                <span style="color:#f8fafc;font-weight:900;font-size:1.2em;">${i + 1}</span>
            </td>
            ${cell(teamChip(a.captain), false)}
            ${cell(teamChip(a.pick1), activePick1)}
            ${cell(teamChip(a.pick2), activePick2)}
            <td style="padding:11px 10px;border-bottom:1px solid #1e293b;text-align:center;color:${totalColor};font-weight:700;">
                ${total != null ? total.toFixed(1) : '—'}
            </td>
        </tr>`;
    }).join('');

    // ── Pick panel ──
    const rawOrder = (() => {
        try { return JSON.parse(localStorage.getItem('pickListOrder')) || []; } catch { return []; }
    })().filter(t => t !== '---separator---');
    const hasPickList = rawOrder.length > 0;
    const available = rawOrder.filter(tn => !picked.has(tn) && teamInfoMap[tn]);
    const avSet = new Set(available);
    allTeams.forEach(t => { const tn = String(t.teamNumber); if (!picked.has(tn) && !avSet.has(tn)) available.push(tn); });
    if (!hasPickList) available.sort((a, b) => epaOf(b) - epaOf(a));

    pickPanel.innerHTML = available.map((tn, idx) => {
        const t = teamInfoMap[tn];
        if (!t) return '';
        const tierColor = TIER_CLR[quickTier(tn)];
        const epaVal = blendedEPA(tn);
        const epaStr = epaVal > 0 ? epaVal.toFixed(1) : '';
        return `<div class="draft-pick-item" ${isUser ? `onclick="draftPick('${tn}')"` : ''}
            style="padding:9px 12px;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:8px;
            border-left:3px solid ${tierColor};cursor:${isUser ? 'pointer' : 'default'};${!isUser ? 'opacity:0.45;' : ''}">
            <span style="color:#475569;font-size:0.75em;min-width:22px;text-align:right;font-weight:600;">${idx + 1}</span>
            <strong style="color:#f8fafc;font-size:0.95em;">${tn}</strong>
            <span style="color:#94a3b8;font-size:0.82em;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.teamName || ''}</span>
            ${epaStr ? `<span style="color:#475569;font-size:0.75em;font-weight:600;">${epaStr}</span>` : ''}
        </div>`;
    }).join('') || '<p style="color:#64748b;font-size:0.9em;padding:12px;">All teams placed.</p>';
}

window.updateDetailBackButton = function () {
    const btn = document.getElementById('detailBackBtn');
    if (!btn) return;

    // Change the label based on where the user was previously
    if (window.previousView === 'matchPrepView') {
        btn.innerText = '← Back';
    } else if (window.previousView === 'teamView') {
        btn.innerText = '← Back to Statbotics';
    } else {
        btn.innerText = '← Back';
    }
};

window.goBack = function () {
    if (document.body.classList.contains('split-ui')) {
        document.getElementById('teamDetailView').style.display = 'none';
        if (!popRightPanel()) {
            document.getElementById('splitRightPanel').style.display = 'flex';
        }
        return;
    }
    // Always hide the overlay explicitly — it may have been opened in split mode
    // before the user switched to desktop, leaving currentView pointing at the
    // left-panel view instead of teamDetailView.
    document.getElementById('teamDetailView').style.display = 'none';
    window.switchView(window.previousView);
};





let performanceChart = null;
let matchesChartInstance = null;
let rpTimelineChart = null;
let wlMatchesRenderedFor = null;
let activeTeamNumber = null;
let activeTeamData = null;
let activeTBAData = null;
let lastDetailTab = 'overview';
let lastDetailDataSubTab = 'epa';

const PHOTO_STYLE = 'width:220px; min-width:220px; height:auto; max-height:320px; object-fit:contain; border-radius:8px; border:1px solid #334155; background:#0f172a; display:block;';

async function renderOverview(team, tbaTeam) {
    const el = document.getElementById('overviewContent');
    if (!el) return;

    const fmt = (v, d = 1) => (v != null && v !== '—') ? parseFloat(v).toFixed(d) : '—';
    const analysis = team.analysis || {};
    const ceilStr = fmt(analysis.ceiling);
    const lb = analysis.lowerBound, ub = analysis.upperBound;
    const ciStr = (lb != null && lb !== '—' && ub != null && ub !== '—') ? `${lb} – ${ub}` : null;

    // Compute effective OPR (mirrors displayTBATeams logic)
    let effOPRVal = tbaTeam?.opr ?? null;
    let oprSuffix = '';
    // Load all data needed for tier ranking, OPR recomputation, and scouting ignore filtering
    const [allTeamsForOvTier, allTBAForOvTier, allMatches] = await Promise.all([
        db.teams.toArray(), db.tbaTeams.toArray(), db.matches.toArray(),
    ]);
    const tbaOvMap = Object.fromEntries(allTBAForOvTier.map(t => [t.teamNumber, t]));

    if (tbaTeam) {
        const globalIgnored = new Set(allMatches.filter(m => m.globallyIgnored).map(m => m.key));
        const indivKeys = getTeamIgnoredKeys(tbaTeam);
        if (indivKeys.some(k => !globalIgnored.has(k)) && tbaTeam.adjustedOPR != null) {
            effOPRVal = tbaTeam.adjustedOPR;
            oprSuffix = ' <span style="color:#fbbf24;font-size:0.65em;font-weight:600;">ADJ</span>';
        } else if (globalIgnored.size > 0) {
            const teamNums = allTBAForOvTier.map(t => t.teamNumber);
            const activePlayed = allMatches.filter(m =>
                (m.redScore ?? -1) >= 0 && (m.blueScore ?? -1) >= 0 && !globalIgnored.has(m.key)
            );
            const recomputed = computeLocalOPR(activePlayed, teamNums);
            if (recomputed) {
                const idx = teamNums.indexOf(parseInt(team.teamNumber));
                if (idx >= 0) effOPRVal = recomputed[idx];
                oprSuffix = ' <span style="color:#f97316;font-size:0.65em;font-weight:600;">ADJ</span>';
            }
        }
    }
    const ceilOf = t => t.analysis?.ceiling != null ? parseFloat(t.analysis.ceiling) : (t.currentEPA || 0);
    const tierOverall    = epaRankTier(allTeamsForOvTier, ceilOf(team), ceilOf);
    const tierAuto       = epaRankTier(allTeamsForOvTier, team.autoEPA    || 0, t => t.autoEPA    || 0);
    const tierTeleop     = epaRankTier(allTeamsForOvTier, team.teleopEPA  || 0, t => t.teleopEPA  || 0);
    const tierEndgame    = epaRankTier(allTeamsForOvTier, team.endgameEPA || 0, t => t.endgameEPA || 0);
    const tierOPR        = effOPRVal != null
        ? epaRankTier(allTBAForOvTier, effOPRVal, t => tbaOvMap[t.teamNumber]?.opr ?? 0)
        : null;
    const tierAutoOPR    = tbaTeam?.autoOPR    != null ? epaRankTier(allTBAForOvTier, tbaTeam.autoOPR,    t => tbaOvMap[t.teamNumber]?.autoOPR    ?? 0) : null;
    const tierTeleopOPR  = tbaTeam?.teleopOPR  != null ? epaRankTier(allTBAForOvTier, tbaTeam.teleopOPR,  t => tbaOvMap[t.teamNumber]?.teleopOPR  ?? 0) : null;
    const tierEndgameOPR = tbaTeam?.endgameOPR != null ? epaRankTier(allTBAForOvTier, tbaTeam.endgameOPR, t => tbaOvMap[t.teamNumber]?.endgameOPR ?? 0) : null;

    // Scouting EPA breakdown for this team and all scouted teams (for tier ranking)
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    const tn = String(team.teamNumber);
    let scoutBreakdown = null;
    let allScoutBreakdowns = [];
    let scoutIsFused = false;
    let scoutIsAdj  = false;
    if (eventKey) {
        const rawStr = localStorage.getItem(`scoutingData_${eventKey}`);
        if (rawStr) {
            const fusedCache = (() => { try { return JSON.parse(localStorage.getItem(`scoutingFusedStats_${eventKey}`)); } catch { return null; } })();
            const processed = processScoutingData(eventKey, JSON.parse(rawStr), getScoutingColumnOverrides(eventKey));
            if (processed?.config?.computeEPABreakdown) {
                const { config, byTeam } = processed;
                for (const [teamNum, rawRows] of Object.entries(byTeam)) {
                    const tbaEntry = tbaOvMap[parseInt(teamNum)];
                    const scoutIgnoreKeys = tbaEntry?.scoutingIgnoreActive ? getTeamIgnoredKeys(tbaEntry) : [];
                    let { rows: deduped } = deduplicateTeamRows(rawRows);
                    let ignoredMatchNums = new Set();
                    if (scoutIgnoreKeys.length > 0) {
                        ignoredMatchNums = new Set(allMatches.filter(m => scoutIgnoreKeys.includes(m.key)).map(m => m.matchNumber));
                        deduped = deduped.filter(r => !ignoredMatchNums.has(r.matchNumber));
                    }
                    const rawStats = config.aggregateTeam(deduped);
                    const fusedResult = fusedCache?.teams?.[teamNum];
                    const effectiveFused = (fusedResult?.available && ignoredMatchNums.size > 0)
                        ? refilteredFusedStats(fusedResult, ignoredMatchNums) : fusedResult;
                    const fused = !!(effectiveFused?.available && config.computeFusedEPABreakdown);
                    const bd = fused ? config.computeFusedEPABreakdown(effectiveFused.stats) : config.computeEPABreakdown(rawStats);
                    allScoutBreakdowns.push({ ...bd });
                    if (teamNum === tn) { scoutBreakdown = bd; scoutIsFused = fused; scoutIsAdj = ignoredMatchNums.size > 0; }
                }
            }
        }
    }
    const tierScoutAuto    = scoutBreakdown ? epaRankTier(allScoutBreakdowns, scoutBreakdown.auto    ?? 0, b => b.auto    ?? 0) : null;
    const tierScoutTeleop  = scoutBreakdown ? epaRankTier(allScoutBreakdowns, scoutBreakdown.teleop  ?? 0, b => b.teleop  ?? 0) : null;
    const tierScoutEndgame = scoutBreakdown ? epaRankTier(allScoutBreakdowns, scoutBreakdown.endgame ?? 0, b => b.endgame ?? 0) : null;
    const tierScoutTotal   = scoutBreakdown ? epaRankTier(allScoutBreakdowns, scoutBreakdown.total   ?? 0, b => b.total   ?? 0) : null;

    const photoId = `ov-photo-${team.teamNumber}`;
    const photoHtml = team.photoUrl
        ? `<img id="${photoId}" src="${team.photoUrl}" alt="Team ${team.teamNumber}"
               style="${PHOTO_STYLE} cursor:zoom-in; flex-shrink:0;"
               onclick="openLightbox('${team.photoUrl}')"
               onerror="this.style.display='none'">`
        : `<div id="${photoId}" style="width:220px; min-width:220px; height:220px; border-radius:8px; border:1px solid #334155; background:#1e293b; display:flex; align-items:center; justify-content:center; color:#334155; font-size:2.5em; font-weight:800; flex-shrink:0;">${team.teamNumber}</div>`;

    const sectionLabel = text =>
        `<div style="color:#64748b; font-size:0.72em; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; margin:20px 0 8px;">${text}</div>`;

    const placeholder = text =>
        `<div style="background:#1e293b; padding:20px; border-radius:8px; border:1px dashed #334155;">
            <p style="color:#475569; font-style:italic; margin:0; font-size:0.9em;">${text}</p>
        </div>`;

    const hasCompOPR = !!tbaTeam && tbaTeam.autoOPR != null;

    // Table cell helpers
    const cell = (val, tier) => {
        if (val == null) return `<td style="text-align:right;padding:8px 12px;border-bottom:1px solid #1e293b;color:#475569;font-size:0.9em;">—</td>`;
        return `<td style="text-align:right;padding:8px 12px;border-bottom:1px solid #1e293b;white-space:nowrap;">
            <span style="font-weight:700;color:#f1f5f9;margin-right:4px;">${fmt(val)}</span>${tier ? tierBadge(tier) : ''}
        </td>`;
    };
    const rowLabel = text =>
        `<td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:0.8em;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap;">${text}</td>`;

    const scoutHeader = `<img src="sheets.png" style="height:11px;vertical-align:middle;margin-right:3px;opacity:0.7;">Scouting${scoutIsFused ? ' <span style="color:#34d399;font-size:0.85em;vertical-align:middle;">●</span>' : ''}${scoutIsAdj ? ' <span style="color:#fbbf24;font-size:0.75em;font-weight:700;">ADJ</span>' : ''}`;

    el.innerHTML = `
        <div style="display:flex; gap:24px; align-items:flex-start; flex-wrap:wrap; margin-bottom:24px;">
            ${photoHtml}
            <div style="flex:1; min-width:180px;">
                <div style="font-size:1.8em; font-weight:800; color:#f8fafc; line-height:1.15;">${team.teamName || `Team ${team.teamNumber}`}</div>
                <div style="color:#64748b; font-size:1.05em; margin-top:4px;">Team #${team.teamNumber}</div>
                <div style="display:flex; gap:16px; margin-top:14px; flex-wrap:wrap;">
                    <a href="https://www.thebluealliance.com/team/${team.teamNumber}/${team.eventKey?.slice(0,4) || ''}" target="_blank"
                        style="color:#3b82f6; text-decoration:none; font-size:0.9em; display:inline-flex; align-items:center; gap:4px;"><img src="tba.png" class="source-logo" style="margin:0;">View on TBA ↗</a>
                    <a href="https://www.statbotics.io/team/${team.teamNumber}/${team.eventKey?.slice(0,4) || ''}" target="_blank"
                        style="color:#3b82f6; text-decoration:none; font-size:0.9em; display:inline-flex; align-items:center; gap:4px;"><img src="statbotics.ico" class="source-logo" style="margin:0;">View on Statbotics ↗</a>
                </div>
            </div>
        </div>

        ${sectionLabel('Performance')}
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.9em;border-radius:8px;overflow:hidden;border:1px solid #334155;min-width:340px;">
            <thead>
                <tr style="background:#1e293b;border-bottom:2px solid #334155;">
                    <th style="text-align:left;padding:10px 12px;color:#64748b;font-weight:600;font-size:0.75em;text-transform:uppercase;letter-spacing:0.05em;"></th>
                    <th style="text-align:right;padding:10px 12px;color:#64748b;font-weight:600;font-size:0.75em;text-transform:uppercase;letter-spacing:0.05em;">
                        <img src="statbotics.ico" style="height:11px;vertical-align:middle;margin-right:3px;opacity:0.7;">Statbotics
                    </th>
                    <th style="text-align:right;padding:10px 12px;color:#64748b;font-weight:600;font-size:0.75em;text-transform:uppercase;letter-spacing:0.05em;">
                        <img src="tba.png" class="source-logo" style="height:11px;margin:0 3px 0 0;vertical-align:middle;opacity:0.7;">TBA OPR
                    </th>
                    <th style="text-align:right;padding:10px 12px;color:#64748b;font-weight:600;font-size:0.75em;text-transform:uppercase;letter-spacing:0.05em;">${scoutHeader}</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    ${rowLabel('Auto')}
                    ${cell(team.autoEPA,                              tierAuto)}
                    ${cell(hasCompOPR ? tbaTeam.autoOPR    : null,   tierAutoOPR)}
                    ${cell(scoutBreakdown?.auto,                      tierScoutAuto)}
                </tr>
                <tr>
                    ${rowLabel('Teleop')}
                    ${cell(team.teleopEPA,                            tierTeleop)}
                    ${cell(hasCompOPR ? tbaTeam.teleopOPR  : null,   tierTeleopOPR)}
                    ${cell(scoutBreakdown?.teleop,                    tierScoutTeleop)}
                </tr>
                <tr>
                    ${rowLabel('Endgame')}
                    ${cell(team.endgameEPA,                           tierEndgame)}
                    ${cell(hasCompOPR ? tbaTeam.endgameOPR : null,   tierEndgameOPR)}
                    ${cell(scoutBreakdown?.endgame,                   tierScoutEndgame)}
                </tr>
                <tr>
                    ${rowLabel('Total')}
                    <td style="text-align:right;padding:8px 12px;border-bottom:1px solid #1e293b;white-space:nowrap;">
                        ${ceilStr !== '—'
                            ? `<span style="font-weight:700;color:#4ade80;margin-right:4px;">${ceilStr}</span>${tierBadge(tierOverall)}`
                            : `<span style="font-weight:700;color:#f1f5f9;margin-right:4px;">${fmt(team.currentEPA)}</span>${tierBadge(tierOverall)}`}
                    </td>
                    <td style="text-align:right;padding:8px 12px;border-bottom:1px solid #1e293b;white-space:nowrap;">
                        ${effOPRVal != null
                            ? `<span style="font-weight:700;color:#f1f5f9;margin-right:4px;">${fmt(effOPRVal)}</span>${tierOPR ? tierBadge(tierOPR) : ''}${oprSuffix}`
                            : `<span style="color:#475569;font-size:0.9em;">—</span>`}
                    </td>
                    ${cell(scoutBreakdown?.total,                     tierScoutTotal)}
                </tr>
            </tbody>
        </table>
        </div>

        ${sectionLabel('Per-Match Performance')}
        <div id="overview-matches-chart"></div>

        ${sectionLabel('Notes')}
        <div id="overview-notes-section"></div>
    `;

    renderNoteSection(team.teamNumber);
    await renderMatchesTab(team.teamNumber, 'overview-matches-chart');
    if (!team.photoUrl) fetchAndCacheTeamPhoto(team.teamNumber, photoId, team.eventKey?.slice(0, 4));
}

async function fetchAndCacheTeamPhoto(teamNumber, photoElId, year) {
    try {
        const media = await fetchTBA(`/team/frc${teamNumber}/media/${year}`);
        if (!media || !media.length) return;
        const candidates = media.filter(m => m.direct_url);
        if (!candidates.length) return;
        const pick = candidates.find(m => m.preferred) || candidates[0];
        const url = pick.direct_url;

        // Download and convert to base64 so the photo is available offline
        let dataUrl = url;
        try {
            const resp = await fetch(url);
            const blob = await resp.blob();
            dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (_) { /* keep external URL as fallback if download fails */ }

        const el = document.getElementById(photoElId);
        if (el) {
            const img = document.createElement('img');
            img.id = photoElId;
            img.src = dataUrl;
            img.alt = `Team ${teamNumber}`;
            img.style.cssText = PHOTO_STYLE + ' cursor:zoom-in; flex-shrink:0;';
            img.onclick = () => window.openLightbox(dataUrl);
            img.onerror = () => img.style.display = 'none';
            el.replaceWith(img);
        }
        await db.teams.update(parseInt(teamNumber), { photoUrl: dataUrl });
    } catch (_) { }
}

function renderPitTab(teamNumber) {
    const container = document.getElementById('tab-pit-data');
    if (!container) return;

    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    const rawStr = eventKey ? localStorage.getItem(`pitData_${eventKey}`) : null;

    if (!rawStr) {
        container.innerHTML = `<p style="color:#64748b;font-style:italic;padding:16px 0;">No pit scouting data loaded. Sync a pit sheet from the Home tab.</p>`;
        return;
    }

    const rows = JSON.parse(rawStr);
    const tn = String(teamNumber);
    // Find row(s) where any column's value matches the team number (numeric or string)
    const teamRows = rows.filter(row =>
        Object.values(row).some(v => String(v).trim() === tn)
    );

    if (!teamRows.length) {
        container.innerHTML = `<p style="color:#64748b;font-style:italic;padding:16px 0;">No pit data found for team ${teamNumber}.</p>`;
        return;
    }

    const SKIP_VALUE = v => v == null || String(v).trim() === '';
    container.innerHTML = teamRows.map((row, idx) => {
        const fields = Object.entries(row).filter(([, v]) => !SKIP_VALUE(v));
        const cells = fields.map(([k, v]) => `
            <div style="padding:8px 12px;border-bottom:1px solid #1e293b;">
                <div style="color:#64748b;font-size:0.72em;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;">${k}</div>
                <div style="color:#f1f5f9;font-size:0.92em;">${String(v)}</div>
            </div>`).join('');
        const heading = teamRows.length > 1
            ? `<div style="color:#94a3b8;font-size:0.8em;font-weight:700;padding:8px 12px;background:#0f172a;border-bottom:1px solid #334155;">Entry ${idx + 1}</div>`
            : '';
        return `<div style="background:#1e293b;border-radius:8px;overflow:hidden;margin-bottom:12px;">${heading}${cells}</div>`;
    }).join('');
}

window.switchDetailTab = async function (tab) {
    // Destroy RP timeline chart when navigating away from Matches tab
    if (lastDetailTab === 'matches' && tab !== 'matches') {
        if (rpTimelineChart) { rpTimelineChart.destroy(); rpTimelineChart = null; }
        wlMatchesRenderedFor = null;
    }
    lastDetailTab = tab;
    const tabs = ['overview', 'matches', 'data'];
    tabs.forEach(t => {
        document.getElementById(`tab-${t}`).style.display = t === tab ? 'block' : 'none';
    });
    document.querySelectorAll('#teamDetailTabs .detail-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', tabs[i] === tab);
    });
    if (tab === 'overview' && activeTeamData) {
        await renderOverview(activeTeamData, activeTBAData);
    }
    if (tab === 'matches' && activeTeamData) {
        await renderWLMatchesTab(activeTeamData.teamNumber);
    }
    if (tab === 'data' && activeTeamData) {
        await switchDetailDataSubTab(lastDetailDataSubTab);
    }
};

window.switchDetailDataSubTab = async function (tab) {
    lastDetailDataSubTab = tab;
    const panes = { epa: 'tab-epa-opr', scouting: 'tab-scouting', pit: 'tab-pit-data' };
    Object.entries(panes).forEach(([k, id]) => {
        document.getElementById(id).style.display = k === tab ? '' : 'none';
    });
    document.querySelectorAll('#dataSubTabs .detail-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['epa', 'scouting', 'pit'][i] === tab);
    });
    if (tab === 'epa' && activeTeamData) {
        renderChart(activeTeamData);
        await renderTBADetail(activeTeamData.teamNumber, activeTBAData);
    } else if (tab === 'scouting' && activeTeamData) {
        await renderScoutingTab(activeTeamData.teamNumber);
    } else if (tab === 'pit' && activeTeamData) {
        renderPitTab(activeTeamData.teamNumber);
    }
};

async function renderWLMatchesTab(teamNumber) {
    if (wlMatchesRenderedFor === teamNumber) return;
    const tableContainer = document.getElementById('matches-tab-table');
    if (!tableContainer) return;

    if (!wlDetailCache) {
        tableContainer.innerHTML = `<p style="color:#64748b;font-style:italic;margin-top:24px;text-align:center;">Computing predictions…</p>`;
        await renderWatchList();   // populates wlDetailCache as a side effect
        if (!wlDetailCache) {
            tableContainer.innerHTML = `<p style="color:#64748b;font-style:italic;margin-top:24px;text-align:center;">No schedule loaded — sync TBA matches first.</p>`;
            if (rpTimelineChart) { rpTimelineChart.destroy(); rpTimelineChart = null; }
            return;
        }
    }

    const { allMatches, matchPredictions, baseRP, playedMatches, effectiveThresholds,
            tbaMap, allTeamNums, relResiduals, diffResiduals, fuelOPRCache, gameConfig } = wlDetailCache;
    const tnStr = String(teamNumber);
    const playedKeys = new Set(playedMatches.map(m => m.key));
    const thresholds = effectiveThresholds.filter(r => r.threshold != null);

    const teamMatches = allMatches
        .filter(m => m.red?.includes(tnStr) || m.blue?.includes(tnStr))
        .sort((a, b) => a.matchNumber - b.matchNumber);

    if (!teamMatches.length) {
        tableContainer.innerHTML = `<p style="color:#64748b;font-style:italic;margin-top:24px;text-align:center;">No matches found for team ${teamNumber}.</p>`;
        return;
    }

    // Build predictions for ALL matches (played + unplayed) so we can chart expected RP
    const allPredictions = { ...matchPredictions };
    for (const m of teamMatches) {
        if (!allPredictions[m.key]) {
            allPredictions[m.key] = wlSimulateMatch(
                m, tbaMap, wlDetailCache.teamsMap, allTeamNums,
                relResiduals, diffResiduals, gameConfig, effectiveThresholds, playedMatches, fuelOPRCache
            );
        }
    }

    // ── RP Timeline Chart ─────────────────────────────────────────────────────
    const labels = teamMatches.map(m => `Q${m.matchNumber}`);
    let cumDiff = 0;
    const diffData = [];
    for (const m of teamMatches) {
        const isRed  = m.red?.includes(tnStr);
        const pred   = allPredictions[m.key];
        const winP   = pred ? (isRed ? pred.redProb : pred.blueProb) : 0.5;
        const tieP   = pred?.tieProb ?? 0;
        const rpProbs = pred ? (isRed ? pred.rpProbs.red : pred.rpProbs.blue) : {};
        const expRP  = winP * 3 + tieP * 1 + thresholds.reduce((s, r) => s + (rpProbs[r.rpField] ?? 0), 0);

        if (playedKeys.has(m.key)) {
            const bd  = isRed ? m.redBreakdown : m.blueBreakdown;
            const myS = isRed ? m.redScore : m.blueScore;
            const opS = isRed ? m.blueScore : m.redScore;
            const winRP  = myS > opS ? 3 : myS === opS ? 1 : 0;
            const bonusRP = thresholds.filter(r => bd?.[r.rpField]).length;
            cumDiff += (winRP + bonusRP) - expRP;
            diffData.push(+cumDiff.toFixed(2));
        } else {
            diffData.push(null);
        }
    }

    if (rpTimelineChart) { rpTimelineChart.destroy(); rpTimelineChart = null; }
    const canvas = document.getElementById('rpTimelineChart');
    if (canvas) {
        rpTimelineChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'RP vs. Expected',
                    data: diffData,
                    borderColor: diffData.at(diffData.filter(v => v !== null).length - 1) >= 0 ? '#22c55e' : '#ef4444',
                    backgroundColor: 'rgba(100,116,139,0.08)',
                    borderWidth: 2,
                    pointRadius: 3,
                    tension: 0.2,
                    spanGaps: false,
                    fill: { target: { value: 0 }, above: 'rgba(34,197,94,0.1)', below: 'rgba(239,68,68,0.1)' },
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: '#94a3b8', font: { size: 11 } } },
                    tooltip: { mode: 'index', intersect: false },
                },
                scales: {
                    x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } },
                    y: {
                        ticks: { color: '#64748b' },
                        grid: {
                            color: ctx => ctx.tick.value === 0 ? '#475569' : '#1e293b',
                        },
                        title: { display: true, text: 'Cumulative RP vs. Expected', color: '#64748b', font: { size: 10 } },
                    },
                },
            },
        });
    }

    // ── Match Table ───────────────────────────────────────────────────────────
    const thHeaders = thresholds.map(r =>
        `<th style="padding:4px 8px;text-align:center;">${r.label.replace(' RP', '')}</th>`).join('');

    const preMatchPreds = wlPreEventCache?.matchPredictions ?? {};

    let totalWins = 0, totalActRP = 0, totalExpRP = 0;
    const rows = teamMatches.map(m => {
        const isRed  = m.red?.includes(tnStr);
        const allies = (isRed ? m.red : m.blue).filter(t => t !== tnStr).join(' · ');
        const label  = isRed ? 'RED' : 'BLU';
        const lColor = isRed ? '#ef4444' : '#60a5fa';
        const pred   = allPredictions[m.key];
        const prePred = preMatchPreds[m.key];
        const preWinP = prePred ? (isRed ? prePred.redProb : prePred.blueProb) : null;
        const preWinPct = preWinP != null ? Math.round(preWinP * 100) : null;
        const preLine = preWinPct != null
            ? `<div style="font-size:0.75em;color:#475569;margin-top:1px;" title="Pre-event baseline — frozen at first load using EPA only. May differ from live if data was re-synced or OPR became available.">pre: ${preWinPct}%</div>`
            : '';
        const winP   = pred ? (isRed ? pred.redProb : pred.blueProb) : null;
        const rpProbs = pred ? (isRed ? pred.rpProbs.red : pred.rpProbs.blue) : {};
        const expWinRP   = pred ? (winP * 3 + pred.tieProb * 1) : null;
        const expBonusRP = pred ? thresholds.reduce((s, r) => s + (rpProbs[r.rpField] ?? 0), 0) : null;
        const expTotal   = expWinRP != null ? expWinRP + expBonusRP : null;
        const winPct = winP != null ? Math.round(winP * 100) : null;
        if (expTotal != null) totalExpRP += expTotal;

        const pColor = (pct) => pct >= 60 ? '#22c55e' : pct >= 35 ? '#f59e0b' : '#64748b';

        if (playedKeys.has(m.key)) {
            const bd   = isRed ? m.redBreakdown : m.blueBreakdown;
            const myS  = isRed ? m.redScore  : m.blueScore;
            const opS  = isRed ? m.blueScore : m.redScore;
            const won  = myS > opS, tied = myS === opS;
            const winRP   = won ? 3 : tied ? 1 : 0;
            const bonusRP = thresholds.filter(r => bd?.[r.rpField]).length;
            const actTotal = winRP + bonusRP;
            if (won) totalWins++;
            totalActRP += actTotal;
            const resultMark = won ? '✓' : tied ? '–' : '✗';
            const resultColor = won ? '#22c55e' : tied ? '#f59e0b' : '#64748b';
            const winCell = `<td style="padding:4px 8px;text-align:center;">
                ${winPct != null ? `<span style="color:${pColor(winPct)}">${winPct}%</span> ` : ''}
                <span style="color:${resultColor};font-weight:700;">${resultMark}</span>
                ${preLine}
            </td>`;
            const thCells = thresholds.map(r => {
                const p   = rpProbs[r.rpField];
                const hit = bd?.[r.rpField];
                const pStr = p != null ? `<span style="color:${pColor(Math.round(p*100))};font-size:0.8em;">${Math.round(p*100)}%</span> ` : '';
                return `<td style="padding:4px 8px;text-align:center;">${pStr}<span style="color:${hit ? '#22c55e' : '#475569'};font-weight:700;">${hit ? '✓' : '✗'}</span></td>`;
            }).join('');
            const expStr = expTotal != null ? `${expTotal.toFixed(1)} ` : '';
            return `<tr style="border-bottom:1px solid #1e293b;">
                <td style="padding:4px 8px;text-align:center;color:#94a3b8;">Q${m.matchNumber}</td>
                <td style="padding:4px 8px;text-align:center;font-size:0.8em;font-weight:700;color:${lColor};">${label}</td>
                <td style="padding:4px 8px;color:#94a3b8;font-size:0.82em;">${allies}</td>
                ${winCell}${thCells}
                <td style="padding:4px 8px;text-align:center;">${expStr}<span style="color:#64748b;">(${actTotal})</span></td>
            </tr>`;
        } else {
            const thCells = thresholds.map(r => {
                const p = rpProbs[r.rpField];
                const pct = p != null ? Math.round(p * 100) : null;
                return `<td style="padding:4px 8px;text-align:center;${pct != null ? `color:${pColor(pct)};` : 'color:#475569;'}">${pct != null ? pct + '%' : '—'}</td>`;
            }).join('');
            return `<tr style="border-bottom:1px solid #1e293b;">
                <td style="padding:4px 8px;text-align:center;color:#94a3b8;">Q${m.matchNumber}</td>
                <td style="padding:4px 8px;text-align:center;font-size:0.8em;font-weight:700;color:${lColor};">${label}</td>
                <td style="padding:4px 8px;color:#94a3b8;font-size:0.82em;">${allies}</td>
                <td style="padding:4px 8px;text-align:center;${winPct != null ? `color:${pColor(winPct)};` : 'color:#475569;'}">${winPct != null ? winPct + '%' : '—'}${preLine}</td>
                ${thCells}
                <td style="padding:4px 8px;text-align:center;color:#94a3b8;">${expTotal != null ? expTotal.toFixed(1) : '—'}</td>
            </tr>`;
        }
    }).join('');

    const playedCount = teamMatches.filter(m => playedKeys.has(m.key)).length;
    const footerColSpan = 3 + thresholds.length;
    const tfoot = playedCount > 0 ? `
        <tfoot><tr style="border-top:2px solid #334155;color:#f8fafc;font-weight:600;">
            <td colspan="${footerColSpan}" style="padding:6px 8px;text-align:right;color:#64748b;font-size:0.82em;">TOTAL</td>
            <td style="padding:6px 8px;text-align:center;">${totalWins}W</td>
            <td style="padding:6px 8px;text-align:center;">${totalExpRP.toFixed(1)} <span style="color:#64748b;">(${totalActRP})</span></td>
        </tr></tfoot>` : '';

    tableContainer.innerHTML = `
        <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:0.85em;">
                <thead><tr style="color:#64748b;font-size:0.78em;text-transform:uppercase;letter-spacing:0.04em;border-bottom:1px solid #334155;">
                    <th style="padding:4px 8px;text-align:center;">Match</th>
                    <th style="padding:4px 8px;text-align:center;">Side</th>
                    <th style="padding:4px 8px;">Allies</th>
                    <th style="padding:4px 8px;text-align:center;">Win%</th>
                    ${thHeaders}
                    <th style="padding:4px 8px;text-align:center;">Exp. RP</th>
                </tr></thead>
                <tbody>${rows}</tbody>
                ${tfoot}
            </table>
        </div>`;
    wlMatchesRenderedFor = teamNumber;
}

async function renderMatchesTab(teamNumber, containerId = 'tab-matches') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) {
        container.innerHTML = '<p style="color:#64748b;font-style:italic;margin-top:24px;text-align:center;">Set an event key on the Home tab.</p>';
        return;
    }

    const teamStr = String(teamNumber);
    const [allMatches, allTBATeams, allStatTeams] = await Promise.all([
        db.matches.toArray(), db.tbaTeams.toArray(), db.teams.toArray(),
    ]);

    const oprMap     = Object.fromEntries(allTBATeams.map(t => [String(t.teamNumber), t.opr ?? 0]));
    const teamOPR    = oprMap[teamStr] ?? 0;
    const evEPAMap   = Object.fromEntries(allStatTeams.map(t => [
        String(t.teamNumber),
        t.epa?.end ?? t.epa?.mean ?? (typeof t.currentEPA === 'number' ? t.currentEPA : null),
    ]));
    const teamEvEPA  = evEPAMap[teamStr] ?? null;

    const fusedCache  = (() => { try { return JSON.parse(localStorage.getItem(`scoutingFusedStats_${eventKey}`)); } catch { return null; } })();
    const fusedTeam   = fusedCache?.teams?.[teamStr];
    const fusedByMatch = fusedTeam?.fusedByMatch ?? {};
    const gameConfig  = getGameConfig(eventKey);
    const avgFusedEPA = (fusedTeam?.available && gameConfig?.computeFusedEPABreakdown)
        ? gameConfig.computeFusedEPABreakdown(fusedTeam.stats).total : null;

    // Statbotics series: eventEPA residual (same structure as OPR, Statbotics coefficients)
    // deviation = (allianceScore − sum(partner eventEPAs)) − team eventEPA

    const tbaTeamEntry   = allTBATeams.find(t => String(t.teamNumber) === teamStr) ?? null;
    const teamIgnoredKeys = new Set(getTeamIgnoredKeys(tbaTeamEntry));

    const globalIgnored  = new Set(allMatches.filter(m => m.globallyIgnored).map(m => m.key));
    const playedMatches  = allMatches
        .filter(m => (m.redScore ?? -1) >= 0 && !globalIgnored.has(m.key))
        .filter(m => m.red?.includes(teamStr) || m.blue?.includes(teamStr))
        .sort((a, b) => a.matchNumber - b.matchNumber);

    if (!playedMatches.length) {
        container.innerHTML = '<p style="color:#64748b;font-style:italic;margin-top:24px;text-align:center;">No match data — sync TBA matches first.</p>';
        return;
    }

    const labels     = [];
    const oprData    = [];
    const scoutData  = [];
    const statEvData = [];   // eventEPA residual
    const ignoredColIndices = new Set();

    for (const m of playedMatches) {
        const isRed       = m.red?.includes(teamStr);
        const alliance    = isRed ? m.red : m.blue;
        const allyScore   = isRed ? m.redScore : m.blueScore;
        const partnerSum  = alliance.filter(t => t !== teamStr).reduce((s, t) => s + (oprMap[t] ?? 0), 0);
        const oprDeviation = (allyScore - partnerSum) - teamOPR;

        const matchFused = fusedByMatch[m.matchNumber];
        const scoutDeviation = (matchFused && avgFusedEPA != null && gameConfig?.computeFusedEPABreakdown)
            ? gameConfig.computeFusedEPABreakdown(matchFused).total - avgFusedEPA
            : null;

        const evPartnerSum = alliance.filter(t => t !== teamStr).reduce((s, t) => s + (evEPAMap[t] ?? 0), 0);
        const statEvDev    = teamEvEPA != null ? (allyScore - evPartnerSum) - teamEvEPA : null;

        if (teamIgnoredKeys.has(m.key)) ignoredColIndices.add(labels.length);

        labels.push(`Q${m.matchNumber}`);
        oprData.push(parseFloat(oprDeviation.toFixed(2)));
        scoutData.push(scoutDeviation != null ? parseFloat(scoutDeviation.toFixed(2)) : null);
        statEvData.push(statEvDev     != null ? parseFloat(statEvDev.toFixed(2))      : null);
    }

    // Per-match average across all non-null series (for the white reference line)
    const avgData = labels.map((_, i) => {
        const vals = [oprData[i], scoutData[i], statEvData[i]].filter(v => v != null);
        return vals.length > 0 ? parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2)) : null;
    });

    const hasScout  = scoutData.some(v => v != null);
    const hasStatEv = statEvData.some(v => v != null);

    // Hatched canvas patterns distinguish the Statbotics series (///) from solid OPR/scouting bars.
    const makeHatch = color => {
        const sz = 10, c = document.createElement('canvas');
        c.width = sz; c.height = sz;
        const cx = c.getContext('2d');
        cx.strokeStyle = color; cx.lineWidth = 2.5; cx.beginPath();
        cx.moveTo(0, sz); cx.lineTo(sz, 0);
        cx.stroke();
        return cx.createPattern(c, 'repeat');
    };

    const evPosH = makeHatch('#fbbf24'); const evNegH = makeHatch('#a78bfa');

    const statEvLine = teamEvEPA != null ? ` · Stat event EPA = ${teamEvEPA.toFixed(1)}` : '';
    container.innerHTML = `
        <div style="margin-top:16px;background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:16px;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;flex-wrap:wrap;gap:6px;">
                <h3 style="margin:0;font-size:0.95em;font-weight:700;color:#f1f5f9;">Per-Match Performance vs. Average</h3>
                <span style="color:#475569;font-size:0.78em;">
                    OPR avg = ${teamOPR.toFixed(1)}${avgFusedEPA != null ? ` · scout avg = ${avgFusedEPA.toFixed(1)}` : ''}${statEvLine}
                </span>
            </div>
            <p style="margin:0 0 12px;font-size:0.78em;color:#475569;">Bars above zero = outperformed average; below = underperformed. All series share the same zero baseline.</p>
            <div style="overflow-x:auto;">
                <div style="min-width:${Math.max(360, playedMatches.length * 54)}px;">
                    <div style="position:relative;height:320px;"><canvas id="matchesChart"></canvas></div>
                    <div style="display:flex;margin-top:6px;padding:0 2px;" id="matchesChartLinks"></div>
                </div>
            </div>
        </div>
    `;

    // Populate per-match links row after innerHTML is set
    const linksRow = document.getElementById('matchesChartLinks');
    if (linksRow) {
        linksRow.innerHTML = playedMatches.map(m => `
            <div style="flex:1;display:flex;justify-content:center;">
                <button onclick="viewMatchDetail('${m.key}')"
                    title="Open Q${m.matchNumber} detail"
                    style="background:none;border:none;color:#334155;font-size:0.7em;cursor:pointer;padding:2px 4px;line-height:1;border-radius:3px;transition:color 0.15s;"
                    onmouseover="this.style.color='#94a3b8'" onmouseout="this.style.color='#334155'">↗</button>
            </div>`).join('');
    }

    if (matchesChartInstance) { matchesChartInstance.destroy(); matchesChartInstance = null; }

    // Align the links row under the chart columns by reading chartArea after render.
    const alignLinksPlugin = {
        id: 'matchesAlignLinks',
        afterRender(chart) {
            const row = document.getElementById('matchesChartLinks');
            if (!row || !labels.length) return;
            const { left, right } = chart.chartArea;
            const colWidth = (right - left) / labels.length;
            row.style.paddingLeft  = `${left}px`;
            row.style.paddingRight = `${chart.canvas.offsetWidth - right}px`;
            row.querySelectorAll('div').forEach(div => {
                div.style.width    = `${colWidth}px`;
                div.style.minWidth = `${colWidth}px`;
                div.style.flex     = 'none';
            });
        },
    };

    // Shade ignored match columns with a red background using beforeDraw plugin.
    const ignoredColBgPlugin = {
        id: 'matchesIgnoredBg',
        beforeDraw(chart) {
            const { ctx: c, chartArea, scales } = chart;
            if (!chartArea || !ignoredColIndices.size) return;
            const count = labels.length;
            const step  = count > 0 ? scales.x.width / count : 0;
            c.save();
            c.fillStyle = 'rgba(239,68,68,0.12)';
            for (const i of ignoredColIndices) {
                const cx = scales.x.getPixelForValue(i);
                c.fillRect(cx - step / 2, chartArea.top, step, chartArea.bottom - chartArea.top);
            }
            c.restore();
        },
    };

    const chartCtx = document.getElementById('matchesChart').getContext('2d');
    matchesChartInstance = new Chart(chartCtx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'OPR-implied vs avg',
                    data: oprData,
                    backgroundColor: oprData.map(v => v >= 0 ? 'rgba(56,189,248,0.65)' : 'rgba(248,113,113,0.65)'),
                    borderColor:     oprData.map(v => v >= 0 ? '#38bdf8' : '#f87171'),
                    borderWidth: 1,
                    borderRadius: 3,
                    order: 1,
                },
                ...(hasScout ? [{
                    label: 'Scout EPA vs avg',
                    data: scoutData,
                    backgroundColor: scoutData.map(v => v == null ? 'transparent' : v >= 0 ? 'rgba(74,222,128,0.65)' : 'rgba(251,146,60,0.65)'),
                    borderColor:     scoutData.map(v => v == null ? 'transparent' : v >= 0 ? '#4ade80' : '#fb923c'),
                    borderWidth: 1,
                    borderRadius: 3,
                    order: 1,
                }] : []),
                ...(hasStatEv ? [{
                    label: 'Stat event EPA residual (///)',
                    data: statEvData,
                    backgroundColor: statEvData.map(v => v == null ? 'transparent' : v >= 0 ? evPosH : evNegH),
                    borderColor:     statEvData.map(v => v == null ? 'transparent' : v >= 0 ? '#fbbf24' : '#a78bfa'),
                    borderWidth: 1,
                    borderRadius: 3,
                    order: 1,
                }] : []),
                {
                    label: 'Series avg',
                    type: 'line',
                    data: avgData,
                    showLine: false,
                    pointStyle: 'line',
                    pointRadius: 10,
                    pointBorderWidth: 2.5,
                    pointBorderColor: '#ffffff',
                    backgroundColor: 'transparent',
                    borderColor: 'transparent',
                    order: 0,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12 } },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const v = ctx.raw;
                            if (v == null) return `${ctx.dataset.label}: N/A`;
                            return `${ctx.dataset.label}: ${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    ticks: { color: '#64748b', font: { size: 10 } },
                    grid:  { color: '#1e293b' },
                },
                y: {
                    ticks: { color: '#64748b', font: { size: 10 } },
                    grid:  {
                        color: ctx => ctx.tick.value === 0 ? '#94a3b8' : '#1e293b',
                        lineWidth: ctx => ctx.tick.value === 0 ? 2 : 1,
                    },
                    title: { display: true, text: 'Δ from average', color: '#475569', font: { size: 10 } },
                },
            },
        },
        plugins: [ignoredColBgPlugin, alignLinksPlugin],
    });
}

// Merge same-matchNumber rows for one team into averaged/ORed single rows.
// Returns { rows: deduped[], duplicated: Set<matchNumber> }
function deduplicateTeamRows(rows) {
    const byMatch = {};
    for (const r of rows) {
        if (!byMatch[r.matchNumber]) byMatch[r.matchNumber] = [];
        byMatch[r.matchNumber].push(r);
    }
    const duplicated = new Set();
    const merged = Object.entries(byMatch).map(([, group]) => {
        if (group.length === 1) return group[0];
        duplicated.add(group[0].matchNumber);
        const result = {};
        for (const key of Object.keys(group[0])) {
            const vals = group.map(r => r[key]);
            if (key === 'comments') {
                result[key] = vals.filter(v => v).join(' | ');
            } else if (typeof vals[0] === 'boolean') {
                result[key] = vals.some(Boolean);
            } else if (typeof vals[0] === 'number') {
                result[key] = vals.reduce((s, v) => s + v, 0) / vals.length;
            } else {
                result[key] = vals.find(v => v) ?? vals[0];
            }
        }
        return result;
    });
    return { rows: merged.sort((a, b) => a.matchNumber - b.matchNumber), duplicated };
}

async function renderScoutingTab(teamNumber) {
    const container = document.getElementById('tab-scouting');
    if (!container) return;

    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) {
        container.innerHTML = '<p style="color:#64748b;font-style:italic;margin-top:24px;text-align:center;">Set an event key on the Home tab to see scouting data.</p>';
        return;
    }

    const rawStr = localStorage.getItem(`scoutingData_${eventKey}`);
    if (!rawStr) {
        container.innerHTML = '<p style="color:#64748b;font-style:italic;margin-top:24px;text-align:center;">No scouting data. Sync scouting data on the Home tab.</p>';
        return;
    }

    const rawRows = JSON.parse(rawStr);
    const overrides = getScoutingColumnOverrides(eventKey);
    const processed = processScoutingData(eventKey, rawRows, overrides);
    if (!processed) {
        container.innerHTML = '<p style="color:#64748b;font-style:italic;margin-top:24px;text-align:center;">No game config found for this event.</p>';
        return;
    }

    const { config, byTeam } = processed;
    const rawTeamRows = byTeam[String(teamNumber)] || [];
    if (rawTeamRows.length === 0) {
        container.innerHTML = '<p style="color:#64748b;font-style:italic;margin-top:24px;text-align:center;">No scouting observations for this team at this event.</p>';
        return;
    }

    let { rows: teamRows, duplicated } = deduplicateTeamRows(rawTeamRows);

    // If the user opted to exclude ignored matches from scouting, filter them out.
    const tbaTeamForFilter = activeTBAData?.teamNumber === teamNumber ? activeTBAData
        : await db.tbaTeams.get(parseInt(teamNumber));
    const scoutIgnoreKeys = getTeamIgnoredKeys(tbaTeamForFilter);
    const scoutIgnoreActive = tbaTeamForFilter?.scoutingIgnoreActive && scoutIgnoreKeys.length > 0;
    let scoutExcludedCount = 0;
    if (scoutIgnoreActive) {
        const tbaMatchesAll = await db.matches.toArray();
        const ignoredMatchNums = new Set(
            tbaMatchesAll.filter(m => scoutIgnoreKeys.includes(m.key)).map(m => m.matchNumber)
        );
        const before = teamRows.length;
        teamRows = teamRows.filter(r => !ignoredMatchNums.has(r.matchNumber));
        scoutExcludedCount = before - teamRows.length;
    }

    const rawStats = config.aggregateTeam(teamRows);

    // Inject raw fallbacks for robot stats (computed from scouting aggregates)
    if (config.robotFuseStats) {
        for (const stat of config.robotFuseStats) {
            const vals = teamRows.filter(r => !r.noShow).map(r => stat.scout(r));
            rawStats[stat.key] = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
        }
    }

    const tbaMatches = await db.matches.where('eventKey').equals(eventKey).toArray();

    // Overwrite unconditional shift percentages with hub-active-conditional versions.
    if (config.enrichAggregateWithTBA && tbaMatches.some(m => m.redBreakdown)) {
        const tbaByMatch = {};
        for (const m of tbaMatches) tbaByMatch[m.matchNumber] = m;
        config.enrichAggregateWithTBA(String(teamNumber), teamRows, rawStats, tbaByMatch);
    }

    const allByMatch = indexObservationsByMatch(processed.observations);
    const fused = fuseScoutingWithTBA(teamNumber, teamRows, allByMatch, tbaMatches, config);

    const fusedByMatch = fused.fusedByMatch ?? {};
    const fusedStats = fused.available ? { ...fused.stats } : {};

    // Derive fused totals by summing fused components
    if (fused.available) {
        config?.deriveFusedTotals?.(fusedStats);
    }

    const getValue = (key) => fusedStats[key] != null ? fusedStats[key] : rawStats[key];
    const isFused  = (key) => fusedStats[key] != null;

    // Compute scoutingEPA from weighted sum; mark fused if any component came from TBA
    if (config.scoringWeights) {
        const epa = Object.entries(config.scoringWeights)
            .reduce((sum, [key, w]) => sum + (getValue(key) ?? 0) * w, 0);
        rawStats.scoutingEPA = epa;
        const anyFused = Object.keys(config.scoringWeights).some(isFused);
        if (anyFused) fusedStats.scoutingEPA = epa;
    }

    let html = '';

    // Scouting exclusion banner
    if (scoutIgnoreActive) {
        html += `<div style="background:#1a1505;border:1px solid #854d0e;border-radius:6px;padding:9px 14px;margin-bottom:12px;font-size:0.8em;color:#fbbf24;">
            Excluding ${scoutExcludedCount} scouting observation${scoutExcludedCount !== 1 ? 's' : ''} from OPR-ignored match${scoutIgnoreKeys.length !== 1 ? 'es' : ''} · toggle in EPA/OPR tab</div>`;
    }

    // Fusion status banner
    if (fused.available) {
        const { total, withTBA } = fused.coverage;
        html += `
        <div style="background:#0f1f0f;border:1px solid #166534;border-radius:6px;padding:10px 14px;margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span style="color:#4ade80;font-size:0.75em;font-weight:700;">TBA FUSED</span>
            <span style="color:#64748b;font-size:0.75em;">${withTBA}/${total} matches fused · ${fused.reportingMode} reporting</span>
            <span style="color:#475569;font-size:0.72em;margin-left:auto;">● fused &nbsp; ○ scout-only</span>
        </div>`;
    } else if (tbaMatches.some(m => m.redBreakdown)) {
        html += `<div style="background:#1a1a1a;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:0.78em;color:#64748b;">TBA fusion unavailable — showing scouting data only.</div>`;
    } else {
        html += `<div style="background:#1e1a0a;border:1px solid #854d0e;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:0.78em;color:#ca8a04;">Run "Sync TBA Matches" to enable TBA-fused estimates. Showing scouting data only.</div>`;
    }

    // Build event-wide breakdown pool so renderScoutingDetail can rank tiers relatively.
    let allScoutBreakdowns = [];
    if (config.computeEPABreakdown || config.computeFusedEPABreakdown) {
        const eventFusedCache = (() => { try { return JSON.parse(localStorage.getItem(`scoutingFusedStats_${eventKey}`)); } catch { return null; } })();
        for (const [tn, rawRows] of Object.entries(byTeam)) {
            const { rows: deduped } = deduplicateTeamRows(rawRows);
            const agg = config.aggregateTeam(deduped);
            const fusedResult = eventFusedCache?.teams?.[tn];
            const hasFused = !!(fusedResult?.available && config.computeFusedEPABreakdown);
            const bd = hasFused
                ? config.computeFusedEPABreakdown(fusedResult.stats)
                : (config.computeEPABreakdown?.(agg) ?? {});
            allScoutBreakdowns.push({
                teamNumber: tn,
                ...bd,
                teleFuelFused:  hasFused ? (fusedResult.stats.teleFuelFused  ?? null) : null,
                avgScoringEff: agg.avgScoringEff ?? null,
            });
        }
    }

    const rankTier = (vals, myVal) => {
        const sorted = vals.filter(v => v != null && !isNaN(v)).sort((a, b) => b - a);
        const rank = sorted.findIndex(v => v <= myVal + 0.001);
        const r = rank < 0 ? sorted.length : rank;
        return r < 8 ? 'S' : r < 20 ? 'A' : r < 32 ? 'B' : 'C';
    };

    // Stat groups — game-specific rich detail or generic displayFields grid
    if (config.renderScoutingDetail) {
        html += config.renderScoutingDetail({ rawStats, fusedStats, getValue, isFused, teamRows, fusedByMatch, fused, allScoutBreakdowns, rankTier });
    } else {
        const GROUP_COLORS = {
            'Overview':              { accent: '#64748b', bg: 'rgba(100,116,139,0.07)' },
            'Auto Coral':            { accent: '#f59e0b', bg: 'rgba(245,158,11,0.08)'  },
            'Auto Algae':            { accent: '#f59e0b', bg: 'rgba(245,158,11,0.08)'  },
            'Teleop Coral':          { accent: '#3b82f6', bg: 'rgba(59,130,246,0.08)'  },
            'Teleop Algae':          { accent: '#3b82f6', bg: 'rgba(59,130,246,0.08)'  },
            'Endgame & Reliability': { accent: '#10b981', bg: 'rgba(16,185,129,0.08)'  },
            'Qualitative':           { accent: '#a78bfa', bg: 'rgba(167,139,250,0.08)' },
        };
        const DEFAULT_COLOR = { accent: '#64748b', bg: 'rgba(100,116,139,0.07)' };

        let currentGroup = null;
        let currentColor = DEFAULT_COLOR;
        let groupCells = [];

        const flushGroup = () => {
            if (!currentGroup || groupCells.length === 0) return;
            const { accent } = currentColor;
            html += `
            <div style="margin-bottom:20px;border-left:3px solid ${accent};padding-left:12px;">
                <div style="color:${accent};font-size:0.7em;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;">${currentGroup}</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px;">
                    ${groupCells.join('')}
                </div>
            </div>`;
            groupCells = [];
        };

        for (const field of config.displayFields) {
            if (field.group) {
                flushGroup();
                currentGroup = field.group;
                currentColor = GROUP_COLORS[field.group] || DEFAULT_COLOR;
                continue;
            }
            const val = getValue(field.key);
            if (val == null) continue;

            let display;
            if (field.suffix === '%') display = `${Math.round(val)}%`;
            else if (field.decimals != null) display = val.toFixed(field.decimals);
            else display = String(Math.round(val));

            const dot = isFused(field.key)
                ? `<span title="TBA-fused" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#4ade80;margin-left:5px;vertical-align:middle;flex-shrink:0;"></span>`
                : '';

            groupCells.push(`
                <div style="background:${currentColor.bg};border:1px solid rgba(255,255,255,0.04);border-radius:6px;padding:10px;text-align:center;">
                    <div style="color:#94a3b8;font-size:0.65em;margin-bottom:4px;">${field.label}</div>
                    <div style="font-size:1.05em;font-weight:700;display:flex;align-items:center;justify-content:center;">${display}${dot}</div>
                </div>`);
        }
        flushGroup();
    }

    // Per-match detail table
    const teamStr = String(teamNumber);
    const played = teamRows.filter(r => !r.noShow).sort((a, b) => a.matchNumber - b.matchNumber);
    const scoutedNums = new Set(played.map(r => r.matchNumber));

    // TBA matches where this team appears but has no scouting row
    const unscoutedTBA = tbaMatches
        .filter(m => (m.red?.includes(teamStr) || m.blue?.includes(teamStr)) && !scoutedNums.has(m.matchNumber))
        .map(m => ({ matchNumber: m.matchNumber, row: null }));

    const allEntries = [
        ...played.map(r => ({ matchNumber: r.matchNumber, row: r })),
        ...unscoutedTBA,
    ].sort((a, b) => a.matchNumber - b.matchNumber);

    if (allEntries.length > 0) {
        const hasFusedMatches = Object.keys(fusedByMatch).length > 0;

        const _cols = config?.matchBreakdownColumns ?? [];

        // Fused view shows: Auto Fuel | Tele Fuel | Endgame Fuel | Total Fuel.
        // Raw view shows the full _cols set + Endgame position column.
        const fusedFuelCols = [
            ..._cols.filter(c => c.label === 'Auto Fuel' || c.label === 'Tele Fuel'),
            { label: 'Endgame Fuel', fused: f => f.endgameFuelFused ?? null, raw: r => null },
        ];

        const buildMatchRow = (matchNumber, row, mode) => {
            const dupBadge = duplicated.has(matchNumber)
                ? `<span style="color:#ef4444;font-size:0.75em;font-weight:700;margin-left:4px;">2x</span>`
                : '';
            if (!row) {
                const span = mode === 'fused' ? fusedFuelCols.length + 1 : _cols.length + 1;
                return `<tr style="border-bottom:1px solid #1e293b;opacity:0.45;">
                    <td style="text-align:left;padding:4px 8px;color:#60a5fa;white-space:nowrap;">QM ${matchNumber}</td>
                    <td colspan="${span}" style="padding:4px 8px;color:#475569;font-style:italic;white-space:nowrap;">No scouting data</td>
                </tr>`;
            }
            if (mode === 'fused') {
                const f = fusedByMatch[matchNumber];
                const fmt = v => v != null && v > 0 ? v.toFixed(1).replace(/\.0$/, '') : '—';
                if (!f) {
                    return `<tr style="border-bottom:1px solid #1e293b;opacity:0.5;">
                        <td style="text-align:left;padding:4px 8px;color:#60a5fa;white-space:nowrap;">QM ${matchNumber}${dupBadge}</td>
                        ${fusedFuelCols.map(c => { const v = c.raw(row); return `<td style="text-align:right;padding:4px 6px;font-style:italic;white-space:nowrap;">${typeof v === 'number' && v > 0 ? v.toFixed(1).replace(/\.0$/, '') : (v || '—')}</td>`; }).join('')}
                        <td style="text-align:right;padding:4px 6px;color:#475569;font-style:italic;white-space:nowrap;">no TBA</td>
                    </tr>`;
                }
                const totalFuel = (f.autoFuelFused ?? 0) + (f.teleFuelFused ?? 0) + (f.endgameFuelFused ?? 0);
                return `<tr style="border-bottom:1px solid #1e293b;">
                    <td style="text-align:left;padding:4px 8px;color:#60a5fa;white-space:nowrap;">QM ${matchNumber}${dupBadge}</td>
                    ${fusedFuelCols.map(c => `<td style="text-align:right;padding:4px 6px;color:#4ade80;white-space:nowrap;">${fmt(c.fused(f))}</td>`).join('')}
                    <td style="text-align:right;padding:4px 6px;color:#4ade80;font-weight:700;white-space:nowrap;">${fmt(totalFuel)}</td>
                </tr>`;
            }
            // raw mode
            return `<tr style="border-bottom:1px solid #1e293b;">
                <td style="text-align:left;padding:4px 8px;color:#60a5fa;white-space:nowrap;">QM ${matchNumber}${dupBadge}</td>
                ${_cols.map(c => { const v = c.raw(row); return `<td style="text-align:right;padding:4px 6px;white-space:nowrap;">${typeof v === 'number' && v > 0 ? v.toFixed(1).replace(/\.0$/, '') : (v || '—')}</td>`; }).join('')}
                <td style="text-align:right;padding:4px 6px;color:#94a3b8;white-space:nowrap;">${row.endPosition || '—'}</td>
            </tr>`;
        };

        const tableHtml = (mode) => {
            const headers = mode === 'fused'
                ? [...fusedFuelCols.map(c => c.label), 'Total Fuel']
                : [..._cols.map(c => c.label), 'End'];
            return `
            <table style="width:100%;border-collapse:collapse;font-size:0.78em;">
                <thead><tr style="color:#64748b;border-bottom:1px solid #334155;">
                    <th style="text-align:left;padding:4px 8px;white-space:nowrap;">Match</th>
                    ${headers.map(h => `<th style="text-align:right;padding:4px 6px;white-space:nowrap;">${h}</th>`).join('')}
                </tr></thead>
                <tbody>
                ${allEntries.map(({ matchNumber, row }) => buildMatchRow(matchNumber, row, mode)).join('')}
                </tbody>
            </table>`;
        };

        const toggleHtml = hasFusedMatches ? `
            <div style="display:flex;gap:0;border:1px solid #334155;border-radius:5px;overflow:hidden;">
                <button id="scoutMatchToggleFused"
                    onclick="document.getElementById('scoutMatchTableFused').style.display='';document.getElementById('scoutMatchTableRaw').style.display='none';document.getElementById('scoutMatchToggleFused').style.cssText+='background:#1e293b;color:#4ade80;';document.getElementById('scoutMatchToggleRaw').style.cssText+='background:transparent;color:#64748b;';"
                    style="background:#1e293b;color:#4ade80;border:none;padding:4px 12px;font-size:0.72em;cursor:pointer;font-weight:600;">Fused</button>
                <button id="scoutMatchToggleRaw"
                    onclick="document.getElementById('scoutMatchTableRaw').style.display='';document.getElementById('scoutMatchTableFused').style.display='none';document.getElementById('scoutMatchToggleRaw').style.cssText+='background:#1e293b;color:#f8fafc;';document.getElementById('scoutMatchToggleFused').style.cssText+='background:transparent;color:#64748b;';"
                    style="background:transparent;color:#64748b;border:none;padding:4px 12px;font-size:0.72em;cursor:pointer;font-weight:600;">Raw</button>
            </div>` : '';

        html += `
        <div style="margin-bottom:20px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
                <div style="color:#64748b;font-size:0.7em;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">Per-Match Detail</div>
                ${toggleHtml}
            </div>
            <div style="overflow-x:auto;">
                <div id="scoutMatchTableRaw" ${hasFusedMatches ? 'style="display:none;"' : ''}>${tableHtml('raw')}</div>
                ${hasFusedMatches ? `<div id="scoutMatchTableFused">${tableHtml('fused')}</div>` : ''}
            </div>
        </div>`;
    }

    container.innerHTML = html;
}

async function renderTBADetail(teamNumber, tbaTeam) {
    const teamNumStr = teamNumber.toString();
    const oprSection = document.getElementById('tbaDetailStats');
    const tableSection = document.getElementById('matchContributionTable');

    if (!tbaTeam) {
        oprSection.innerHTML = '<p style="color:#64748b; font-style:italic; font-size:0.9em; margin:0;">Run "Sync TBA OPR" to see OPR data.</p>';
        tableSection.innerHTML = '';
        return;
    }

    const allTBATeams = await db.tbaTeams.toArray();
    const allMatches = await db.matches.toArray();
    const allTeamNums = allTBATeams.map(t => t.teamNumber);
    const oprByTeam = Object.fromEntries(allTBATeams.map(t => [t.teamNumber.toString(), t]));
    const globalIgnored = new Set(allMatches.filter(m => m.globallyIgnored).map(m => m.key));
    // Individual ignores for this team (exclude any that are also globally ignored)
    const ignoredKeys = new Set(getTeamIgnoredKeys(tbaTeam).filter(k => !globalIgnored.has(k)));
    // Base OPR computation excludes globally ignored + this team's individually ignored matches.
    const playedMatches = allMatches.filter(m =>
        (m.redScore ?? -1) >= 0 &&
        (m.blueScore ?? -1) >= 0 &&
        !globalIgnored.has(m.key) &&
        !ignoredKeys.has(m.key)
    );

    const teamMatches = allMatches
        .filter(m =>
            (m.red || []).map(String).includes(teamNumStr) ||
            (m.blue || []).map(String).includes(teamNumStr))
        .sort((a, b) => a.matchNumber - b.matchNumber);

    // OPR profile stat grid
    const hasIndivIgnore = ignoredKeys.size > 0 && tbaTeam.adjustedOPR != null;
    const effectiveOPR = hasIndivIgnore ? tbaTeam.adjustedOPR : tbaTeam.opr;
    oprSection.innerHTML = `
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:12px;">
            <div style="background:#1a1a1a; padding:12px; border-radius:6px;">
                <div class="stat-label">OPR</div>
                <div class="stat-value">${effectiveOPR.toFixed(1)}${hasIndivIgnore ? '&thinsp;<span style="color:#fbbf24; font-size:0.65em; font-weight:600;">ADJ</span>' : ''}</div>
            </div>
            <div style="background:#1a1a1a; padding:12px; border-radius:6px;">
                <div class="stat-label">DPR</div>
                <div class="stat-value">${tbaTeam.dpr.toFixed(1)}</div>
            </div>
            <div style="background:#1a1a1a; padding:12px; border-radius:6px;">
                <div class="stat-label">CCWM</div>
                <div class="stat-value" style="color:${tbaTeam.ccwm >= 0 ? '#4ade80' : '#f87171'}">${tbaTeam.ccwm.toFixed(1)}</div>
            </div>
            <div style="background:#1a1a1a; padding:12px; border-radius:6px;">
                <div class="stat-label">Auto OPR</div>
                <div class="stat-value">${tbaTeam.autoOPR != null ? tbaTeam.autoOPR.toFixed(1) : '—'}</div>
            </div>
            <div style="background:#1a1a1a; padding:12px; border-radius:6px;">
                <div class="stat-label">Teleop OPR</div>
                <div class="stat-value">${tbaTeam.teleopOPR != null ? tbaTeam.teleopOPR.toFixed(1) : '—'}</div>
            </div>
            <div style="background:#1a1a1a; padding:12px; border-radius:6px;">
                <div class="stat-label">Endgame OPR</div>
                <div class="stat-value">${tbaTeam.endgameOPR != null ? tbaTeam.endgameOPR.toFixed(1) : '—'}</div>
            </div>
        </div>`;

    // Adjustment banner — list all individually ignored matches
    if (hasIndivIgnore) {
        const labels = [...ignoredKeys].map(k => {
            const m = teamMatches.find(tm => tm.key === k);
            return m ? `Q${m.matchNumber}` : k;
        }).join(', ');
        const scoutActive = !!tbaTeam.scoutingIgnoreActive;
        oprSection.innerHTML += `
            <div style="margin-top:10px; padding:10px 14px; background:#1a1a1a; border-radius:6px; border-left:3px solid #fbbf24; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                <span style="color:#fbbf24; font-size:0.85em;">Ignoring <strong>${labels}</strong> — adjusted OPR: <strong>${tbaTeam.adjustedOPR.toFixed(1)}</strong> (was ${tbaTeam.opr.toFixed(1)})</span>
                <label style="display:flex;align-items:center;gap:6px;color:#94a3b8;font-size:0.82em;cursor:pointer;margin-left:auto;">
                    <input type="checkbox" ${scoutActive ? 'checked' : ''} onchange="setScoutingIgnore(${teamNumber}, this.checked)"
                        style="accent-color:#818cf8;width:14px;height:14px;">
                    Exclude from scouting tab
                </label>
                <button onclick="setIgnoredMatch(${teamNumber}, null)"
                        style="padding:3px 10px; font-size:0.8em; background:#7f1d1d; border:1px solid #ef4444; border-radius:4px; cursor:pointer; color:#fff;">
                    Clear all
                </button>
            </div>`;
    }

    if (teamMatches.length === 0) {
        tableSection.innerHTML = '<p style="color:#64748b; font-style:italic; font-size:0.9em; margin:0;">Run "Sync Schedule" to see match history.</p>';
        return;
    }

    // Compute base OPR locally so LOO deltas are self-consistent regardless of TBA's exact algorithm.
    const teamIdx = allTeamNums.findIndex(n => n.toString() === teamNumStr);
    const baseOPRs = teamIdx !== -1 ? computeLocalOPR(playedMatches, allTeamNums) : null;
    const baseOPR = baseOPRs ? baseOPRs[teamIdx] : null;

    const rows = teamMatches.map(m => {
        const isRed = (m.red || []).map(String).includes(teamNumStr);
        const alliance = isRed ? (m.red || []) : (m.blue || []);
        const score = isRed ? m.redScore : m.blueScore;
        const played = (score ?? -1) >= 0;
        const isGloballyIgnored = globalIgnored.has(m.key);
        const isIndivIgnored    = ignoredKeys.has(m.key);
        const isInActiveSet     = played && !isGloballyIgnored && !isIndivIgnored;

        // Residual only for matches in the active base set.
        const predicted = isInActiveSet
            ? alliance.reduce((s, t) => s + (oprByTeam[String(t)]?.opr || 0), 0)
            : null;
        const residual = isInActiveSet ? score - predicted : null;

        let looOPR = null, impact = null;
        if (played && !isGloballyIgnored && baseOPR != null) {
            // Active rows: LOO = "OPR if this match were also ignored"
            // Ignored rows: LOO = "OPR if this match were restored"
            const subset = isIndivIgnored
                ? [...playedMatches, m]
                : playedMatches.filter(pm => pm.key !== m.key);
            const looResult = computeLocalOPR(subset, allTeamNums);
            if (looResult) {
                looOPR = looResult[teamIdx];
                impact = baseOPR - looOPR;
            }
        }
        return { m, isRed, score, played, isGloballyIgnored, isIndivIgnored, isInActiveSet, predicted, residual, looOPR, impact };
    });

    const fmtSigned = v => v != null ? (v >= 0 ? '+' : '') + v.toFixed(1) : '—';
    const resColor = v => v == null ? 'inherit' : v >= 0 ? '#4ade80' : '#f87171';

    tableSection.innerHTML = `
        <table class="breakdown-table" style="margin-top:0;">
            <thead><tr>
                <th style="text-align:left;">Match</th>
                <th>Alliance</th>
                <th>Score</th>
                <th>OPR Pred.</th>
                <th>Residual</th>
                <th>OPR w/o</th>
                <th>OPR Impact</th>
                <th></th>
            </tr></thead>
            <tbody>
                ${rows.map(r => {
        const isGlobal       = r.isGloballyIgnored;
        const isIndivIgnored = r.isIndivIgnored;
        const rowStyle = isGlobal
            ? 'cursor:pointer; opacity:0.4;'
            : isIndivIgnored
                ? 'cursor:pointer; background:rgba(251,191,36,0.06);'
                : 'cursor:pointer;';
        const matchLabel = isGlobal
            ? `Q${r.m.matchNumber} <span style="color:#f59e0b; font-size:0.7em; font-weight:600;">GLOBAL</span>`
            : isIndivIgnored
                ? `Q${r.m.matchNumber} <span style="color:#fbbf24; font-size:0.7em; font-weight:600;">IGN</span>`
                : `Q${r.m.matchNumber}`;

        let ignoreBtn = '';
        if (isGlobal) {
            ignoreBtn = `<button onclick="event.stopPropagation();setGloballyIgnored('${r.m.key}',false)"
                            style="padding:3px 10px; font-size:0.8em; background:#92400e; border:1px solid #d97706; color:#fde68a; border-radius:4px; cursor:pointer; white-space:nowrap;">
                            Restore Global</button>`;
        } else if (r.played && r.looOPR != null) {
            ignoreBtn = `<button onclick="event.stopPropagation();setIgnoredMatch(${teamNumber}, '${r.m.key}')"
                            style="padding:3px 10px; font-size:0.8em; background:${isIndivIgnored ? '#92400e' : '#1e293b'}; border:1px solid ${isIndivIgnored ? '#d97706' : '#475569'}; color:${isIndivIgnored ? '#fde68a' : '#94a3b8'}; border-radius:4px; cursor:pointer; white-space:nowrap;">
                            ${isIndivIgnored ? 'Restore' : 'Ignore'}</button>`;
        }

        return `<tr onclick="viewMatchDetail('${r.m.key}')" style="${rowStyle}">
                        <td style="text-align:left;">${matchLabel}</td>
                        <td><span style="color:${r.isRed ? '#ef4444' : '#3b82f6'}; font-weight:bold;">${r.isRed ? 'Red' : 'Blue'}</span></td>
                        <td>${r.played ? r.score : '—'}</td>
                        <td>${r.predicted != null ? r.predicted.toFixed(1) : '—'}</td>
                        <td style="color:${resColor(r.residual)}; font-weight:bold;">${r.isInActiveSet ? fmtSigned(r.residual) : '—'}</td>
                        <td style="color:#94a3b8;">${r.looOPR != null ? r.looOPR.toFixed(1) : '—'}</td>
                        <td style="color:${resColor(r.impact)}; font-weight:bold;">${fmtSigned(r.impact)}</td>
                        <td>${ignoreBtn}</td>
                    </tr>`;
    }).join('')}
            </tbody>
        </table>`;
}

// Returns the array of individually-ignored match keys for a tbaTeam record.
// Supports both the legacy single-key field and the new array field.
function getTeamIgnoredKeys(tba) {
    if (!tba) return [];
    if (Array.isArray(tba.ignoredMatchKeys)) return tba.ignoredMatchKeys;
    if (tba.ignoredMatchKey) return [tba.ignoredMatchKey];
    return [];
}

// Re-averages a cached fused result excluding specific match numbers.
// Returns a new result object with recomputed stats, or null if no matches remain.
function refilteredFusedStats(fusedResult, ignoredMatchNums) {
    if (!fusedResult?.available || !fusedResult.fusedByMatch) return fusedResult;
    const filtered = Object.entries(fusedResult.fusedByMatch)
        .filter(([mn]) => !ignoredMatchNums.has(Number(mn)))
        .map(([, v]) => v);
    if (filtered.length === 0) return null;
    const allKeys = Object.keys(filtered[0] ?? {});
    const stats = {};
    for (const key of allKeys) {
        const vals = filtered.map(f => f[key]).filter(v => v != null);
        stats[key] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    return { ...fusedResult, stats };
}

async function refreshEPADisplays(teamNumber) {
    await Promise.all([
        displayTeams(),
        displayTBATeams(),
        displayScoutingTeams(),
        renderAtAGlance(),
        renderPickList(),
        renderDraft(),
        teamNumber != null ? renderTBADetail(String(teamNumber), activeTBAData) : Promise.resolve(),
        teamNumber != null ? renderScoutingTab(String(teamNumber))               : Promise.resolve(),
        teamNumber != null && activeTeamData
            ? renderOverview(activeTeamData, activeTBAData) : Promise.resolve(),
    ]);
}

// Toggle a match key in/out of a team's individual ignore list.
// matchKey === null clears all ignored keys.
window.setIgnoredMatch = async function (teamNumber, matchKey) {
    const pk = parseInt(teamNumber);
    const current = await db.tbaTeams.get(pk);
    let keys = getTeamIgnoredKeys(current);

    if (matchKey === null) {
        keys = [];
    } else if (keys.includes(matchKey)) {
        keys = keys.filter(k => k !== matchKey);
    } else {
        keys = [...keys, matchKey];
    }

    let adjustedOPR = null;
    if (keys.length > 0) {
        const allTBATeams = await db.tbaTeams.toArray();
        const allMatches  = await db.matches.toArray();
        const allTeamNums = allTBATeams.map(t => t.teamNumber);
        const globalIgnored = new Set(allMatches.filter(m => m.globallyIgnored).map(m => m.key));
        const keySet = new Set(keys);
        const subset = allMatches.filter(m =>
            (m.redScore ?? -1) >= 0 && (m.blueScore ?? -1) >= 0 &&
            !globalIgnored.has(m.key) && !keySet.has(m.key)
        );
        const result = computeLocalOPR(subset, allTeamNums);
        const idx = allTeamNums.findIndex(n => n === pk);
        if (result && idx !== -1) adjustedOPR = result[idx];
    }

    await db.tbaTeams.update(pk, {
        ignoredMatchKeys: keys.length > 0 ? keys : null,
        ignoredMatchKey:  null,
        adjustedOPR:      keys.length > 0 ? adjustedOPR : null,
    });
    activeTBAData = await db.tbaTeams.get(pk);
    await refreshEPADisplays(teamNumber);
};

window.setScoutingIgnore = async function (teamNumber, active) {
    const pk = parseInt(teamNumber);
    await db.tbaTeams.update(pk, { scoutingIgnoreActive: active || null });
    activeTBAData = await db.tbaTeams.get(pk);
    await refreshEPADisplays(teamNumber);
};

function renderChart(team) {
    const ctx = document.getElementById('performanceChart').getContext('2d');
    if (performanceChart) performanceChart.destroy();

    const playedMatches = team.rawStatboticsData.filter(m => m.epa?.post);
    const epaData = playedMatches.map(m => m.epa.post);
    const eventLabels = playedMatches.map(m => m.event);

    const isMobile = document.body.classList.contains('mobile-ui');
    const datasets = [{
        label: 'Match EPA',
        data: epaData,
        showLine: false,
        pointRadius: isMobile ? 2.5 : 5,
        pointHoverRadius: isMobile ? 4 : 7,
        pointBackgroundColor: eventLabels.map(ev => getEventColor(ev)),
        pointBorderColor: eventLabels.map(ev => getEventColor(ev))
    }];

    if (team.analysis && team.analysis.rawParams) {
        const trendData = new Array(epaData.length).fill(null);
        const { A, B, k } = team.analysis.rawParams;
        const startIndex = team.analysis.startIndex;

        // How many matches are in our specific selection?
        const selectionLength = team.analysis.rawParams.n;

        // We use x = i + 1 to match the new "Preferred" math engine
        for (let i = 0; i < selectionLength; i++) {
            const x = i + 1;
            const y = A - B * Math.exp(-k * x);
            trendData[startIndex + i] = y;
        }

        datasets.push({
            label: 'Projected Ceiling (Range)',
            data: trendData,
            borderColor: '#4ade80',
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false,
            spanGaps: false // Keeps the line strictly within the range
        });
    }

    performanceChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: epaData.map((_, i) => `M${i + 1}`),
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { bottom: 8 } },
            plugins: {
                legend: {
                    labels: {
                        // Custom legend to show event colors
                        generateLabels: (chart) => {
                            const playedMatches = team.rawStatboticsData.filter(m => m.epa?.post);
                            const uniqueEvents = [...new Set(playedMatches.map(m => m.event))];

                            return uniqueEvents.map(ev => ({
                                text: ev.toUpperCase(),
                                fillStyle: getEventColor(ev),
                                strokeStyle: getEventColor(ev),
                                lineWidth: 0,
                                // Some versions of Chart.js require explicit fontColor here
                                fontColor: '#f8fafc'
                            }));
                        }
                    }
                }
            },
            scales: {
                y: { grid: { color: '#333' }, ticks: { color: '#aaa' } },
                x: { grid: { display: false }, ticks: { color: '#aaa' } }
            }
        }
    });
}

// Helper to generate the trendline points
function calculateTrendLine(params, length) {
    if (!params) return [];
    const { A, B, k } = params;
    return Array.from({ length }, (_, i) => {
        const xScaled = i / (length - 1);
        return A - B * Math.exp(-k * xScaled);
    });
}


// Global color map to keep event colors consistent across the app
const eventColorCache = {};
const palette = ['#3b82f6', '#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4'];

function getEventColor(eventKey) {
    if (!eventColorCache[eventKey]) {
        // If we haven't seen this event yet, pick the next color from the palette
        const index = Object.keys(eventColorCache).length % palette.length;
        eventColorCache[eventKey] = palette[index];
    }
    return eventColorCache[eventKey];
}


// Bottom of main.js - The App Bootloader
const bootApp = async () => {

    // At the top of bootApp
    const savedKey = localStorage.getItem('lastEventKey');
    if (savedKey) {
        document.getElementById('eventKeyInput').value = savedKey;
        updateAppEventKey(savedKey);
    } else {
        showEventSelector();
    }

    renderScoutingSection();

    // Re-render scouting section and check for public archive whenever the event key changes
    document.getElementById('eventKeyInput')?.addEventListener('input', () => {
        renderScoutingSection();
        const eventKey = document.getElementById('eventKeyInput').value.trim().toLowerCase();
        updateAppEventKey(eventKey || null);
        clearTimeout(_archiveCheckTimer);
        document.getElementById('archiveHint').innerHTML = '';
        _archiveCheckTimer = setTimeout(() => checkEventArchive(eventKey), 500);
    });

    // Restore sync timestamps and OBE indicators
    for (const key of ['statboticsLive', 'tbaOPR', 'tbaMatches']) {
        const saved = localStorage.getItem(`lastSync_${key}`);
        const el = document.getElementById(`ts-${key}`);
        if (saved && el) el.textContent = `Last sync: ${saved}`;
    }
    updateOBEStatus(localStorage.getItem('lastEventKey'));

    // 1. Set the initial view (Home)
    initUIMode();
    initColorMode();
    initNotifications();
    setInterval(updateBannerTick, 1000);
    window.switchView('homeView');

    // 2. Load the cached data into the tables immediately
    // This ensures that when you click 'Statbotics' or 'Schedule', 
    // the data is already waiting for you.
    try {
        await displayTeams();        // Loads Statbotics cache
        await displaySchedule();     // Loads TBA Schedule cache
        await updateHomeBanner();
        await displayTBATeams();     // Loads TBA OPR cache
        await renderAtAGlance();     // Loads at-a-glance overview
        console.log("Local cache successfully loaded into UI.");
    } catch (err) {
        console.warn("No cached data found to load yet.");
    }

    await checkAdjustmentsFromURL();
};

bootApp();

// Automatically set the view to 'homeView' when the script finishes loading
document.addEventListener('DOMContentLoaded', () => {
    const homeBtn = document.querySelector('.nav-btn'); // Grabs the first button (Home)
    switchView('homeView', homeBtn);
});

// Initialize the view once the script is ready
const homeBtn = document.querySelector('.nav-btn');
window.switchView('homeView', homeBtn);

document.getElementById('eventKeyInput').value = localStorage.getItem('lastEventKey') || '';
checkEventArchive(document.getElementById('eventKeyInput').value.trim().toLowerCase());

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => { });
}






