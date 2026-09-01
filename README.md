# Healthy Together

A zero-friction dashboard for a WhatsApp fitness group. No app to install, no
WhatsApp API, no server, no accounts. This is **Phase 1** of the plan:

```
WhatsApp group → Export chat (.txt) → upload to this page → dashboard
```

## Run it

No build step. Any static file server works, e.g.:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/index.html`.

(Opening `index.html` directly via `file://` also works in most browsers,
since there's no backend — it's just HTML/CSS/JS.)

## How to use it

1. In the WhatsApp group: **⋮ (or Settings) → More → Export chat → Include
   media**. You'll get a `.zip` — unzip it and use the `_chat.txt` inside.
   ("Without media" is smaller, but strips captions on some WhatsApp
   versions — since this reads screenshot captions, include media to be
   safe. The photos/videos aren't used or uploaded anywhere.)
2. Drop `_chat.txt` onto the page (or click to choose it).
3. The dashboard updates immediately.

Data is parsed **in your browser** and stored only in `localStorage` — nothing
is uploaded anywhere. Re-exporting and re-uploading later just merges in new
days; nothing is duplicated (each entry is keyed by member + date).

## Message format

Progress is standardized into four sections — **Cardio, Strength, Mobility,
Sleep**:

```
Sagar : Cardio : 7000 Steps | Strength : 45 min | Mobility : 30 min | Sleep : 7.5 Hours
```

- **Cardio** in **steps** — the one number every phone/watch already tracks in
  the background for basically any on-your-feet activity, no app to open.
- **Strength** and **Mobility** in **minutes** — read the session duration off
  whichever app you used (weights, calisthenics, yoga, pilates...).
- **Sleep** in **hours** — whatever your sleep tracker (or a guess) shows.

**Keep posting screenshots exactly like today — just paste this line as the
caption** instead of sending the screenshot bare. WhatsApp captions come
through in the exported chat text right next to the image reference, so the
parser reads it the same as a typed message. No new habit to build, just one
line added to what people already do.

The parser doesn't care about order, spacing around `:`, or units like
"Steps"/"min"/"Hours" — it just looks for the words "Cardio", "Strength",
"Mobility" and "Sleep" anywhere in the message, each followed by a number.
So this also parses fine, caption or not:

```
Strength: 40 min | Cardio 6,500 | Sleep 7:30 | Mobility - 15min
```

A message can include just some of the four sections (e.g. rest day, no
mobility that day) — whatever's missing simply shows as "—" for that entry.
A screenshot posted with no caption (or caption text that doesn't match)
shows up in the **"Needs a nudge"** section so an admin can see who isn't
following the format yet.

Recognized fields, each independent and optional per message:
| Section  | Unit  | Keyword matched     | Also understood                 |
|----------|-------|----------------------|-----------------------------------|
| Cardio   | steps | "Cardio" + number   | "6,500" (comma-formatted)         |
| Strength | min   | "Strength" + number | —                                  |
| Mobility | min   | "Mobility" + number | —                                  |
| Sleep    | hours | "Sleep" + number    | "7:30", "7h30m", "7.5h", "8"       |

## What the dashboard shows

- **Group** — participants, active-this-week, weekly averages per section, and
  what share of this week's messages logged all four sections.
- **Leaderboard** — sortable by *consistency (streak)*, *improvement*, or raw
  latest Cardio steps. Consistency/improvement are the defaults on purpose,
  so a naturally fit member with high raw numbers doesn't automatically "win"
  over someone who started lower and is improving faster. The streak column
  also shows a "full" streak — consecutive *calendar days* all four sections
  were logged (a missed day, or an incomplete entry, both break it).
- **Personal progress** — per-member Cardio/Strength/Mobility/Sleep trend vs.
  their own earliest week, personal best, a suggested next target, and a
  sparkline. This is the "beat your best" framing from the plan, not just a
  rank number.
- **Needs a nudge** — how many of each member's messages didn't parse (no
  section matched at all — a bare screenshot, an off-format caption, or
  free-form chat). Shows counts only, never the message text.

## Real data baseline

The dashboard ships pre-loaded with the group's actual WhatsApp export
(`WhatsApp_Walchandites Healthy Together/_chat.txt`, 2026-08-18 to 2026-09-01),
parsed into `real-data.js`. Opening the page with an empty browser shows this
real data immediately — no upload needed, and nothing fabricated. Dropping a
newer export on the page merges on top of it and takes over from there, same
as always.

As of that export: **9 real logged entries from 5 of the 17 group members**
(Sagar, Anand Kulkarni, Abhijeet Khobare, Kuldeep Walujkar, Ranje Savardekar).
The other 12 members have posted plenty in the chat — screenshots, "did X
today" messages — just not yet in the Cardio/Strength/Mobility/Sleep format,
so they show up with "—" everywhere rather than being fabricated or hidden.
That's the real state of Phase 2 adoption, not a bug.

A few real-world parsing wrinkles found and handled while building this
baseline (see `app.js` comments for the actual regexes):
- **Contact names as "Lastname;Firstname"** (a phone address-book quirk) are
  flipped to "Firstname Lastname" for display — applies to about half the
  roster.
- **WhatsApp's own "pinned a message" / "requested to join" lines** are
  filtered as system lines now (they aren't real posts).
- **Messages explaining the format itself** (e.g. Sagar's own "Sagar Cardio :
  7000 Steps | ... this is built with some made up numbers" posts) are
  excluded from metric extraction — they'd otherwise be counted as that
  person's real data.
- **"Strength 2-3 days/week"** (a plan/goal post) no longer gets misread as a
  2-minute strength entry — a duration keyword followed by "day(s)"/"week(s)"
  is rejected.
- Several people post a manually-typed date in the message itself ("Anand (27
  Aug)", "31/8/26 Kuldeep...") that doesn't match the day they actually sent
  it. The dashboard uses the *send* date, not the typed one — worth a look if
  a "latest" number ever seems to lag by a day.
- The "Needs a nudge" panel intentionally shows **counts only, never message
  text** — real group chat mixes in things like blood test results and body
  measurements that shouldn't be echoed onto a dashboard other members can see.

## Data & privacy

- Everything lives in this browser's `localStorage` (keys
  `healthy-together:entries:v2` and `healthy-together:unparsed:v1`). Clearing
  browser data clears it — the page falls back to the `real-data.js` baseline
  again.
- **Export backup (JSON)** downloads a snapshot you can keep or hand to
  someone else's browser.
- **Clear all data** wipes local storage (asks for confirmation first).
- The exported photos/videos themselves are never read or uploaded — only the
  `_chat.txt` text file is used, and only the caption text inside it.

## Files

| File                          | Purpose                                          |
|-------------------------------|---------------------------------------------------|
| `index.html`                  | Page structure                                    |
| `style.css`                   | Styling (light/dark aware)                        |
| `app.js`                      | WhatsApp export parsing + dashboard logic         |
| `real-data.js`                | Real, non-fabricated baseline parsed from the group's actual export — loaded on first visit (see "Real data baseline") |
| `mock-whatsapp-export.txt`    | Mock export with all real group members, dummy Cardio/Strength/Mobility/Sleep data for the last 7 days — drop it on the page to preview the dashboard before the group has adopted the new format |

The mock file also doubles as a template you can point the group at: it shows
exactly what a well-formed message (and a missed day, and a lingering
screenshot) looks like once exported and parsed.

## Roadmap (from the original plan)

- **Phase 1 (this)** — export → upload → dashboard, zero friction.
- **Phase 2** — get everyone using the standardized daily message format
  consistently (the "Needs a nudge" list helps drive this).
- **Phase 3** — real-time automation via a WhatsApp Business/API integration
  feeding a database and a live dashboard. Meaningfully more setup and
  subject to WhatsApp platform restrictions — worth doing only once Phase 1/2
  prove the group actually uses this.
