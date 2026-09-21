// Healthy Together — WhatsApp export -> health dashboard
// Everything runs client-side. Parsed data is cached in localStorage
// under STORAGE_KEY so re-opening the page keeps your history, and
// re-uploading a fresher export just merges new entries in.

const STORAGE_KEY = 'healthy-together:entries:v2'; // v2 = Cardio/Strength/Mobility schema
const UNPARSED_KEY = 'healthy-together:unparsed:v1'; // persisted so "Needs a nudge" survives a reload
const SEED_LABEL_KEY = 'healthy-together:seedLabel:v1'; // tracks which baked-in real-data.js a browser has already applied

// ---------- WhatsApp export parsing ----------

// Matches the line that starts a new WhatsApp message.
// Android:  "24/08/2026, 18:32 - Sagar Mehendale: text"
// iOS:      "[24/08/2026, 18:32:10] Sagar Mehendale: text"
// Handles 12h ("6:32 pm") and 24h times, with or without seconds.
const MESSAGE_START = /^\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|AM|PM)?\]?\s*-?\s*([^:]+):\s(.*)$/;

// Lines WhatsApp inserts that aren't real progress posts. Note: a bare
// "<Media omitted>" (a "Without media" export) or "<attached: file.jpg>"
// (an "Include media" export — what this app asks people to use) is
// deliberately NOT filtered here — a captionless screenshot is still a
// real post and should show up in "Needs a nudge", not silently disappear.
const SYSTEM_LINE = /messages and calls are end-to-end encrypted|created (the )?group|added|left|changed the subject|changed (this|the) group|changed the group description|security code changed|you're now an admin|missed voice call|missed video call|requested to join|pinned a message|changed their phone number|you deleted this message|this message was deleted|turned on disappearing messages|turned off disappearing messages/i;

// WhatsApp prefixes some lines (notably attachment messages) with invisible
// directional-mark characters (U+200E/U+200F) before the date — strip those
// so the anchored MESSAGE_START regex still matches.
const INVISIBLE_MARKS = /^[‎‏﻿]+/;

// Contact names pulled from a phone address book can come through as
// "Lastname;Firstname" (see whatsapp-export-parsing-gotchas). Flip those to
// "Firstname Lastname" for display — applied at parse time so it's
// consistent everywhere (leaderboard, personal panel, nudge list).
function canonicalizeSender(name) {
  const m = /^([^;]+);([^;]+)$/.exec(name.trim());
  return m ? `${m[2].trim()} ${m[1].trim()}` : name.trim();
}

function parseWhatsAppExport(rawText) {
  const lines = rawText.split(/\r?\n/);
  const messages = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(INVISIBLE_MARKS, '');
    const m = MESSAGE_START.exec(line);
    if (m) {
      if (current) messages.push(current);
      const [, dd, mm, yy, hh, min, , ampm, sender, text] = m;
      const year = yy.length === 2 ? 2000 + parseInt(yy, 10) : parseInt(yy, 10);
      // WhatsApp export dates are locale-dependent (DD/MM vs MM/DD). We assume
      // DD/MM/YYYY (the common non-US default) since this targets an Indian group.
      const date = isoDate(year, parseInt(mm, 10), parseInt(dd, 10));
      current = {
        date,
        sender: canonicalizeSender(sender),
        text: text.trim(),
        rawLines: [text.trim()],
      };
    } else if (current && line.trim().length > 0) {
      // continuation of a multi-line message
      current.rawLines.push(line.trim());
      current.text = current.rawLines.join('\n');
    }
  }
  if (current) messages.push(current);

  // Several members backfill a previous day's numbers in a message sent
  // today (posting "yesterday" and "today" back to back, or writing an
  // explicit date like "20th Sept" / "31/8/26" into the text) — see
  // extractExplicitDate. Override the WhatsApp send-date with whatever date
  // the message itself claims, so those entries land on the right day
  // instead of colliding with (and overwriting) that same day's other post.
  const dated = messages.map(m => {
    const explicit = extractExplicitDate(m.text, m.date);
    return explicit && explicit !== m.date ? { ...m, date: explicit } : m;
  });

  return dated.filter(m => !SYSTEM_LINE.test(m.text));
}

