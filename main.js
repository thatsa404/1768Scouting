import Dexie from 'dexie';
import Chart from 'chart.js/auto';

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


window.currentFocusedTeam = null;

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

    matches.forEach(m => {
        const redWon  = m.redScore > -1 && m.redScore > m.blueScore;
        const blueWon = m.redScore > -1 && m.blueScore > m.redScore;
        const hasVideo = m.videos && m.videos.length > 0;
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
                : `<td rowspan="2" style="color:#64748b;font-style:italic;border-left:2px solid #334155;vertical-align:middle;text-align:center;white-space:nowrap;min-width:2.8rem;">—</td>`;

            const mobileCountdown = m.redScore <= -1 && m.predictedTime
                ? `<div data-predicted-time="${m.predictedTime}" style="font-size:0.65em;color:#64748b;margin-top:2px;"></div>`
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
                : `<td style="color:#64748b;font-style:italic;border-left:2px solid #334155;">Upcoming</td>`;
            const desktopCountdown = m.redScore <= -1 && m.predictedTime
                ? `<div data-predicted-time="${m.predictedTime}" style="font-size:0.65em;color:#64748b;margin-top:2px;"></div>`
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
};

let prepChartInstance = null; // Global variable to handle chart destruction

const rightPanelHistory = [];

let _scheduleCountdownInterval = null;

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
    });
}

