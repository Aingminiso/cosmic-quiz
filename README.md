# 🌌 Cosmic Quiz — Online

Node.js + Express backend for the Cosmic Quiz party game. No database —
everything lives in memory on the server while it's running.

Players just open one shared link in their phone/laptop browser — no app
install needed on either side.

## 🚀 Deploy for free (no local install needed) — Render.com

You don't need Node.js, npm, or git installed on your computer. Everything
happens in the browser.

1. **Put the code on GitHub** (skip if you already have a repo):
   - Go to [github.com/new](https://github.com/new), create a new repo
     (e.g. `cosmic-quiz`), keep it **Public** or **Private**, don't add a
     README (you already have one).
   - On the new repo page, click **"uploading an existing file"**, then
     drag in `server.js`, `package.json`, `README.md`, and the whole
     `public` folder (with `index.html` inside it). Commit.

2. **Create the web service on Render**:
   - Go to [render.com](https://render.com) → sign up free (can use your
     GitHub account) → **New +** → **Web Service**.
   - Connect the `cosmic-quiz` repo you just created.
   - Settings:
     - **Environment**: Node
     - **Build Command**: `npm install`
     - **Start Command**: `node server.js`
     - **Instance Type**: Free
   - Click **Create Web Service**.

3. Wait ~1–2 minutes for the first deploy. Render gives you a public URL
   like `https://cosmic-quiz-xxxx.onrender.com` — **that's your game link**,
   shareable with anyone, anywhere (not just the same Wi-Fi anymore).

4. Open that URL, create a room, share the room code or invite link with
   your players (they can be on any network), everyone hits ready, and the
   host starts the mission.

**Free-tier note:** Render's free web services spin down after ~15 minutes
of no traffic and take ~30–50s to wake back up on the next visit. Open the
link a minute before your game starts so it's already warm. (Render's paid
tier, or alternatives like Railway/Fly.io, avoid the sleep if this becomes
annoying — but free is fine for occasional game nights.)

### Updating the game later
Edit files on GitHub directly (pencil icon on each file) or re-upload via
"Add file → Upload files" — Render auto-redeploys on every push to the repo.

## Run it locally instead (optional)

If you do have Node.js installed and want to test on your own machine:

```bash
npm install
npm start
```

The server prints something like:

```
🌌 COSMIC QUIZ server running
   Local:        http://localhost:3000
   LAN:          http://192.168.1.23:3000
```

To change the port: `PORT=8080 npm start`.

## How it works

- `server.js` — the whole backend. In-memory `Map` of rooms, no timers/cron —
  the current phase (lobby → question → reveal → ... → end) is derived on
  every request from `Date.now() - room.gameStartAt`, so every connected
  client always sees a perfectly in-sync countdown with zero drift, even
  after a page refresh.
- `public/index.html` — the frontend, served as a static file. It only ever
  calls the API with relative paths (`fetch('/api/...')`) and builds the
  invite link from `location.origin`, so it works identically whether the
  server is on `localhost`, your LAN, or a public cloud URL — no code
  changes needed between environments.

## Scoring

- Base points by difficulty: easy `100`, medium `200`, hard `300`.
- Speed bonus: up to +50% of base points, scaled by how much time was left
  when you answered.
- Combo multiplier based on your current correct-answer streak:
  `x1` → `x1.2` (streak 2) → `x1.5` (streak 3–4) → `x2` (streak 5+).
  A wrong answer or timeout resets your streak to 0.

## Bots

"เพิ่มบอท" adds an AI player with a random Thai codename. Bots are always
"ready", and answer each question automatically with a difficulty-scaled
chance of getting it right (85% easy / 65% medium / 45% hard) after a random
1.5–7.5s "thinking" delay, so a solo host can fully test/demo the game flow.

## Who answered what

On the reveal screen, everyone in the room sees a full breakdown of every
player's pick for that question (correct picks first, so you can spot
exactly who to roast) — not just your own answer. Bots are included and
labeled 🤖; anyone who ran out the clock without answering shows up as
"หมดเวลา" instead of a picked option.

## Timing

- Each question normally runs for `QUESTION_TIME` seconds, followed by
  `REVEAL_TIME` seconds showing the answer and leaderboard.
- If every player in the room (including bots) answers before the timer
  runs out, the question ends immediately and reveal starts right away —
  no need to sit through a countdown once everyone's already answered.
  The reveal screen still gets its full `REVEAL_TIME` regardless. This
  needs no extra timers: the server just permanently fast-forwards its
  time-based phase formula by however many seconds were skipped
  (`room.timeSaved` in `server.js`), so it stays driftless and stateless
  across polls exactly like before.

## Question categories

Questions are grouped under a top-level "topic". Two topics exist today:
**🌌 ดาราศาสตร์ (Astronomy)** and **🧬 ชีววิทยา (Biology)**. In the lobby,
the host sees a "🗂️ หมวดหมู่คำถาม" picker showing available topics as
toggle chips — only the topics selected there are drawn from when the
match starts (`GET /api/topics`, `POST /api/rooms/:code/topics`, filtered
in `room.topics` on `server.js`). Adding a future topic is just: tag new
`BANK` entries with `topic:'<key>'` and add a matching entry to the
`TOPICS` array in `server.js` — the picker automatically becomes
interactive, no other changes needed.

## Randomization

- Each match draws a fresh, fully shuffled random subset of the question
  bank (`shuffle(BANK).slice(0, MAX_QUESTIONS)`) — question order is never
  sequential by category or difficulty, and never repeats the same order
  twice.
- On top of that, each question's 4 answer options are independently
  shuffled per match too, so the correct answer isn't predictably sitting
  in the same slot every time a question comes up.

## Notes / limits

- State is in-memory only — restarting the server (or a Render free-tier
  sleep/wake cycle) clears all rooms. Start rooms fresh right before playing.
- Rooms with no human heartbeat for 30 minutes are automatically cleaned up.
- Question bank has 132 questions across 2 topics (ดาราศาสตร์ 82, ชีววิทยา
  50), each split into 5 sub-categories × 3 difficulties; each match
  randomly samples up to 20 of them from the topic(s) selected in the lobby
 (`MAX_QUESTIONS` in `server.js`).
- To tweak timing, edit `QUESTION_TIME` / `REVEAL_TIME` in `server.js` — just
  make sure `QUESTION_TIME` still matches the `QUESTION_TIME` constant near
  the top of the `<script>` in `public/index.html` (used for the client-side
  smooth timer animation between polls).