function isoDate(year, month, day) {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function isoDateFromUTC(d) {
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// A message sent on one calendar day can be reporting a different day's
// numbers — "Yesterday Sagar 10556 steps", "(20 Sep) Cardio ...", or a plain
// "31/8/26 ...". Returns an ISO date to use INSTEAD of the WhatsApp send
// date, or null if the text doesn't name a day (the common case — most
// messages are about "today" and should just keep their send date).
function extractExplicitDate(text, sendDateIso) {
  const sendDate = new Date(`${sendDateIso}T00:00:00Z`);

  // "Yesterday", optionally parenthesized, at the start of the message —
  // anchored so casual mid-sentence mentions ("...did yesterday's workout
  // again") don't get misread as a date correction.
  if (/^\(?yesterday\)?\b/i.test(text.trim())) {
    const d = new Date(sendDate);
    d.setUTCDate(d.getUTCDate() - 1);
    return isoDateFromUTC(d);
  }

  // Day + month name, e.g. "20th Sept", "(27 Aug)", "20 Sep" — only near the
  // start of the message (allowing for a leading name/colon/paren), which is
  // where every real backfill in this chat puts it. Without that limit this
  // also matches a casual date mention buried in a sentence — e.g. "Will
  // record next check on 25th Aug" or "What's the count for 18th nov?" —
  // which would wrongly misdate a message that isn't reporting a past day
  // at all.
  const named = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.exec(text);
  if (named && named.index <= 20) {
    const day = parseInt(named[1], 10);
    const month = MONTH_NAMES[named[2].toLowerCase()];
    if (day >= 1 && day <= 31) {
      let year = sendDate.getUTCFullYear();
      let candidate = new Date(Date.UTC(year, month - 1, day));
      // A named date can't be in the future relative to when it was sent —
      // if it looks that way, the reference must be to last year.
      if (candidate > sendDate) candidate = new Date(Date.UTC(year - 1, month - 1, day));
      return isoDateFromUTC(candidate);
    }
  }

  // Plain numeric DD/MM/YY(YY), e.g. "31/8/26 Kuldeep cardio 17000" or
  // "Ranjeet Cardio : 02/09/2026 : 9148 Steps" — same near-the-start limit.
  const numeric = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(text);
  if (numeric && numeric.index <= 20) {
    const day = parseInt(numeric[1], 10);
    const month = parseInt(numeric[2], 10);
    let year = parseInt(numeric[3], 10);
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return isoDate(year, month, day);
    }
  }

  return null;
}

// ---------- Metric extraction ----------

// Each extractor returns a number or null if not found in the text.
// Standardized format: "<Name> : Cardio : 7000 Steps | Strength : 45 min | Mobility : 30 min | Sleep : 7.5 Hours"
// The section label is what matters — order, spacing around ":", units like
// "Steps"/"min"/"Hours", and the leading name are all ignored, so minor
// variations still parse. This also means the same template works as a
// caption on a screenshot, not just a standalone text message.
// Rejects a "Strength"/"Mobility" number when it's actually a frequency
// like "Strength 2-3 days/week" (a plan/goal post, not a minutes-logged
// entry) rather than a real duration.
const NOT_A_DURATION = /^\s*[-–]?\s*\d*\s*(days?|weeks?)\b/i;

// Messages explaining the reporting format itself — e.g. "Sagar Cardio :
// 7000 Steps | ... — this is built with some made up numbers" — can
// contain every keyword a real entry would, but aren't a real report.
// Excluded from metric extraction so they don't get counted as data.
const INSTRUCTIONAL_LINE = /\be\.g\.?\b|\bexample\b|standard format|mandatory (follow|track)|made up numbers|to report (you|your) progress/i;

// Some backfilled messages label the day right inside the value, e.g.
// "Cardio : 02/09/2026 : 9148 Steps" — without this, the extractors below
// would grab the date's own "02" as the step count instead of the real
// 9148 further along. Spliced into each extractor to skip past it.
const DATE_LABEL = '(?:\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\s*:?\\s*)?';

const EXTRACTORS = {
  cardioSteps: text => {
    const m = new RegExp(`cardio\\s*:?\\s*${DATE_LABEL}([\\d,]{2,7})`, 'i').exec(text);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
  },
  strengthMinutes: text => {
    const m = new RegExp(`strength\\s*:?\\s*${DATE_LABEL}(\\d{1,3})(.{0,20})`, 'i').exec(text);
    if (!m || NOT_A_DURATION.test(m[2])) return null;
    return parseInt(m[1], 10);
  },
  mobilityMinutes: text => {
    const m = new RegExp(`mobility\\s*:?\\s*${DATE_LABEL}(\\d{1,3})(.{0,20})`, 'i').exec(text);
    if (!m || NOT_A_DURATION.test(m[2])) return null;
    return parseInt(m[1], 10);
  },
  sleepHours: text => {
    // "7h30m" / "7:30" style (hours + minutes) takes priority over...
    let m = new RegExp(`sleep\\s*:?\\s*${DATE_LABEL}(\\d{1,2})\\s*[:h]\\s*(\\d{1,2})\\s*m?\\b`, 'i').exec(text);
    if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
    // ...plain/decimal hours: "7.5 Hours", "7 hrs", "8"
    m = new RegExp(`sleep\\s*:?\\s*${DATE_LABEL}(\\d{1,2}(?:\\.\\d{1,2})?)\\s*(?:h(?:rs?|ours?)?)?\\b`, 'i').exec(text);
    return m ? parseFloat(m[1]) : null;
  },
};

const METRICS = ['cardioSteps', 'strengthMinutes', 'mobilityMinutes', 'sleepHours'];
const METRIC_META = {
  cardioSteps: { label: 'Cardio', emoji: '🚶', unit: '', fmt: v => Math.round(v).toLocaleString(), bump: 500 },
  strengthMinutes: { label: 'Strength', emoji: '🏋️', unit: ' min', fmt: v => Math.round(v), bump: 5 },
  mobilityMinutes: { label: 'Mobility', emoji: '🧘', unit: ' min', fmt: v => Math.round(v), bump: 5 },
  sleepHours: { label: 'Sleep', emoji: '😴', unit: 'h', fmt: v => v.toFixed(1), bump: 0.5 },
};

function extractMetrics(text) {
  if (INSTRUCTIONAL_LINE.test(text)) return null;
  const metrics = {};
  let found = false;
  for (const [key, fn] of Object.entries(EXTRACTORS)) {
    const val = fn(text);
    if (val !== null) { metrics[key] = val; found = true; }
  }
  return found ? metrics : null;
}

// Turn raw WhatsApp messages into dated per-member entries.
// One entry per (sender, date) — messages are MERGED field-by-field rather
// than overwritten, since it's common for someone to split one day's
// sections across two messages (e.g. cardio in one, mobility in another),
// or to post a same-day backfill for a different date (see
// extractExplicitDate, which is what gives those a different `date` here
// in the first place). Where the same field is reported twice for the same
// day, the later message wins — same as always for a genuine correction.
function buildEntries(messages) {
  const entries = new Map(); // key `${sender}|${date}` -> entry
  const unparsed = [];

  for (const msg of messages) {
    const metrics = extractMetrics(msg.text);
    if (!metrics) {
      // Deliberately no `text` here — real group chat mixes in personal/
      // medical content (blood test results, body measurements) that
      // shouldn't be retained beyond what's needed for the nudge count.
      unparsed.push({ sender: msg.sender, date: msg.date });
      continue;
    }
    const key = `${msg.sender}|${msg.date}`;
    const existing = entries.get(key);
    entries.set(key, {
      sender: msg.sender,
      date: msg.date,
      ...(existing || {}),
      ...metrics,
      rawText: existing ? `${existing.rawText}\n${msg.text}` : msg.text,
    });
  }
  return { entries: Array.from(entries.values()), unparsed };
}

// ---------- Storage (merge new entries into what's already saved) ----------

function loadStoredEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('Could not read stored entries', e);
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function loadStoredUnparsed() {
  try {
    const raw = localStorage.getItem(UNPARSED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('Could not read stored unparsed messages', e);
    return [];
  }
}

function saveUnparsed(unparsed) {
  localStorage.setItem(UNPARSED_KEY, JSON.stringify(unparsed));
}

function mergeEntries(existing, incoming) {
  const map = new Map(existing.map(e => [`${e.sender}|${e.date}`, e]));
  for (const e of incoming) map.set(`${e.sender}|${e.date}`, e);
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Date helpers ----------

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function todayIso() {
  const d = new Date();
  return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function lastNDaysRange(n) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (n - 1));
  return { start: isoDate(start.getFullYear(), start.getMonth() + 1, start.getDate()), end: isoDate(end.getFullYear(), end.getMonth() + 1, end.getDate()) };
}

// ---------- Per-member analytics ----------

// A member with zero parsed entries (hasn't posted in the format yet, or
// only chats/screenshots without a caption) still gets a row — everything
// in it renders as "—" rather than the member disappearing from the
// dashboard entirely.
function emptyMemberStats(sender) {
  return {
    sender,
    entries: [],
    streak: 0,
    completeStreak: 0,
    trends: Object.fromEntries(METRICS.map(k => [k, { earliest: null, recent: null, pctChange: null, best: -Infinity }])),
    consistencyPct: 0,
    lastEntry: null,
  };
}

function analyzeMember(sender, allEntries) {
  const entries = allEntries.filter(e => e.sender === sender).sort((a, b) => a.date.localeCompare(b.date));
  if (entries.length === 0) return emptyMemberStats(sender);

  const streak = computeStreak(entries);
  const completeStreak = computeCompleteStreak(entries);
  const { start: weekStart } = lastNDaysRange(7);
  const recent = entries.filter(e => e.date >= weekStart);
  const early = entries.slice(0, Math.min(7, entries.length));

  const avg = (list, key) => {
    const vals = list.map(e => e[key]).filter(v => typeof v === 'number');
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const trends = {};
  for (const key of METRICS) {
    const recentAvg = avg(recent, key);
    const earlyAvg = avg(early, key);
    trends[key] = {
      earliest: earlyAvg,
      recent: recentAvg,
      pctChange: earlyAvg && recentAvg != null ? ((recentAvg - earlyAvg) / earlyAvg) * 100 : null,
      best: Math.max(...entries.map(e => e[key]).filter(v => typeof v === 'number'), -Infinity),
    };
  }

  const daysActiveSpan = daysBetween(entries[0].date, entries[entries.length - 1].date) + 1;
  const consistencyPct = (entries.length / Math.max(daysActiveSpan, 1)) * 100;

  return {
    sender,
    entries,
    streak,
    completeStreak,
    trends,
    consistencyPct,
    lastEntry: entries[entries.length - 1],
  };
}

function computeStreak(entries) {
  // Longest run of entries on consecutive calendar days, ending at the most recent entry.
  const dates = entries.map(e => e.date);
  let streak = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    if (daysBetween(dates[i - 1], dates[i]) === 1) streak++;
    else break;
  }
  return streak;
}

function computeCompleteStreak(entries) {
  // Consecutive *calendar days* (ending at the most recent entry) where all
  // four sections were logged. A missed day breaks it exactly like a day
  // with an incomplete entry does — both mean the streak didn't carry over.
  const isComplete = e => METRICS.every(k => typeof e[k] === 'number');
  if (!isComplete(entries[entries.length - 1])) return 0;
  let streak = 1;
  for (let i = entries.length - 1; i > 0; i--) {
    if (!isComplete(entries[i - 1])) break;
    if (daysBetween(entries[i - 1].date, entries[i].date) !== 1) break;
    streak++;
  }
  return streak;
}

function nextTarget(metric, best) {
  if (best === -Infinity || best == null) return null;
  return Math.round(best + METRIC_META[metric].bump);
}

// Last date this person posted anything at all — a logged entry or an
// off-format message (screenshot, chat). Used for the "needs a nudge"
// highlight, which is about who's gone quiet, not just whose format slipped.
function lastActivityDate(sender, allEntries, unparsed) {
  const dates = [
    ...allEntries.filter(e => e.sender === sender).map(e => e.date),
    ...unparsed.filter(u => u.sender === sender).map(u => u.date),
  ];
  return dates.length ? dates.sort().at(-1) : null;
}

// ---------- Rendering ----------

const els = {};

function cacheEls() {
  ['fileInput', 'dropZone', 'uploadStatus', 'dashboard', 'mostConsistentList', 'needsNudgeList',
   'groupCards', 'leaderboardBody', 'leaderboardMode', 'memberSelect', 'personalPanel',
   'unparsedPanel', 'unparsedList', 'clearDataBtn', 'exportJsonBtn', 'helpToggle', 'helpBox'].forEach(id => {
    els[id] = document.getElementById(id);
  });
}

function renderAll(allEntries, unparsed) {
  unparsed = unparsed || [];
  // Full roster = everyone who has ever sent a real (non-system) message —
  // not just people who've logged a parseable entry — so a member who
  // hasn't adopted the format yet still shows up with blanks instead of
  // silently vanishing from the dashboard.
  const members = Array.from(new Set([...allEntries.map(e => e.sender), ...unparsed.map(u => u.sender)])).sort();
  els.dashboard.classList.toggle('hidden', members.length === 0);

  renderHighlights(allEntries, unparsed, members);
  renderGroupCards(allEntries, members);
  renderLeaderboard(allEntries, members);
  renderMemberSelect(members);
  renderUnparsed(unparsed);
}

// The first thing anyone should see: who's on a roll, and who's gone quiet
// long enough that a nudge would help. Deliberately above the group stats
// and leaderboard.
function renderHighlights(allEntries, unparsed, members) {
  const today = todayIso();

  const consistent = members
    .map(m => analyzeMember(m, allEntries))
    .filter(r => r.entries.length > 0)
    .sort((a, b) => b.streak - a.streak || b.consistencyPct - a.consistencyPct)
    .slice(0, 5);

  els.mostConsistentList.innerHTML = consistent.length
    ? consistent.map((r, i) => `
      <div class="highlight-row">
        <span class="highlight-rank">${i + 1}</span>
        <strong>${escapeHtml(r.sender)}</strong>
        <span class="muted">🔥 ${r.streak}-day streak · ${Math.round(r.consistencyPct)}% consistent</span>
      </div>
    `).join('')
    : `<p class="muted">No logged entries yet.</p>`;

  // Ranked by days since the last post of ANY kind — logged entry or
  // off-format message — so someone who's fully gone quiet outranks someone
  // whose recent posts just missed the format.
  const gaps = members
    .map(sender => {
      const last = lastActivityDate(sender, allEntries, unparsed);
      return { sender, daysSince: last ? daysBetween(last, today) : null };
    })
    .sort((a, b) => (b.daysSince ?? -1) - (a.daysSince ?? -1))
    .slice(0, 5);

  els.needsNudgeList.innerHTML = gaps.map(g => `
    <div class="highlight-row ${g.daysSince == null || g.daysSince >= 3 ? 'urgent' : ''}">
      <strong>${escapeHtml(g.sender)}</strong>
      <span class="muted">${
        g.daysSince == null ? 'No activity yet'
        : g.daysSince === 0 ? 'Posted today'
        : `Last posted ${g.daysSince} day${g.daysSince === 1 ? '' : 's'} ago`
      }</span>
    </div>
  `).join('');
}

function renderGroupCards(allEntries, members) {
  const { start } = lastNDaysRange(7);
  const activeThisWeek = members.filter(m => allEntries.some(e => e.sender === m && e.date >= start));
  const weekEntries = allEntries.filter(e => e.date >= start);

  const avgRaw = key => {
    const vals = weekEntries.map(e => e[key]).filter(v => typeof v === 'number');
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const avg = key => { const v = avgRaw(key); return v == null ? '—' : Math.round(v); };
  const fullLogPct = weekEntries.length
    ? Math.round((weekEntries.filter(e => METRICS.every(k => typeof e[k] === 'number')).length / weekEntries.length) * 100)
    : '—';

  const sleepAvg = avgRaw('sleepHours');
  els.groupCards.innerHTML = `
    <div class="card"><div class="card-value">${members.length}</div><div class="card-label">Total participants</div></div>
    <div class="card"><div class="card-value">${activeThisWeek.length}</div><div class="card-label">Active this week</div></div>
    <div class="card"><div class="card-value">${avg('cardioSteps')}</div><div class="card-label">Avg Cardio steps (7d)</div></div>
    <div class="card"><div class="card-value">${avg('strengthMinutes')}</div><div class="card-label">Avg Strength (min, 7d)</div></div>
    <div class="card"><div class="card-value">${avg('mobilityMinutes')}</div><div class="card-label">Avg Mobility (min, 7d)</div></div>
    <div class="card"><div class="card-value">${typeof sleepAvg === 'number' ? sleepAvg.toFixed(1) + 'h' : '—'}</div><div class="card-label">Avg Sleep (7d)</div></div>
    <div class="card"><div class="card-value">${fullLogPct}${fullLogPct !== '—' ? '%' : ''}</div><div class="card-label">Full 4-section logs (7d)</div></div>
  `;
}

function renderLeaderboard(allEntries, members) {
  const mode = els.leaderboardMode.value;
  const rows = members.map(m => analyzeMember(m, allEntries)).filter(Boolean);

  let sorted;
  if (mode === 'consistency') {
    sorted = rows.slice().sort((a, b) => b.streak - a.streak || b.consistencyPct - a.consistencyPct);
  } else if (mode === 'improvement') {
    const score = r => METRICS
      .map(k => r.trends[k].pctChange)
      .filter(v => typeof v === 'number')
      .reduce((a, b) => a + b, 0);
    sorted = rows.slice().sort((a, b) => score(b) - score(a));
  } else {
    sorted = rows.slice().sort((a, b) => ((b.lastEntry && b.lastEntry.cardioSteps) || 0) - ((a.lastEntry && a.lastEntry.cardioSteps) || 0));
  }

  els.leaderboardBody.innerHTML = sorted.map((r, i) => {
    const le = r.lastEntry || {};
    const imp = k => r.trends[k].pctChange != null ? `${r.trends[k].pctChange > 0 ? '↑' : '↓'}${Math.abs(Math.round(r.trends[k].pctChange))}%` : '—';
    return `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(r.sender)}</td>
      <td>${le.cardioSteps != null ? le.cardioSteps.toLocaleString() : '—'} <span class="muted">${imp('cardioSteps')}</span></td>
      <td>${le.strengthMinutes != null ? le.strengthMinutes + ' min' : '—'} <span class="muted">${imp('strengthMinutes')}</span></td>
      <td>${le.mobilityMinutes != null ? le.mobilityMinutes + ' min' : '—'} <span class="muted">${imp('mobilityMinutes')}</span></td>
      <td>${le.sleepHours != null ? le.sleepHours.toFixed(1) + 'h' : '—'} <span class="muted">${imp('sleepHours')}</span></td>
      <td>${r.entries.length ? `🔥 ${r.streak}d <span class="muted">(${r.completeStreak}d full)</span>` : '—'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">No parsed entries yet.</td></tr>`;
}

function renderMemberSelect(members) {
  const prev = els.memberSelect.value;
  els.memberSelect.innerHTML = members.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  if (members.includes(prev)) els.memberSelect.value = prev;
  if (members.length) renderPersonalPanel(members.includes(prev) ? prev : members[0]);
  else els.personalPanel.innerHTML = '';
}

function renderPersonalPanel(sender) {
  const allEntries = mergeEntries(loadStoredEntries(), []); // just read current storage
  const r = analyzeMember(sender, allEntries);
  if (!r) { els.personalPanel.innerHTML = ''; return; }

  const metricCard = key => {
    const meta = METRIC_META[key];
    const t = r.trends[key];
    const arrow = t.pctChange == null ? '' : t.pctChange >= 0 ? `<span class="up">↑ ${Math.round(t.pctChange)}%</span>` : `<span class="down">↓ ${Math.abs(Math.round(t.pctChange))}%</span>`;
    const target = nextTarget(key, t.best);
    return `<div class="metric-card">
      <div class="metric-title">${meta.emoji} ${meta.label}</div>
      <div class="metric-value">${t.recent != null ? meta.fmt(t.recent) + meta.unit : '—'} ${arrow}</div>
      <div class="metric-sub">Best: ${t.best !== -Infinity ? meta.fmt(t.best) + meta.unit : '—'}${target != null ? ` · Next target: ${meta.fmt(target)}${meta.unit}` : ''}</div>
      ${sparkline(r.entries, key)}
    </div>`;
  };

  els.personalPanel.innerHTML = `
    <div class="personal-header">
      <h3>${escapeHtml(sender)}</h3>
      <div class="badges">
        <span class="badge">🔥 ${r.streak}-day streak</span>
        <span class="badge">✅ ${r.completeStreak}-day full-log streak</span>
        <span class="badge">${Math.round(r.consistencyPct)}% consistent</span>
      </div>
    </div>
    <div class="metric-grid">
      ${METRICS.map(metricCard).join('')}
    </div>
  `;
}

function sparkline(entries, key) {
  const vals = entries.map(e => e[key]).filter(v => typeof v === 'number');
  if (vals.length < 2) return '';
  const w = 200, h = 36, pad = 3;
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const points = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${points}" /></svg>`;
}

function renderUnparsed(unparsed) {
  els.unparsedPanel.classList.toggle('hidden', unparsed.length === 0);
  const bySender = new Map();
  for (const m of unparsed) {
    bySender.set(m.sender, (bySender.get(m.sender) || 0) + 1);
  }
  // Deliberately count-only, no message snippet: real group chat mixes in
  // things like health/medical details, birthday banter, etc. that
  // shouldn't get echoed onto a leaderboard other members can see.
  els.unparsedList.innerHTML = Array.from(bySender.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([sender, count]) => `
      <div class="unparsed-row">
        <strong>${escapeHtml(sender)}</strong> — ${count} message(s) not recognized as a progress entry
      </div>
    `).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Wiring ----------

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const messages = parseWhatsAppExport(reader.result);
      const { entries: newEntries, unparsed } = buildEntries(messages);
      const merged = mergeEntries(loadStoredEntries(), newEntries);
      saveEntries(merged);
      saveUnparsed(unparsed);
      els.uploadStatus.textContent = `Imported ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'} from ${messages.length} messages (${unparsed.length} not recognized).`;
      renderAll(merged, unparsed);
    } catch (e) {
      console.error(e);
      els.uploadStatus.textContent = 'Could not parse that file — is it a WhatsApp "Export chat" .txt file?';
    }
  };
  reader.readAsText(file);
}

function init() {
  cacheEls();

  els.fileInput.addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  ['dragover', 'dragenter'].forEach(evt =>
    els.dropZone.addEventListener(evt, e => { e.preventDefault(); els.dropZone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(evt =>
    els.dropZone.addEventListener(evt, e => { e.preventDefault(); els.dropZone.classList.remove('drag'); }));
  els.dropZone.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  els.dropZone.addEventListener('click', () => els.fileInput.click());

  els.leaderboardMode.addEventListener('change', () => renderAll(loadStoredEntries(), loadStoredUnparsed()));
  els.memberSelect.addEventListener('change', () => renderPersonalPanel(els.memberSelect.value));

  els.clearDataBtn.addEventListener('click', () => {
    if (confirm('Clear all imported data from this browser? This cannot be undone.')) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(UNPARSED_KEY);
      localStorage.removeItem(SEED_LABEL_KEY);
      renderAll([], []);
      els.uploadStatus.textContent = 'Data cleared. Drop a WhatsApp export above to reload it.';
    }
  });

  els.exportJsonBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(loadStoredEntries(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `healthy-together-backup-${todayIso()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  els.helpToggle.addEventListener('click', () => els.helpBox.classList.toggle('hidden'));

  // Seed (or re-seed) with the real data already parsed from the group's
  // WhatsApp export, so the dashboard never shows dummy or stale data.
  // real-data.js (loaded before this file) defines
  // SEED_ENTRIES/SEED_UNPARSED/SEED_LABEL when present. This runs not just
  // on a completely empty browser, but any time SEED_LABEL has changed
  // since this browser last applied a seed — otherwise a returning visitor
  // would be stuck on whatever real-data.js looked like the very first time
  // they opened the page, even after we ship a freshly re-parsed export.
  // Merging (not replacing) preserves anything the visitor uploaded locally
  // that isn't in the baked-in seed.
  let entries = loadStoredEntries();
  let unparsed = loadStoredUnparsed();
  const appliedSeedLabel = localStorage.getItem(SEED_LABEL_KEY);
  if (typeof SEED_ENTRIES !== 'undefined' && appliedSeedLabel !== SEED_LABEL) {
    entries = mergeEntries(entries, SEED_ENTRIES);
    unparsed = SEED_UNPARSED || [];
    saveEntries(entries);
    saveUnparsed(unparsed);
    if (typeof SEED_LABEL !== 'undefined') localStorage.setItem(SEED_LABEL_KEY, SEED_LABEL);
    els.uploadStatus.textContent = `Loaded ${entries.length} real logged entr${entries.length === 1 ? 'y' : 'ies'} from the group's WhatsApp export${typeof SEED_LABEL !== 'undefined' ? ` (${SEED_LABEL})` : ''}. Drop a newer export above to update it.`;
  }
  renderAll(entries, unparsed);
}

document.addEventListener('DOMContentLoaded', init);