window.viewMatchPrep = async function (matchKey) {
    const match = await db.matches.get(matchKey);
    if (!match) return;

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
            <div class="prep-card-header">
                <div class="header-left" onclick="highlightTeam('${teamNum}')" style="cursor:pointer;">
                    <span class="prep-team-number">${teamNum}</span>
                </div>
                ${tierBadge(tier, 'prep-tier-badge', 'Tier')}
            </div>

            <div class="prep-stats-grid" onclick="highlightTeam('${teamNum}')" style="cursor:pointer;">
                <div><div class="stat-label">Total EPA</div><div class="stat-value">${team.currentEPA.toFixed(1)}</div></div>
                <div><div class="stat-label">Auto</div><div class="stat-value">${team.autoEPA.toFixed(1)}</div></div>
                <div><div class="stat-label">Teleop</div><div class="stat-value">${team.teleopEPA.toFixed(1)}</div></div>
                <div><div class="stat-label">Endgame</div><div class="stat-value">${team.endgameEPA.toFixed(1)}</div></div>
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
        const redEndgame = (rbd.hubScore?.endgamePoints || 0) + (rbd.endGameTowerPoints || 0);
        const blueEndgame = (bbd.hubScore?.endgamePoints || 0) + (bbd.endGameTowerPoints || 0);

        // Match-result RP: 3 win / 1 tie / 0 loss
        const redResultRP = redWon ? 3 : match.redScore === match.blueScore ? 1 : 0;
        const blueResultRP = blueWon ? 3 : match.redScore === match.blueScore ? 1 : 0;

        const bonusFields = [
            ['Energized RP', 'energizedAchieved'],
            ['Supercharged RP', 'superchargedAchieved'],
            ['Traversal RP', 'traversalAchieved'],
        ];
        const check = val => val ? `<span style="color:#4ade80;">✓</span>` : `<span style="color:#475569;">✗</span>`;

        const totalRedRP = rbd.rp ?? (redResultRP + bonusFields.reduce((s, [, f]) => s + (rbd[f] ? 1 : 0), 0));
        const totalBlueRP = bbd.rp ?? (blueResultRP + bonusFields.reduce((s, [, f]) => s + (bbd[f] ? 1 : 0), 0));

        const scoreRows = [
            ['Auto', rbd.totalAutoPoints, bbd.totalAutoPoints],
            ['Teleop', rbd.totalTeleopPoints, bbd.totalTeleopPoints],
            ['Endgame', redEndgame, blueEndgame],
            ['Fouls Earned', rbd.foulPoints, bbd.foulPoints],
        ];
        const rpRows = [
            ['Match Result', redResultRP, blueResultRP],
            ...bonusFields.map(([label, field]) => [label, rbd[field], bbd[field]]),
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
        videoSection.innerHTML = `<p style="color:#64748b; font-style:italic; font-size:0.85em; margin:0;">No match video available.</p>`;
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

    if (document.body.classList.contains('split-ui')) {
        pushCurrentRightPanel();
    }
    document.getElementById('matchDetailView').style.display = 'flex';
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
    const lines = allNoteDisplayLines(teamNum);
    const hasGeneral = !!getTeamNote(teamNum, null)?.text;
    if (lines.length) {
        section.innerHTML = `<div style="background:#1e293b;padding:14px;border-radius:8px;border:1px solid #334155;color:#cbd5e1;font-size:0.9em;line-height:1.5;white-space:pre-wrap;">${lines.join('\n')}</div>
            <button onclick="showOverviewNoteEditor(${teamNum})" style="margin-top:8px;background:#334155;color:#f8fafc;border:none;border-radius:6px;padding:6px 14px;font-size:0.82em;font-weight:600;cursor:pointer;">${hasGeneral ? 'Edit General Note' : 'Add General Note'}</button>`;
    } else {
        section.innerHTML = `<div style="background:#1e293b;padding:16px;border-radius:8px;border:1px dashed #334155;display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <p style="color:#475569;font-style:italic;margin:0;font-size:0.9em;">No notes yet.</p>
            <button onclick="showOverviewNoteEditor(${teamNum})" style="background:#334155;color:#f8fafc;border:none;border-radius:6px;padding:6px 14px;font-size:0.82em;font-weight:600;cursor:pointer;white-space:nowrap;">Add Note</button>
        </div>`;
    }
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

async function processTeamPerformance(teamNumber, eventKey, force = false) {
    const year = eventKey.slice(0, 4);

    // 1. Check local DB
    const cachedTeam = await db.teams.get(teamNumber);

    // --- FIX 1: Fetch the Name correctly ---
    const nameResp = await fetch(`https://api.statbotics.io/v3/team/${teamNumber}`);
    const nameData = await nameResp.json();
    const teamName = nameData.name || "Unknown Team";

    // 2. Handshake (team_year)
    const summaryResp = await fetch(`https://api.statbotics.io/v3/team_year/${teamNumber}/${year}`);
    const summary = await summaryResp.json();
    const apiMatchCount = summary.count || summary.data?.count || 0;

    console.log(`Team ${teamNumber}: Local Count ${cachedTeam?.matchCount || 0}, API Count ${apiMatchCount}`);
    console.log(`Raw Summary Data for ${teamNumber}:`, summary);

    // --- NEW: Grab the breakdowns from the summary ---
    const autoEPA = summary.epa?.breakdown?.auto_points || 0;
    const teleopEPA = summary.epa?.breakdown?.teleop_points || 0;
    const endgameEPA = summary.epa?.breakdown?.endgame_points || 0;

    // 3. REVISED LOGIC: Only skip if we have a cache AND the counts match AND force is false
    const needsUpdate = force || !cachedTeam || cachedTeam.matchCount !== apiMatchCount;

    if (!needsUpdate) {
        // --- THE CACHE HEALER ---
        // Even if we are skipping the full match history deep dive, 
        // we can silently patch the existing database with the new breakdown 
        // stats we just fetched in the handshake.
        await db.teams.update(teamNumber, {
            autoEPA: autoEPA,
            teleopEPA: teleopEPA,
            endgameEPA: endgameEPA
        });

        console.log(`-> Skipping deep dive for ${teamNumber}, but updated summary stats.`);
        return null;
    }

    // 4. THE DEEP DIVE
    console.log(`-> Fetching full matches for ${teamNumber}...`);
    const fullMatchData = await getMatchHistory(teamNumber, year);

    if (!fullMatchData || fullMatchData.length === 0) {
        console.warn(`-> No match data found for ${teamNumber}`);
        return null;
    }

    const playedMatches = fullMatchData.filter(m => m.status === 'Completed' && m.epa?.post);
    const currentEPA = playedMatches.length > 0 ? playedMatches[playedMatches.length - 1].epa.post : 0;

    await db.teams.put({
        teamNumber: teamNumber,
        teamName: teamName,
        eventKey: eventKey,
        matchCount: apiMatchCount,
        currentEPA: currentEPA,
        autoEPA: autoEPA,       // Saved!
        teleopEPA: teleopEPA,   // Saved!
        endgameEPA: endgameEPA, // Saved!
        rawStatboticsData: fullMatchData,
        analysis: cachedTeam?.analysis || null,
        lastUpdated: Date.now()
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

    if (!eventKey) {
        alert("Please enter a valid Event Key first!");
        return;
    }

    localStorage.setItem('lastEventKey', eventKey);

    const statusDiv = document.getElementById('status');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');

    statusDiv.innerText = `Fetching team list for ${eventKey}...`;

    // 1. Get the list of teams at the event
    const eventResp = await fetch(`https://api.statbotics.io/v3/events/${eventKey}`);
    const eventData = await eventResp.json();

    // Statbotics v3 might return the teams array differently, adjust if needed
    // Usually it requires fetching /teams?event={eventKey} but assuming you have this part working:
    const teamsResp = await fetch(`https://api.statbotics.io/v3/team_events?event=${eventKey}`);
    const teamsData = await teamsResp.json();
    const teamsList = teamsData.data || teamsData.results || teamsData;

    if (!teamsList || teamsList.length === 0) {
        statusDiv.innerText = "❌ No teams found for this event.";
        return;
    }

    const totalTeams = teamsList.length;

    // 2. Show the progress bar
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';

    // 3. The Sync Loop
    for (let i = 0; i < totalTeams; i++) {
        const teamNumber = teamsList[i].team;

        // Update text
        statusDiv.innerText = `Syncing Team ${teamNumber} (${i + 1}/${totalTeams})...`;

        // Process the team
        await processTeamPerformance(teamNumber, eventKey);

        // Update the bar width
        const percentComplete = ((i + 1) / totalTeams) * 100;
        progressBar.style.width = `${percentComplete}%`;

        displayTeams();
    }

    // 4. Wrap it up
    statusDiv.innerText = `✅ Sync Complete! Loaded ${totalTeams} teams.`;

    // Optional: Hide the bar after a second, or turn it green
    progressBar.style.background = '#10b981'; // Turn it green
    setTimeout(() => {
        progressContainer.style.display = 'none';
        progressBar.style.background = '#3b82f6'; // Reset color for next time
    }, 2000);

    // Finally, redraw the table
    displayTeams();
}

window.syncStatboticsLive = async function () {
    const eventKey = document.getElementById('eventKeyInput')?.value.trim().toLowerCase();
    if (!eventKey) { alert('Enter an Event Key first.'); return; }

    const statusDiv = document.getElementById('status');
    statusDiv.textContent = 'Fetching live Statbotics match data…';

    // One call for all team-matches at the event
    const resp = await fetch(`https://api.statbotics.io/v3/team_matches?event=${eventKey}&limit=1000`);
    const json = await resp.json();
    const eventMatches = json.data || json.results || json;

    if (!Array.isArray(eventMatches) || !eventMatches.length) {
        statusDiv.textContent = 'No Statbotics match data returned for this event.';
        return;
    }

    // Group by team number
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

        await db.teams.update(tn, { currentEPA: latestEPA, rawStatboticsData: merged });
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
            videos: (m.videos || []).filter(v => v.type === 'youtube').map(v => v.key),
        })));

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






window.clearCache = async function () {
    if (!confirm("Are you sure you want to clear all cached team data? This cannot be undone.")) {
        return;
    }

    try {
        await db.teams.clear();
        await db.tbaTeams.clear();
        await db.matches.clear();

        // Clear persisted sync state
        localStorage.removeItem('lastEventKey');
        localStorage.removeItem('pickListOrder');
        localStorage.removeItem('draftState');
        for (const key of ['statboticsLive', 'tbaOPR', 'tbaMatches']) {
            localStorage.removeItem(`lastSync_${key}`);
            const el = document.getElementById(`ts-${key}`);
            if (el) el.textContent = '';
        }

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

    // Refresh the main table in the background
    displayTeams();

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




let teamChartInstance = null;

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
        row.onclick = () => viewTeamDetail(team.teamNumber);

        // Notice we removed the onclick="" from the <td> string
        row.innerHTML = `
            <td>${tierBadge(tier)}</td>
            <td><strong>${team.teamNumber}</strong></td>
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
            videos: (m.videos || []).filter(v => v.type === 'youtube').map(v => v.key),
        }));
        await db.matches.bulkPut(records);

        setSyncTimestamp('tbaMatches');
        statusDiv.innerText = `✅ TBA Matches synced (${records.length} qual matches).`;
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
        if (t.ignoredMatchKey && t.adjustedOPR != null && !globalIgnored.has(t.ignoredMatchKey))
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
        row.onclick = () => viewTeamDetail(team.teamNumber);
        const oprCell = team.ignoredMatchKey
            ? `${eff.toFixed(1)}&thinsp;<span style="color:#fbbf24; font-size:0.7em; font-weight:600;">LOO</span>`
            : eff.toFixed(1);
        row.innerHTML = `
            <td>${tierBadge(tier)}</td>
            <td><strong>${team.teamNumber}</strong></td>
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
        document.getElementById(`home-tab-${t}`).style.display = t === tab ? 'block' : 'none';
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

async function renderAtAGlance() {
    const statusEl = document.getElementById('atAGlanceStatus');
    const table = document.getElementById('atAGlanceTable');
    const tbody = document.getElementById('atAGlanceBody');
    if (!statusEl || !table || !tbody) return;

    const [allTeams, allTBATeams, allMatches] = await Promise.all([
        db.teams.toArray(), db.tbaTeams.toArray(), db.matches.toArray()
    ]);

    if (!allTeams.length) {
        statusEl.textContent = 'No team data — sync Statbotics first.';
        table.style.display = 'none';
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
        if (tba.ignoredMatchKey && tba.adjustedOPR != null && !globalIgnored.has(tba.ignoredMatchKey))
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

    // ── Build rows ────────────────────────────────────────────────────────────
    const rows = allTeams.map(team => {
        const tn = parseInt(team.teamNumber);
        const tba = tbaTeamMap[tn];
        const rp = rpMap[String(tn)] || { rp: 0, played: 0, wins: 0, ties: 0, losses: 0 };
        const opr = effOPR(tba);
        const analysis = team.analysis || {};
        const hasCeil = analysis.ceiling != null && analysis.ceiling !== '—';
        const epaVal = hasCeil ? parseFloat(analysis.ceiling) : (team.currentEPA || 0);
        const hasLOO = tba?.ignoredMatchKey && tba.adjustedOPR != null && !globalIgnored.has(tba.ignoredMatchKey);
        const hasAdj = !hasLOO && globalOPRMap != null;
        return { team, tba, rp, opr, epaVal, hasCeil, hasLOO, hasAdj };
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
        const hasAnyOPR = rows.some(r => r.opr != null);
        const composite = r => {
            const ep = pctRank(epaVals, r.epaVal);
            if (!hasAnyOPR) return ep;
            return (ep + pctRank(oprVals, r.opr ?? 0)) / 2;
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
            case 'composite': va = -a.composite; vb = -b.composite; break;
            default: va = a.rp.rp; vb = b.rp.rp; break;
        }
        return (vb - va) * glanceSortOrder || avgScore(b.rp) - avgScore(a.rp) || (b.epaVal - a.epaVal);
    });

    // Compute RP-based rank separately so it stays stable regardless of current sort
    const rpRank = Object.fromEntries(
        [...rows].sort((a, b) => b.rp.rp - a.rp.rp || avgScore(b.rp) - avgScore(a.rp) || b.epaVal - a.epaVal)
            .map((r, i) => [r.team.teamNumber, i + 1])
    );
    const TIER = TIER_STYLE;

    table.style.display = 'table';
    tbody.innerHTML = rows.map(r => {
        const { team, rp, opr, epaVal, hasCeil, hasLOO, hasAdj, composite } = r;
        const rank = hasRP ? rpRank[team.teamNumber] : '—';
        const record = hasRP ? `${rp.wins}–${rp.losses}${rp.ties ? `–${rp.ties}` : ''}` : null;
        const rpStr = hasRP ? rp.rp : '—';
        const compStr = composite != null ? ((1 - composite) * 100).toFixed(1) : '—';
        const epaStr = epaVal.toFixed(1);
        const ceilBadge = hasCeil
            ? `<span style="color:#4ade80; font-size:0.65em; font-weight:600; margin-left:3px;">CEIL</span>` : '';
        const oprStr = opr != null ? opr.toFixed(1) : '—';
        const oprBadge = hasLOO
            ? `<span style="color:#fbbf24; font-size:0.65em; font-weight:600; margin-left:3px;">LOO</span>`
            : hasAdj
                ? `<span style="color:#f97316; font-size:0.65em; font-weight:600; margin-left:3px;">ADJ</span>`
                : '';

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
            <strong style="color:#f8fafc;">${team.teamNumber}</strong>
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
        </tr>`;
    }).join('');

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
    const allTBATeams = await db.tbaTeams.toArray();
    const allMatches = await db.matches.toArray();
    if (!allTBATeams.length) return null;

    const allTeamNums = allTBATeams.map(t => t.teamNumber);
    const globalIgnored = new Set(allMatches.filter(m => m.globallyIgnored).map(m => m.key));
    const allPlayed = allMatches.filter(m => (m.redScore ?? -1) >= 0 && (m.blueScore ?? -1) >= 0);
    const activePlayed = allPlayed.filter(m => !globalIgnored.has(m.key));

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

    // When globally ignoring a match, clear any individual ignores of that same match.
    if (ignored) {
        const affected = await db.tbaTeams.filter(t => t.ignoredMatchKey === matchKey).toArray();
        if (affected.length > 0) {
            await Promise.all(affected.map(t =>
                db.tbaTeams.update(t.teamNumber, { ignoredMatchKey: null, adjustedOPR: null })
            ));
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

window.viewTeamDetail = async function (teamNumber) {
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
    switchDetailTab('overview');

    window.switchView('teamDetailView');
    pushNavState('teamDetail');
};

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
    if (document.getElementById('photoLightbox').style.display !== 'none') {
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

window.switchView = function (viewId, btn) {
    // In split mode, showing the team detail uses pushCurrentRightPanel to save
    // whatever is open (including matchPrepView) — handle it first, before the
    // prep-close block below would interfere.
    if (document.body.classList.contains('split-ui') && viewId === 'teamDetailView') {
        pushCurrentRightPanel();
        window.previousView = window.currentView;
        document.getElementById('teamDetailView').style.display = 'block';
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
        next.style.display = 'block';
        window.currentView = viewId;
    }

    // 4. Sync all nav items (top-nav and mobile bottom nav) by data-view attribute
    const MAIN_VIEWS = new Set(['homeView', 'scheduleView', 'analysisView', 'toolsView']);
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

let currentAnalysisTab = 'statbotics';
window.switchAnalysisTab = function (tab) {
    currentAnalysisTab = tab;
    ['statbotics', 'tba', 'scouting'].forEach(t => {
        document.getElementById(`analysis-tab-${t}`).style.display = t === tab ? 'block' : 'none';
    });
    document.querySelectorAll('#analysisTabs .detail-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['statbotics', 'tba', 'scouting'][i] === tab);
    });
};

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
    ['picklist', 'draft'].forEach(t => {
        document.getElementById(`tools-tab-${t}`).style.display = t === tab ? 'block' : 'none';
    });
    document.querySelectorAll('#toolsTabs .detail-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', ['picklist', 'draft'][i] === tab);
    });
    if (tab === 'picklist') renderPickList();
    if (tab === 'draft') renderDraft();
};

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
        if (statusEl) statusEl.textContent = 'No team data — sync Statbotics first.';
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
        if (tba.ignoredMatchKey && tba.adjustedOPR != null && !globalIgnored.has(tba.ignoredMatchKey))
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
            if (!rpMap[team]) rpMap[team] = { rp: 0, wins: 0, ties: 0, losses: 0 };
            rpMap[team].rp += redRP;
            if (redWon) rpMap[team].wins++; else if (tie) rpMap[team].ties++; else rpMap[team].losses++;
        }
        for (const team of (m.blue || [])) {
            if (!rpMap[team]) rpMap[team] = { rp: 0, wins: 0, ties: 0, losses: 0 };
            rpMap[team].rp += blueRP;
            if (blueWon) rpMap[team].wins++; else if (tie) rpMap[team].ties++; else rpMap[team].losses++;
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
        const hasLOO = tba?.ignoredMatchKey && tba.adjustedOPR != null && !globalIgnored.has(tba.ignoredMatchKey);
        const hasAdj = !hasLOO && globalOPRMap != null;
        return { team, rp, opr, epaVal, hasCeil, hasLOO, hasAdj };
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
        const hasAnyOPR = rows.some(r => r.opr != null);
        const composite = r => {
            const ep = pctRank(epaVals, r.epaVal);
            return hasAnyOPR ? (ep + pctRank(oprVals, r.opr ?? 0)) / 2 : ep;
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
                case 'epa': return r.epaVal;
                case 'opr': return r.opr ?? -999;
                case 'rp':  return r.rp.rp;
                default:    return (1 - r.composite) * 100;
            }
        };
        unranked.sort((a, b) => (getValue(b) - getValue(a)) * pickListSortDir);
        rows = [...ranked, ...unranked];
    }

    // Rebuild thead with sort arrows
    const arrowFor = col => {
        if (pickListSortCol !== col) return `<span style="opacity:0.3"> ↕</span>`;
        return pickListSortDir === 1 ? ' ↓' : ' ↑';
    };
    const th = (label, col, extra = '') =>
        `<th style="padding:10px 8px;border-bottom:2px solid #334155;color:#94a3b8;text-align:center;cursor:pointer;${extra}" onclick="sortPickListBy('${col}')">${label}${arrowFor(col)}</th>`;
    table.querySelector('thead').innerHTML = `<tr>
        <th style="width:28px;padding:10px 4px;border-bottom:2px solid #334155;"></th>
        <th style="width:56px;padding:10px 8px;border-bottom:2px solid #334155;color:#94a3b8;text-align:center;">#</th>
        <th style="padding:10px 8px;border-bottom:2px solid #334155;color:#94a3b8;text-align:left;">Team</th>
        <th style="padding:10px 8px;border-bottom:2px solid #334155;color:#94a3b8;text-align:left;">Name</th>
        ${th('Score', 'composite')}
        ${th('RP', 'rp')}
        ${th('EPA / Ceil', 'epa')}
        ${th('OPR', 'opr')}
        <th style="width:60px;padding:10px 8px;border-bottom:2px solid #334155;"></th>
    </tr>`;

    // RP rank (1 = most RP) for top-10 badge
    const rpRankMap = {};
    if (hasRP) {
        Object.entries(rpMap)
            .sort(([, a], [, b]) => b.rp - a.rp)
            .forEach(([tn,], i) => { rpRankMap[tn] = i + 1; });
    }

    const TIER = TIER_STYLE;

    table.style.display = 'table';
    let pickPos = 1;
    tbody.innerHTML = rows.map(r => {
        if (r.separator) {
            return `<tr data-separator="true" style="user-select:none;">
                <td colspan="9" class="drag-handle"
                    style="padding:9px 20px;border-top:2px dashed #334155;border-bottom:2px dashed #334155;background:#080d16;text-align:center;cursor:grab;touch-action:none;color:#475569;font-size:0.8rem;font-weight:700;letter-spacing:0.06em;">
                    ⠿ &nbsp; drag to reposition &nbsp;·&nbsp; unranked below &nbsp; ⠿
                </td>
            </tr>`;
        }
        const rowPos = pickPos++;
        const { team, rp, opr, epaVal, hasCeil, hasLOO, hasAdj } = r;
        const ts = TIER[r.tier];
        const record = hasRP ? `${rp.wins}–${rp.losses}${rp.ties ? `–${rp.ties}` : ''}` : null;
        const compStr = ((1 - r.composite) * 100).toFixed(1);
        const ceilBadge = hasCeil ? `<span style="color:#4ade80;font-size:0.65em;font-weight:600;margin-left:3px;">CEIL</span>` : '';
        const oprBadge = hasLOO
            ? `<span style="color:#fbbf24;font-size:0.65em;font-weight:600;margin-left:3px;">LOO</span>`
            : hasAdj ? `<span style="color:#f97316;font-size:0.65em;font-weight:600;margin-left:3px;">ADJ</span>` : '';
        const td = (content, center = true) =>
            `<td style="padding:13px 10px;border-bottom:1px solid #1e293b;${center ? ' text-align:center;' : ''}">${content}</td>`;

        return `<tr data-team="${team.teamNumber}" style="background:${ts.bg};">
            <td class="drag-handle" style="padding:10px 6px;border-bottom:1px solid #1e293b;text-align:center;cursor:grab;touch-action:none;box-shadow:inset 3px 0 0 ${ts.color};">
                <span style="color:#475569;font-size:1.2em;line-height:1;">⠿</span>
            </td>
            <td style="padding:10px 8px;border-bottom:1px solid #1e293b;text-align:center;">
                <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
                    <span class="pick-pos" style="color:#64748b;font-weight:700;">${rowPos}</span>
                    <span style="color:${ts.color};font-size:0.75em;font-weight:800;letter-spacing:0.08em;">${r.tier}</span>
                </div>
            </td>
            <td style="padding:13px 10px;border-bottom:1px solid #1e293b;cursor:pointer;white-space:nowrap;" onclick="viewTeamDetail(${team.teamNumber})">
                <strong style="color:#f8fafc;">${team.teamNumber}</strong>
            </td>
            <td style="padding:13px 10px;border-bottom:1px solid #1e293b;cursor:pointer;" onclick="viewTeamDetail(${team.teamNumber})">
                <span style="color:#94a3b8;font-size:0.85em;font-weight:600;">${team.teamName || ''}</span>
            </td>
            ${td(`<span style="color:${ts.color};">${compStr}</span>`)}
            ${(() => {
                const rpRank = rpRankMap[String(team.teamNumber)];
                const rankBadge = rpRank != null && rpRank <= 10
                    ? `<div style="color:#94a3b8;font-size:0.72em;font-weight:700;margin-top:2px;">#${rpRank}</div>` : '';
                return td(`${hasRP ? rp.rp : '—'}${rankBadge}`);
            })()}
            ${td(`${epaVal.toFixed(1)}${ceilBadge}`)}
            ${td(hasOPR ? `${opr != null ? opr.toFixed(1) : '—'}${oprBadge}` : '—')}
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

function loadDraftState() {
    try { const s = JSON.parse(localStorage.getItem('draftState')); if (s?.alliances?.length === 8) return s; } catch { }
    return null;
}
function saveDraftState(s) { localStorage.setItem('draftState', JSON.stringify(s)); }
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

window.resetDraft = function () {
    draftHistory = [];
    localStorage.removeItem('draftState');
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

async function renderDraft() {
    const allianceBody = document.getElementById('draftAllianceBody');
    const pickPanel = document.getElementById('draftPickPanel');
    const statusEl = document.getElementById('draftStatus');
    if (!allianceBody || !pickPanel) return;

    const [allTeams, allMatches] = await Promise.all([db.teams.toArray(), db.matches.toArray()]);

    if (!allTeams.length) {
        if (statusEl) statusEl.textContent = 'No team data — sync Statbotics first.';
        allianceBody.innerHTML = '';
        pickPanel.innerHTML = '<p style="color:#64748b;font-size:0.9em;padding:12px;">No data.</p>';
        return;
    }

    const teamInfoMap = Object.fromEntries(allTeams.map(t => [String(t.teamNumber), t]));

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

    // Quick tier by EPA rank (for pick panel color coding)
    const sortedByEPA = allTeams.slice().sort((a, b) => (b.currentEPA || 0) - (a.currentEPA || 0));
    const epaRankOf = Object.fromEntries(sortedByEPA.map((t, i) => [String(t.teamNumber), i]));
    const quickTier = tn => { const r = epaRankOf[tn] ?? 99; return r < 8 ? 'S' : r < 20 ? 'A' : r < 32 ? 'B' : 'C'; };
    const TIER_CLR = { S: '#f59e0b', A: '#4ade80', B: '#a855f7', C: '#64748b' };

    // Load/init state; auto-fill first captain
    let state = loadDraftState() || freshDraftState();
    draftFillCaptain(state);
    saveDraftState(state);

    const picked = buildDraftPickedSet(state.alliances);
    const isDone = state.currentAlliance >= 8 || state.currentAlliance < 0;
    const isUser = !isDone && (state.currentRound === 2 || state.alliances[state.currentAlliance]?.captain !== null);

    if (statusEl) {
        if (isDone) {
            statusEl.textContent = 'Draft complete.';
        } else if (isUser) {
            const which = state.currentRound === 1 ? '1st pick' : '2nd pick';
            statusEl.textContent = `Alliance ${state.currentAlliance + 1} selecting ${which} — click a team →`;
        } else {
            statusEl.textContent = 'Filling captain…';
        }
    }

    // ── Alliance table ──
    const epaOf = tn => { const t = teamInfoMap[tn]; return t ? parseFloat(t.analysis?.ceiling ?? t.currentEPA ?? 0) || 0 : 0; };

    // Expected total = sum of top 24 EPAs divided evenly across 8 alliances
    const top24sum = allTeams.map(t => epaOf(String(t.teamNumber))).sort((a, b) => b - a).slice(0, 24).reduce((s, v) => s + v, 0);
    const expectedTotal = top24sum / 8;

    const teamChip = tn => {
        if (!tn) return `<span style="color:#1e293b;">—</span>`;
        return `<span style="font-weight:800;color:#f8fafc;">${tn}</span>`;
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
        const epaVal = t.analysis?.ceiling ?? t.currentEPA;
        const epaStr = epaVal != null && epaVal !== '—' ? parseFloat(epaVal).toFixed(1) : '';
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
    window.switchView(window.previousView);
};





let performanceChart = null;
let activeTeamNumber = null;
let activeTeamData = null;
let activeTBAData = null;

const PHOTO_STYLE = 'width:220px; min-width:220px; height:auto; max-height:320px; object-fit:contain; border-radius:8px; border:1px solid #334155; background:#0f172a; display:block;';

async function renderOverview(team, tbaTeam) {
    const el = document.getElementById('overviewContent');
    if (!el) return;

    const fmt = (v, d = 1) => (v != null && v !== '—') ? parseFloat(v).toFixed(d) : '—';
    const analysis = team.analysis || {};
    const ceilStr = fmt(analysis.ceiling);
    const lb = analysis.lowerBound, ub = analysis.upperBound;
    const ciStr = (lb != null && lb !== '—' && ub != null && ub !== '—') ? `${lb} – ${ub}` : null;

    const card = (label, value, color = '#f1f5f9', sub = null, tier = null) => `
        <div style="background:#1e293b; padding:16px; border-radius:8px; border:1px solid #334155; position:relative;">
            ${tier ? `<span style="position:absolute;top:8px;right:8px;">${tierBadge(tier)}</span>` : ''}
            <div style="color:#64748b; font-size:0.72em; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px;">${label}</div>
            <div style="font-size:1.55em; font-weight:800; color:${color}; line-height:1.1;">${value}</div>
            ${sub ? `<div style="color:#64748b; font-size:0.78em; margin-top:4px;">${sub}</div>` : ''}
        </div>`;

    // Compute effective OPR (mirrors displayTBATeams logic)
    let effOPRVal = tbaTeam?.opr ?? null;
    let oprLabel = 'OPR';
    if (tbaTeam) {
        const allMatches = await db.matches.toArray();
        const globalIgnored = new Set(allMatches.filter(m => m.globallyIgnored).map(m => m.key));
        if (tbaTeam.ignoredMatchKey && tbaTeam.adjustedOPR != null && !globalIgnored.has(tbaTeam.ignoredMatchKey)) {
            effOPRVal = tbaTeam.adjustedOPR;
            oprLabel = 'OPR <span style="color:#fbbf24; font-size:0.55em; font-weight:600; vertical-align:middle; margin-left:2px;">LOO</span>';
        } else if (globalIgnored.size > 0) {
            const allTBATeams = await db.tbaTeams.toArray();
            const teamNums = allTBATeams.map(t => t.teamNumber);
            const activePlayed = allMatches.filter(m =>
                (m.redScore ?? -1) >= 0 && (m.blueScore ?? -1) >= 0 && !globalIgnored.has(m.key)
            );
            const recomputed = computeLocalOPR(activePlayed, teamNums);
            if (recomputed) {
                const idx = teamNums.indexOf(parseInt(team.teamNumber));
                if (idx >= 0) effOPRVal = recomputed[idx];
                oprLabel = 'OPR <span style="color:#f97316; font-size:0.55em; font-weight:600; vertical-align:middle; margin-left:2px;">ADJ</span>';
            }
        }
    }

    // Component tiers — rank this team's each EPA against all teams
    const [allTeamsForOvTier, allTBAForOvTier] = await Promise.all([db.teams.toArray(), db.tbaTeams.toArray()]);
    const tbaOvMap = Object.fromEntries(allTBAForOvTier.map(t => [t.teamNumber, t]));
    const ceilOf = t => t.analysis?.ceiling != null ? parseFloat(t.analysis.ceiling) : (t.currentEPA || 0);
    const tierOverall  = epaRankTier(allTeamsForOvTier, ceilOf(team), ceilOf);
    const tierAuto     = epaRankTier(allTeamsForOvTier, team.autoEPA    || 0, t => t.autoEPA    || 0);
    const tierTeleop   = epaRankTier(allTeamsForOvTier, team.teleopEPA  || 0, t => t.teleopEPA  || 0);
    const tierEndgame  = epaRankTier(allTeamsForOvTier, team.endgameEPA || 0, t => t.endgameEPA || 0);
    const tierOPR      = effOPRVal != null
        ? epaRankTier(allTBAForOvTier, effOPRVal, t => tbaOvMap[t.teamNumber]?.opr ?? 0)
        : null;
    const tierAutoOPR    = tbaTeam?.autoOPR    != null ? epaRankTier(allTBAForOvTier, tbaTeam.autoOPR,    t => tbaOvMap[t.teamNumber]?.autoOPR    ?? 0) : null;
    const tierTeleopOPR  = tbaTeam?.teleopOPR  != null ? epaRankTier(allTBAForOvTier, tbaTeam.teleopOPR,  t => tbaOvMap[t.teamNumber]?.teleopOPR  ?? 0) : null;
    const tierEndgameOPR = tbaTeam?.endgameOPR != null ? epaRankTier(allTBAForOvTier, tbaTeam.endgameOPR, t => tbaOvMap[t.teamNumber]?.endgameOPR ?? 0) : null;
    const tierCCWM       = tbaTeam?.ccwm       != null ? epaRankTier(allTBAForOvTier, tbaTeam.ccwm,       t => tbaOvMap[t.teamNumber]?.ccwm       ?? 0) : null;

    const tierChip = (label, tier) =>
        `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:#1e293b;border-radius:6px;border:1px solid #334155;">
            <span style="color:#64748b;font-size:0.75em;font-weight:600;">${label}</span>${tierBadge(tier)}
        </span>`;

    const tierRow = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
        ${tierChip('Overall', tierOverall)}
        ${tierChip('Auto', tierAuto)}
        ${tierChip('Teleop', tierTeleop)}
        ${tierChip('Endgame', tierEndgame)}
        ${tierOPR ? tierChip('OPR', tierOPR) : ''}
    </div>`;

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

    const hasTBA = !!tbaTeam;
    const hasCompOPR = hasTBA && tbaTeam.autoOPR != null;
    const ccwmColor = hasTBA && tbaTeam.ccwm != null ? (tbaTeam.ccwm >= 0 ? '#4ade80' : '#f87171') : '#f1f5f9';

    el.innerHTML = `
        <div style="display:flex; gap:24px; align-items:flex-start; flex-wrap:wrap; margin-bottom:24px;">
            ${photoHtml}
            <div style="flex:1; min-width:180px;">
                <div style="font-size:1.8em; font-weight:800; color:#f8fafc; line-height:1.15;">${team.teamName || `Team ${team.teamNumber}`}</div>
                <div style="color:#64748b; font-size:1.05em; margin-top:4px;">Team #${team.teamNumber}</div>
                ${tierRow}
                <div style="display:flex; gap:16px; margin-top:14px; flex-wrap:wrap;">
                    <a href="https://www.thebluealliance.com/team/${team.teamNumber}/${team.eventKey?.slice(0,4) || ''}" target="_blank"
                        style="color:#3b82f6; text-decoration:none; font-size:0.9em; display:inline-flex; align-items:center; gap:4px;"><img src="tba.png" class="source-logo" style="margin:0;">View on TBA ↗</a>
                    <a href="https://www.statbotics.io/team/${team.teamNumber}/${team.eventKey?.slice(0,4) || ''}" target="_blank"
                        style="color:#3b82f6; text-decoration:none; font-size:0.9em; display:inline-flex; align-items:center; gap:4px;"><img src="statbotics.ico" class="source-logo" style="margin:0;">View on Statbotics ↗</a>
                </div>
            </div>
        </div>

        ${sectionLabel('Statbotics EPA')}
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:12px;">
            ${card('Total EPA', fmt(team.currentEPA), '#f1f5f9', null, tierOverall)}
            ${card('Auto', fmt(team.autoEPA), '#f1f5f9', null, tierAuto)}
            ${card('Teleop', fmt(team.teleopEPA), '#f1f5f9', null, tierTeleop)}
            ${card('Endgame', fmt(team.endgameEPA), '#f1f5f9', null, tierEndgame)}
            ${card('Ceiling', ceilStr, '#4ade80', ciStr ? `90%: ${ciStr}` : null, tierOverall)}
        </div>

        ${sectionLabel('TBA OPR')}
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:12px;">
            ${card(oprLabel, effOPRVal != null ? fmt(effOPRVal) : '—', '#f1f5f9', null, tierOPR)}
            ${hasCompOPR ? card('Auto OPR', fmt(tbaTeam.autoOPR), '#f1f5f9', null, tierAutoOPR) : ''}
            ${hasCompOPR ? card('Teleop OPR', fmt(tbaTeam.teleopOPR), '#f1f5f9', null, tierTeleopOPR) : ''}
            ${hasCompOPR ? card('Endgame OPR', fmt(tbaTeam.endgameOPR), '#f1f5f9', null, tierEndgameOPR) : ''}
            ${card('CCWM', hasTBA ? fmt(tbaTeam.ccwm) : '—', ccwmColor, null, tierCCWM)}
        </div>

        ${sectionLabel('Notes')}
        <div id="overview-notes-section"></div>

        ${sectionLabel('Pit Scouting')}
        ${placeholder('No pit data recorded yet.')}

        ${sectionLabel('Match Scouting')}
        ${placeholder('No match observations recorded yet.')}
    `;

    renderNoteSection(team.teamNumber);
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

window.switchDetailTab = async function (tab) {
    const tabs = ['overview', 'epa-opr', 'scouting', 'pit-data'];
    tabs.forEach(t => {
        document.getElementById(`tab-${t}`).style.display = t === tab ? 'block' : 'none';
    });
    document.querySelectorAll('.detail-tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', tabs[i] === tab);
    });
    if (tab === 'overview' && activeTeamData) {
        await renderOverview(activeTeamData, activeTBAData);
    }
    if (tab === 'epa-opr' && activeTeamData) {
        renderChart(activeTeamData);
        await renderTBADetail(activeTeamData.teamNumber, activeTBAData);
    }
};

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
    // Base OPR computation excludes globally ignored matches so LOO deltas are self-consistent.
    const playedMatches = allMatches.filter(m =>
        (m.redScore ?? -1) >= 0 &&
        (m.blueScore ?? -1) >= 0 &&
        !globalIgnored.has(m.key)
    );

    const teamMatches = allMatches
        .filter(m =>
            (m.red || []).map(String).includes(teamNumStr) ||
            (m.blue || []).map(String).includes(teamNumStr))
        .sort((a, b) => a.matchNumber - b.matchNumber);

    // OPR profile stat grid
    const effectiveOPR = tbaTeam.ignoredMatchKey && tbaTeam.adjustedOPR != null
        ? tbaTeam.adjustedOPR : tbaTeam.opr;
    oprSection.innerHTML = `
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:12px;">
            <div style="background:#1a1a1a; padding:12px; border-radius:6px;">
                <div class="stat-label">OPR</div>
                <div class="stat-value">${effectiveOPR.toFixed(1)}${tbaTeam.ignoredMatchKey ? '&thinsp;<span style="color:#fbbf24; font-size:0.65em; font-weight:600;">LOO</span>' : ''}</div>
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

    // Adjustment banner — only when the individually ignored match isn't also globally ignored
    if (tbaTeam.ignoredMatchKey && !globalIgnored.has(tbaTeam.ignoredMatchKey)) {
        const ignoredMatch = teamMatches.find(m => m.key === tbaTeam.ignoredMatchKey);
        const label = ignoredMatch ? `Q${ignoredMatch.matchNumber}` : tbaTeam.ignoredMatchKey;
        oprSection.innerHTML += `
            <div style="margin-top:10px; padding:10px 14px; background:#1a1a1a; border-radius:6px; border-left:3px solid #fbbf24; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                <span style="color:#fbbf24; font-size:0.85em;">Ignoring <strong>${label}</strong> — LOO OPR: <strong>${tbaTeam.adjustedOPR.toFixed(1)}</strong> (was ${tbaTeam.opr.toFixed(1)})</span>
                <button onclick="setIgnoredMatch(${teamNumber}, null, null)"
                        style="padding:3px 10px; font-size:0.8em; background:#7f1d1d; border:1px solid #ef4444; border-radius:4px; cursor:pointer; color:#fff;">
                    Clear
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
        // Only compute OPR columns for matches that are part of the active base.
        const predicted = !isGloballyIgnored
            ? alliance.reduce((s, t) => s + (oprByTeam[String(t)]?.opr || 0), 0)
            : null;
        const residual = played && !isGloballyIgnored ? score - predicted : null;

        let looOPR = null, impact = null;
        if (played && !isGloballyIgnored && baseOPR != null) {
            const looResult = computeLocalOPR(playedMatches.filter(pm => pm.key !== m.key), allTeamNums);
            if (looResult) {
                looOPR = looResult[teamIdx];
                impact = baseOPR - looOPR;
            }
        }
        return { m, isRed, score, played, isGloballyIgnored, predicted, residual, looOPR, impact };
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
        const isGlobal = r.isGloballyIgnored;
        const isIndivIgnored = !isGlobal && tbaTeam.ignoredMatchKey === r.m.key;
        const rowStyle = isGlobal
            ? 'cursor:pointer; opacity:0.4;'
            : isIndivIgnored
                ? 'cursor:pointer; background:rgba(251,191,36,0.06);'
                : 'cursor:pointer;';
        const matchLabel = isGlobal
            ? `Q${r.m.matchNumber} <span style="color:#f59e0b; font-size:0.7em; font-weight:600;">GLOBAL</span>`
            : `Q${r.m.matchNumber}`;

        let ignoreBtn = '';
        if (isGlobal) {
            ignoreBtn = `<button onclick="event.stopPropagation();setGloballyIgnored('${r.m.key}',false)"
                            style="padding:3px 10px; font-size:0.8em; background:#92400e; border:1px solid #d97706; color:#fde68a; border-radius:4px; cursor:pointer; white-space:nowrap;">
                            Restore Global</button>`;
        } else if (r.played && r.looOPR != null) {
            const ignoreArgs = isIndivIgnored
                ? `${teamNumber}, null, null`
                : `${teamNumber}, '${r.m.key}', ${r.looOPR.toFixed(2)}`;
            ignoreBtn = `<button onclick="event.stopPropagation();setIgnoredMatch(${ignoreArgs})"
                            style="padding:3px 10px; font-size:0.8em; background:${isIndivIgnored ? '#92400e' : '#1e293b'}; border:1px solid ${isIndivIgnored ? '#d97706' : '#475569'}; color:${isIndivIgnored ? '#fde68a' : '#94a3b8'}; border-radius:4px; cursor:pointer; white-space:nowrap;">
                            ${isIndivIgnored ? 'Restore' : 'Ignore'}</button>`;
        }

        return `<tr onclick="viewMatchDetail('${r.m.key}')" style="${rowStyle}">
                        <td style="text-align:left;">${matchLabel}</td>
                        <td><span style="color:${r.isRed ? '#ef4444' : '#3b82f6'}; font-weight:bold;">${r.isRed ? 'Red' : 'Blue'}</span></td>
                        <td>${r.played ? r.score : '—'}</td>
                        <td>${r.predicted != null ? r.predicted.toFixed(1) : '—'}</td>
                        <td style="color:${resColor(r.residual)}; font-weight:bold;">${r.played && !isGlobal ? fmtSigned(r.residual) : '—'}</td>
                        <td style="color:#94a3b8;">${r.looOPR != null ? r.looOPR.toFixed(1) : '—'}</td>
                        <td style="color:${resColor(r.impact)}; font-weight:bold;">${fmtSigned(r.impact)}</td>
                        <td>${ignoreBtn}</td>
                    </tr>`;
    }).join('')}
            </tbody>
        </table>`;
}

window.setIgnoredMatch = async function (teamNumber, matchKey, looOPR) {
    const pk = parseInt(teamNumber);
    const updates = matchKey === null
        ? { ignoredMatchKey: null, adjustedOPR: null }
        : { ignoredMatchKey: matchKey, adjustedOPR: looOPR };
    await db.tbaTeams.update(pk, updates);
    activeTBAData = await db.tbaTeams.get(pk);
    await Promise.all([
        displayTBATeams(),
        renderTBADetail(teamNumber, activeTBAData),
        activeTeamData ? renderOverview(activeTeamData, activeTBAData) : Promise.resolve(),
    ]);
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
    }

    // Restore sync timestamps
    for (const key of ['statboticsLive', 'tbaOPR', 'tbaMatches']) {
        const saved = localStorage.getItem(`lastSync_${key}`);
        const el = document.getElementById(`ts-${key}`);
        if (saved && el) el.textContent = `Last sync: ${saved}`;
    }

    // 1. Set the initial view (Home)
    initUIMode();
    window.switchView('homeView');

    // 2. Load the cached data into the tables immediately
    // This ensures that when you click 'Statbotics' or 'Schedule', 
    // the data is already waiting for you.
    try {
        await displayTeams();        // Loads Statbotics cache
        await displaySchedule();     // Loads TBA Schedule cache
        await displayTBATeams();     // Loads TBA OPR cache
        await renderAtAGlance();     // Loads at-a-glance overview
        console.log("Local cache successfully loaded into UI.");
    } catch (err) {
        console.warn("No cached data found to load yet.");
    }
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

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => { });
}






