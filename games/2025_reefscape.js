// 2025 FRC Game: Reefscape
// All 2025-specific logic lives here: event sources, column maps, scouting processing,
// TBA fusion definitions, EPA calculations, and game-specific UI hooks.

// Shared column overrides used by events with the alternate sheet format.
const _altColumns = {
    matchNumber:    'Match #',
    startingPos:    'Starting Position',
    movedInAuto:    'Moved?',
    coralL1Auto:    'Coral L1 Auto',
    coralL2Auto:    'Coral L2 Auto',
    coralL3Auto:    'Coral L3 Auto',
    coralL4Auto:    'Coral L4 Auto',
    bargeAlgaeAuto: 'Algae Barge Auto',
    coralL1Tele:    'Coral L1 Scored',
    coralL2Tele:    'Coral L2 Scored',
    coralL3Tele:    'Coral L3 Scored',
    coralL4Tele:    'Coral L4 Scored',
    bargeAlgaeTele: 'Net Algae Scored',
    procAlgaeTele:  'Processor Algae Scored',
    touchedCage:    'Attempted Barge?',
    defended:       'Played Defense?',
    died:           'Issues?',
    tippedOver:     'Tippy?',
    comments:       'Notes',
};

export default {
    year: 2025,
    name: 'Reefscape',

    // ── Event sources ─────────────────────────────────────────────────────────
    // Merged into EVENT_SOURCES by registry.js. Each entry: { url?, pitUrl?, columnOverrides? }
    // url: Google Sheets CSV export URL = live (auto-sync enabled)
    //      local path /scouting/xxx.json = archived (no auto-sync)
    eventSources: {
        '2025nhsal': {
            url: 'https://docs.google.com/spreadsheets/d/1AswB6GoLpaAQtKl-YABLQOsq27XadUBV0jjeY8dZGIQ/export?format=csv&gid=0',
        },
        '2025hop': {
            url:             'https://docs.google.com/spreadsheets/d/1kve4VKu8z1pilr3IbqI6KL2oCCdQ01Gd-QzZwZP_Yd0/export?format=csv&gid=0',
            pitUrl:          'https://docs.google.com/spreadsheets/d/1kve4VKu8z1pilr3IbqI6KL2oCCdQ01Gd-QzZwZP_Yd0/export?format=csv&gid=422722453',
            columnOverrides: _altColumns,
        },
        '2025rikin': {
            url:    'https://docs.google.com/spreadsheets/d/1uMo83-BPj2nqj4E5kAj1dzW6jOwneG62oqfu2K7vISc/export?format=csv&gid=0',
            pitUrl: 'https://docs.google.com/spreadsheets/d/1uMo83-BPj2nqj4E5kAj1dzW6jOwneG62oqfu2K7vISc/export?format=csv&gid=1348182571',
        },
        '2025mawor': {
            url:             'https://docs.google.com/spreadsheets/d/1vMU2xYcMb3EFsf_uibDrnOt3RBJkr8RewFEXz4cCwDw/export?format=csv&gid=0',
            pitUrl:          'https://docs.google.com/spreadsheets/d/1vMU2xYcMb3EFsf_uibDrnOt3RBJkr8RewFEXz4cCwDw/export?format=csv&gid=1348182571',
            columnOverrides: _altColumns,
        },
        '2025necmp2': {
            url:             'https://docs.google.com/spreadsheets/d/134YRYsZ4pI_Va-OYNBzMthkA3JczH7lsEHXIEr1O7ms/export?format=csv&gid=0',
            pitUrl:          'https://docs.google.com/spreadsheets/d/134YRYsZ4pI_Va-OYNBzMthkA3JczH7lsEHXIEr1O7ms/export?format=csv&gid=1348182571',
            columnOverrides: _altColumns,
        },
    },

    // ── Column map ────────────────────────────────────────────────────────────
    // Canonical field → default column header in the scouting sheet.
    // Override specific entries per-event via eventSources[key].columnOverrides.
    defaultColumns: {
        matchNumber:        'Match Number',
        teamNumber:         'Team Number',
        robot:              'Robot',
        startingPos:        'Starting Pos.',
        noShow:             'No Show',
        cagePos:            'Cage Pos.',
        movedInAuto:        'Moved in Auto',
        coralL1Auto:        'Coral 1 Auto',
        coralL2Auto:        'Coral 2 Auto',
        coralL3Auto:        'Coral 3 Auto',
        coralL4Auto:        'Coral 4 Auto',
        bargeAlgaeAuto:     'Barge Algae Auto',
        procAlgaeAuto:      'Proc. Algae Auto',
        dislodgedAlgaeAuto: 'Dislodged Algae Auto',
        autoFoul:           'Auto Foul',
        coralL1Tele:        'Coral 1 Tele',
        coralL2Tele:        'Coral 2 Tele',
        coralL3Tele:        'Coral 3 Tele',
        coralL4Tele:        'Coral 4 Tele',
        bargeAlgaeTele:     'Barge Algae',
        procAlgaeTele:      'Proc Algae',
        tippedOver:         'Tipped/Fell Over',
        touchedCage:        'Touched Cage?',
        died:               'Died',
        endPosition:        'End Position',
        defended:           'Defended',
        matchResult:        'Match Result',
        offenseSkill:       'Offense Skill',
        defenseSkill:       'Defense Skill',
        yellowRed:          'Yellow/Red',
        comments:           'Comments',
    },

    // ── Row processing ────────────────────────────────────────────────────────
    processRow(row, colMap) {
        const get  = (f) => row[colMap[f]] ?? '';
        const num  = (f) => parseFloat(get(f)) || 0;
        const bool = (f) => { const v = get(f).trim().toLowerCase(); return v === 'true' || v === 'yes' || v === '1' || v === 'x'; };

        return {
            matchNumber:        num('matchNumber'),
            teamNumber:         get('teamNumber').trim(),
            robot:              get('robot').trim(),
            startingPos:        get('startingPos').trim(),
            noShow:             bool('noShow'),
            cagePos:            get('cagePos').trim(),
            movedInAuto:        bool('movedInAuto'),
            coralL1Auto:        num('coralL1Auto'),
            coralL2Auto:        num('coralL2Auto'),
            coralL3Auto:        num('coralL3Auto'),
            coralL4Auto:        num('coralL4Auto'),
            bargeAlgaeAuto:     num('bargeAlgaeAuto'),
            procAlgaeAuto:      num('procAlgaeAuto'),
            dislodgedAlgaeAuto: num('dislodgedAlgaeAuto'),
            autoFoul:           bool('autoFoul'),
            coralL1Tele:        num('coralL1Tele'),
            coralL2Tele:        num('coralL2Tele'),
            coralL3Tele:        num('coralL3Tele'),
            coralL4Tele:        num('coralL4Tele'),
            bargeAlgaeTele:     num('bargeAlgaeTele'),
            procAlgaeTele:      num('procAlgaeTele'),
            tippedOver:         bool('tippedOver'),
            touchedCage:        bool('touchedCage'),
            died:               bool('died'),
            endPosition:        get('endPosition').trim(),
            defended:           bool('defended'),
            matchResult:        get('matchResult').trim(),
            offenseSkill:       num('offenseSkill'),
            defenseSkill:       num('defenseSkill'),
            yellowRed:          bool('yellowRed'),
            comments:           get('comments').trim(),
        };
    },

    // ── Team aggregation ──────────────────────────────────────────────────────
    aggregateTeam(rows) {
        const played = rows.filter(r => !r.noShow);
        const n = played.length || 1;

        const avg = (fn) => played.reduce((s, r) => s + fn(r), 0) / n;
        const pct = (fn) => Math.round(played.filter(fn).length / n * 100);
        const endPct = (val) => pct(r => r.endPosition.toLowerCase() === val.toLowerCase());

        return {
            matches:   played.length,
            noShows:   rows.filter(r => r.noShow).length,

            autoCoralL1:        avg(r => r.coralL1Auto),
            autoCoralL2:        avg(r => r.coralL2Auto),
            autoCoralL3:        avg(r => r.coralL3Auto),
            autoCoralL4:        avg(r => r.coralL4Auto),
            autoCoralTotal:     avg(r => r.coralL1Auto + r.coralL2Auto + r.coralL3Auto + r.coralL4Auto),
            autoAlgaeBarge:     avg(r => r.bargeAlgaeAuto),
            autoAlgaeProc:      avg(r => r.procAlgaeAuto),
            autoAlgaeTotal:     avg(r => r.bargeAlgaeAuto + r.procAlgaeAuto),
            pctMovedAuto:       pct(r => r.movedInAuto),

            teleopCoralL1:      avg(r => r.coralL1Tele),
            teleopCoralL2:      avg(r => r.coralL2Tele),
            teleopCoralL3:      avg(r => r.coralL3Tele),
            teleopCoralL4:      avg(r => r.coralL4Tele),
            teleopCoralTotal:   avg(r => r.coralL1Tele + r.coralL2Tele + r.coralL3Tele + r.coralL4Tele),
            teleopAlgaeBarge:   avg(r => r.bargeAlgaeTele),
            teleopAlgaeProc:    avg(r => r.procAlgaeTele),
            teleopAlgaeTotal:   avg(r => r.bargeAlgaeTele + r.procAlgaeTele),

            pctCageTouch:       pct(r => r.touchedCage),
            endPositions: {
                none:           endPct('not parked'),
                parked:         endPct('parked'),
                shallowCage:    endPct('shallow climb'),
                deepCage:       endPct('deep climb'),
            },

            pctDied:            pct(r => r.died),
            pctTipped:          pct(r => r.tippedOver),
            pctDefended:        pct(r => r.defended),

            avgOffense:         avg(r => r.offenseSkill),
            avgDefense:         avg(r => r.defenseSkill),

            comments: rows
                .filter(r => r.comments)
                .map(r => ({ matchNumber: r.matchNumber, text: r.comments }))
                .sort((a, b) => a.matchNumber - b.matchNumber),

            observations: rows,
        };
    },

    // ── TBA fusion stat definitions ───────────────────────────────────────────
    //
    // autoFuseStats   — share × TBA auto count
    // teleopFuseStats — share × net teleop (cumulative-corrected by registry.js)
    //   tbaRaw: raw TBA teleop field (may include auto if cumulative)
    //   tbaAuto: TBA auto field for the same piece (subtracted if cumulative)
    //   maxPerAlliance: physical cap used to detect cumulative vs. separate reporting
    // splitFuseStats  — fuse alliance total, then re-split by scouting auto/teleop ratio
    // robotFuseStats  — read directly by robot index (no share-weighting)

    autoFuseStats: [
        { key: 'autoCoralL1', scout: r => r.coralL1Auto, tba: b => b.autoReef?.trough },
        { key: 'autoCoralL2', scout: r => r.coralL2Auto, tba: b => b.autoReef?.tba_botRowCount },
        { key: 'autoCoralL3', scout: r => r.coralL3Auto, tba: b => b.autoReef?.tba_midRowCount },
        { key: 'autoCoralL4', scout: r => r.coralL4Auto, tba: b => b.autoReef?.tba_topRowCount },
    ],

    teleopFuseStats: [
        { key: 'teleopCoralL1', scout: r => r.coralL1Tele, tbaRaw: b => b.teleopReef?.trough,         tbaAuto: b => b.autoReef?.trough,         maxPerAlliance: null },
        { key: 'teleopCoralL2', scout: r => r.coralL2Tele, tbaRaw: b => b.teleopReef?.tba_botRowCount, tbaAuto: b => b.autoReef?.tba_botRowCount, maxPerAlliance: 12 },
        { key: 'teleopCoralL3', scout: r => r.coralL3Tele, tbaRaw: b => b.teleopReef?.tba_midRowCount, tbaAuto: b => b.autoReef?.tba_midRowCount, maxPerAlliance: 12 },
        { key: 'teleopCoralL4', scout: r => r.coralL4Tele, tbaRaw: b => b.teleopReef?.tba_topRowCount, tbaAuto: b => b.autoReef?.tba_topRowCount, maxPerAlliance: 12 },
    ],

    splitFuseStats: [
        { autoKey: 'autoAlgaeBarge',  teleopKey: 'teleopAlgaeBarge',
          scoutAuto: r => r.bargeAlgaeAuto, scoutTeleop: r => r.bargeAlgaeTele,
          tba: b => b.netAlgaeCount },
        { autoKey: 'autoAlgaeProc',   teleopKey: 'teleopAlgaeProc',
          scoutAuto: r => r.procAlgaeAuto,  scoutTeleop: r => r.procAlgaeTele,
          tba: b => b.wallAlgaeCount },
    ],

    robotFuseStats: [
        {
            key: 'autoMobilityPts',
            tba:   (b, i) => { const v = b[`autoLineRobot${i}`]; return v == null ? null : v === 'Yes' ? 3 : 0; },
            scout: r => r.movedInAuto ? 3 : 0,
        },
        {
            key: 'endgamePts',
            tba: (b, i) => {
                const v = (b[`endGameRobot${i}`] || '').toLowerCase();
                if (!v) return null;
                if (v === 'deepcage')    return 12;
                if (v === 'shallowcage') return 6;
                if (v === 'parked')      return 2;
                return 0;
            },
            scout: r => {
                const pos = (r.endPosition || '').toLowerCase();
                if (pos === 'deep climb')    return 12;
                if (pos === 'shallow climb') return 6;
                if (pos === 'parked')        return 2;
                return 0;
            },
        },
    ],

    // ── Derived fused totals ──────────────────────────────────────────────────
    // Called after fuseScoutingWithTBA to add computed aggregate fields that
    // aren't emitted directly by the per-stat fusion loop.
    deriveFusedTotals(s) {
        if (s.autoCoralL1 != null && s.autoCoralL2 != null && s.autoCoralL3 != null && s.autoCoralL4 != null)
            s.autoCoralTotal = s.autoCoralL1 + s.autoCoralL2 + s.autoCoralL3 + s.autoCoralL4;
        if (s.teleopCoralL1 != null && s.teleopCoralL2 != null && s.teleopCoralL3 != null && s.teleopCoralL4 != null)
            s.teleopCoralTotal = s.teleopCoralL1 + s.teleopCoralL2 + s.teleopCoralL3 + s.teleopCoralL4;
    },

    // ── Per-match breakdown columns ───────────────────────────────────────────
    // Drives the per-match table in the scouting detail tab.
    // raw(obs): value from an un-fused scouting row
    // fused(stats): value from a fuseScoutingWithTBA stats object
    matchBreakdownColumns: [
        { label: 'L1',   raw: r => r.coralL1Auto + r.coralL1Tele,       fused: s => (s.autoCoralL1 ?? 0) + (s.teleopCoralL1 ?? 0) },
        { label: 'L2',   raw: r => r.coralL2Auto + r.coralL2Tele,       fused: s => (s.autoCoralL2 ?? 0) + (s.teleopCoralL2 ?? 0) },
        { label: 'L3',   raw: r => r.coralL3Auto + r.coralL3Tele,       fused: s => (s.autoCoralL3 ?? 0) + (s.teleopCoralL3 ?? 0) },
        { label: 'L4',   raw: r => r.coralL4Auto + r.coralL4Tele,       fused: s => (s.autoCoralL4 ?? 0) + (s.teleopCoralL4 ?? 0) },
        { label: 'Barge',raw: r => r.bargeAlgaeAuto + r.bargeAlgaeTele, fused: s => (s.autoAlgaeBarge ?? 0) + (s.teleopAlgaeBarge ?? 0) },
        { label: 'Proc', raw: r => r.procAlgaeAuto + r.procAlgaeTele,   fused: s => (s.autoAlgaeProc ?? 0) + (s.teleopAlgaeProc ?? 0) },
    ],

    // ── Game-specific curation section ────────────────────────────────────────
    // Returns an HTML string for the "2025 — Coral Accounting" block in the
    // Data Curation tab. Receives data already computed by renderCurationTab.
    curationSection(tbaMatches, matchCoverage, scoutIndex, isCumulative, reportingMode, { summaryStyle, hdrStyle, chevron }) {
        const hasBreakdowns = tbaMatches.some(m => m.redBreakdown);
        if (!hasBreakdowns) return '';

        const rows = [];
        for (const { mn, m } of matchCoverage) {
            for (const [alliance, breakdown] of [['red', m?.redBreakdown], ['blue', m?.blueBreakdown]]) {
                if (!breakdown) continue;
                const teams = m?.[alliance] || [];
                if (teams.some(t => !scoutIndex[mn]?.[t])) continue;

                const scoutL1 = teams.reduce((s, t) => s + (scoutIndex[mn][t].coralL1Auto + scoutIndex[mn][t].coralL1Tele), 0);
                const scoutL2 = teams.reduce((s, t) => s + (scoutIndex[mn][t].coralL2Auto + scoutIndex[mn][t].coralL2Tele), 0);
                const scoutL3 = teams.reduce((s, t) => s + (scoutIndex[mn][t].coralL3Auto + scoutIndex[mn][t].coralL3Tele), 0);
                const scoutL4 = teams.reduce((s, t) => s + (scoutIndex[mn][t].coralL4Auto + scoutIndex[mn][t].coralL4Tele), 0);

                const tbaL1 = isCumulative ? (breakdown.teleopReef?.trough ?? 0)
                    : (breakdown.autoReef?.trough ?? 0) + (breakdown.teleopReef?.trough ?? 0);
                const tbaL2 = isCumulative ? (breakdown.teleopReef?.tba_botRowCount ?? 0)
                    : (breakdown.autoReef?.tba_botRowCount ?? 0) + (breakdown.teleopReef?.tba_botRowCount ?? 0);
                const tbaL3 = isCumulative ? (breakdown.teleopReef?.tba_midRowCount ?? 0)
                    : (breakdown.autoReef?.tba_midRowCount ?? 0) + (breakdown.teleopReef?.tba_midRowCount ?? 0);
                const tbaL4 = isCumulative ? (breakdown.teleopReef?.tba_topRowCount ?? 0)
                    : (breakdown.autoReef?.tba_topRowCount ?? 0) + (breakdown.teleopReef?.tba_topRowCount ?? 0);

                const scoutTotal = scoutL1 + scoutL2 + scoutL3 + scoutL4;
                const tbaTotal   = tbaL1 + tbaL2 + tbaL3 + tbaL4;
                rows.push({ mn, alliance, scoutL1, scoutL2, scoutL3, scoutL4, scoutTotal, tbaL1, tbaL2, tbaL3, tbaL4, tbaTotal, delta: scoutTotal - tbaTotal });
            }
        }

        const avgDelta    = rows.length ? rows.reduce((s, r) => s + r.delta, 0) / rows.length : null;
        const pctCaptured = rows.length && rows.reduce((s, r) => s + r.tbaTotal, 0) > 0
            ? (rows.reduce((s, r) => s + r.scoutTotal, 0) / rows.reduce((s, r) => s + r.tbaTotal, 0) * 100).toFixed(1)
            : null;
        const captureColor = pctCaptured != null ? (parseFloat(pctCaptured) >= 90 ? '#4ade80' : parseFloat(pctCaptured) >= 75 ? '#f59e0b' : '#ef4444') : '#64748b';

        return `
        <details style="margin-bottom:20px;">
            <summary style="${summaryStyle('#3b82f6')}">
                <span style="${hdrStyle('#3b82f6')}">2025 — Coral Accounting <span style="color:#475569;font-weight:400;font-size:0.9em;">(fully-scouted alliances · ${reportingMode})</span></span>
                ${pctCaptured != null ? `<span style="font-size:0.75em;color:#64748b;margin-right:8px;"><span style="color:${captureColor};">${pctCaptured}%</span> captured</span>` : ''}
                ${chevron}
            </summary>
            <div style="margin-top:12px;">
            ${pctCaptured != null ? `<p style="color:#94a3b8;font-size:0.82em;margin:0 0 10px;">Scouting captures <strong style="color:${captureColor}">${pctCaptured}%</strong> of TBA coral across ${rows.length} fully-scouted alliances. Avg gap: ${avgDelta?.toFixed(1)} coral/alliance.</p>` : ''}
            <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:0.75em;">
                <thead><tr style="color:#64748b;border-bottom:1px solid #334155;">
                    <th style="text-align:left;padding:3px 6px;">Match</th>
                    <th style="padding:3px 6px;">Alliance</th>
                    <th style="padding:3px 6px;" colspan="2">L1</th>
                    <th style="padding:3px 6px;" colspan="2">L2</th>
                    <th style="padding:3px 6px;" colspan="2">L3</th>
                    <th style="padding:3px 6px;" colspan="2">L4</th>
                    <th style="padding:3px 6px;" colspan="2">Total</th>
                </tr>
                <tr style="color:#475569;border-bottom:1px solid #334155;font-size:0.85em;">
                    <th></th><th></th>
                    <th style="padding:2px 4px;">Scout</th><th style="padding:2px 4px;">TBA</th>
                    <th style="padding:2px 4px;">Scout</th><th style="padding:2px 4px;">TBA</th>
                    <th style="padding:2px 4px;">Scout</th><th style="padding:2px 4px;">TBA</th>
                    <th style="padding:2px 4px;">Scout</th><th style="padding:2px 4px;">TBA</th>
                    <th style="padding:2px 4px;">Scout</th><th style="padding:2px 4px;">TBA</th>
                </tr></thead>
                <tbody>
                ${rows.map(r => {
                    const rowColor = Math.abs(r.delta) >= 4 ? 'rgba(239,68,68,0.08)' : Math.abs(r.delta) >= 2 ? 'rgba(245,158,11,0.08)' : '';
                    const cell = (s, t) => {
                        const d = s - t;
                        const c = d < -1 ? '#ef4444' : d > 1 ? '#f59e0b' : '#94a3b8';
                        return `<td style="text-align:center;padding:3px 6px;">${s}</td><td style="text-align:center;padding:3px 6px;color:${c};">${t}</td>`;
                    };
                    return `<tr style="border-bottom:1px solid #1e293b;background:${rowColor};">
                        <td style="padding:3px 6px;color:#60a5fa;">QM ${r.mn}</td>
                        <td style="padding:3px 6px;color:${r.alliance === 'red' ? '#f87171' : '#60a5fa'};">${r.alliance}</td>
                        ${cell(r.scoutL1,r.tbaL1)}${cell(r.scoutL2,r.tbaL2)}${cell(r.scoutL3,r.tbaL3)}${cell(r.scoutL4,r.tbaL4)}${cell(r.scoutTotal,r.tbaTotal)}
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
            </div>
            </div>
        </details>`;
    },

    // ── EPA breakdowns ────────────────────────────────────────────────────────

    computeFusedEPABreakdown(s) {
        const auto =
            (s.autoCoralL1 ?? 0) * 3 + (s.autoCoralL2 ?? 0) * 4 +
            (s.autoCoralL3 ?? 0) * 6 + (s.autoCoralL4 ?? 0) * 7 +
            (s.autoAlgaeBarge ?? 0) * 4 + (s.autoAlgaeProc ?? 0) * 2 +
            (s.autoMobilityPts ?? 0);
        const teleop =
            (s.teleopCoralL1 ?? 0) * 2 + (s.teleopCoralL2 ?? 0) * 3 +
            (s.teleopCoralL3 ?? 0) * 4 + (s.teleopCoralL4 ?? 0) * 5 +
            (s.teleopAlgaeBarge ?? 0) * 4 + (s.teleopAlgaeProc ?? 0) * 2;
        const endgame = s.endgamePts ?? 0;
        return { auto, teleop, endgame, total: auto + teleop + endgame };
    },

    computeEPABreakdown(s) {
        const mobilityPts = (s.pctMovedAuto || 0) / 100 * 3;
        const endgamePts  = (
            (s.endPositions?.parked      || 0) * 2 +
            (s.endPositions?.shallowCage || 0) * 6 +
            (s.endPositions?.deepCage    || 0) * 12
        ) / 100;
        const auto =
            (s.autoCoralL1 || 0) * 3 + (s.autoCoralL2 || 0) * 4 +
            (s.autoCoralL3 || 0) * 6 + (s.autoCoralL4 || 0) * 7 +
            (s.autoAlgaeBarge || 0) * 4 + (s.autoAlgaeProc || 0) * 2 +
            mobilityPts;
        const teleop =
            (s.teleopCoralL1 || 0) * 2 + (s.teleopCoralL2 || 0) * 3 +
            (s.teleopCoralL3 || 0) * 4 + (s.teleopCoralL4 || 0) * 5 +
            (s.teleopAlgaeBarge || 0) * 4 + (s.teleopAlgaeProc || 0) * 2;
        return { auto, teleop, endgame: endgamePts, total: auto + teleop + endgamePts };
    },

    scoringWeights: {
        autoCoralL1:    3, autoCoralL2:    4, autoCoralL3:    6, autoCoralL4:    7,
        teleopCoralL1:  2, teleopCoralL2:  3, teleopCoralL3:  4, teleopCoralL4:  5,
        autoAlgaeBarge: 4, teleopAlgaeBarge: 4,
        autoAlgaeProc:  2, teleopAlgaeProc:  2,
        autoMobilityPts: 1, endgamePts: 1,
    },

    // ── Display fields ────────────────────────────────────────────────────────
    displayFields: [
        { group: 'Overview' },
        { label: 'Matches Scouted', key: 'matches' },
        { label: 'Scout EPA',       key: 'scoutingEPA',  decimals: 1 },
        { label: 'No Shows',        key: 'noShows' },
        { label: 'Moved in Auto',   key: 'pctMovedAuto',     suffix: '%' },
        { label: 'Mobility Pts',    key: 'autoMobilityPts',  decimals: 1 },

        { group: 'Auto Coral' },
        { label: 'L1',    key: 'autoCoralL1',    decimals: 1 },
        { label: 'L2',    key: 'autoCoralL2',    decimals: 1 },
        { label: 'L3',    key: 'autoCoralL3',    decimals: 1 },
        { label: 'L4',    key: 'autoCoralL4',    decimals: 1 },
        { label: 'Total', key: 'autoCoralTotal', decimals: 1 },

        { group: 'Auto Algae' },
        { label: 'Barge',     key: 'autoAlgaeBarge', decimals: 1 },
        { label: 'Processor', key: 'autoAlgaeProc',  decimals: 1 },

        { group: 'Teleop Coral' },
        { label: 'L1',    key: 'teleopCoralL1',    decimals: 1 },
        { label: 'L2',    key: 'teleopCoralL2',    decimals: 1 },
        { label: 'L3',    key: 'teleopCoralL3',    decimals: 1 },
        { label: 'L4',    key: 'teleopCoralL4',    decimals: 1 },
        { label: 'Total', key: 'teleopCoralTotal', decimals: 1 },

        { group: 'Teleop Algae' },
        { label: 'Barge',     key: 'teleopAlgaeBarge', decimals: 1 },
        { label: 'Processor', key: 'teleopAlgaeProc',  decimals: 1 },

        { group: 'Endgame & Reliability' },
        { label: 'Endgame Pts',  key: 'endgamePts',   decimals: 1 },
        { label: 'Touched Cage', key: 'pctCageTouch', suffix: '%' },
        { label: 'Died',         key: 'pctDied',      suffix: '%' },
        { label: 'Tipped/Fell',  key: 'pctTipped',    suffix: '%' },
        { label: 'Defended',     key: 'pctDefended',  suffix: '%' },

        { group: 'Qualitative' },
        { label: 'Offense Skill', key: 'avgOffense', decimals: 1 },
        { label: 'Defense Skill', key: 'avgDefense', decimals: 1 },
    ],
};
