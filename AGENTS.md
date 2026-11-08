# Agent guide — Word Party

## Product goal
Build and maintain a friendly, local, pass-and-play party game where players help others guess meaningful words.

## Stack
- Frontend: React 18 + Vite
- Backend: Node.js + Express
- Database: SQLite through Node's built-in `node:sqlite` (Node 22.13+, no native npm dependency). Code in `server/db.js`; file at `DB_PATH` (default `data/word-party.db`, `/app/data/word-party.db` in Docker).
- Deployment: Docker Compose; one application container listens on 8080 inside the container and is published on host port **8085** (8080 is already used by the Stock app on the same host). `./data` is mounted at `/app/data` so the database survives rebuilds and `docker compose down`.
- No external service is required. The `npm start` script passes `--disable-warning=ExperimentalWarning` because `node:sqlite` is still flagged experimental.

## Core rules
- Minimum two players, maximum 12 (`MAX_PLAYERS` in `src/main.jsx`; the setup screen, "Who's up?" grid, results and copied results all adapt to the count, so raise it there only).
- Turn length is chosen on the setup screen, before the game starts: 2, 3, 5, 7, 10 or 15 minutes (default 7). It applies to every player and cannot change mid-game.
- Each player receives one turn of that length. Players choose their own name from those who haven't played yet; turn order is not fixed.
- The active clue-giver sees the current word; the rest of the group guesses.
- Supported clue styles: Explain (do not say the target word or its obvious spelling), Act (gesture), Sound (non-verbal sounds).
  - **Make sounds only draws sound-friendly words** (words flagged in the category's `sound` list, such as animals, vehicles, instruments and noisy actions). The category picker on the "Who's up?" screen and mid-turn then lists only categories that have sound words, with their sound-word counts; switching to Make sounds from a category without any falls back to All categories.
- Difficulty scores: Easy = 1, Medium = 2, Hard = 5.
- Difficulty can be changed before every word. A correctly guessed word awards the active player the points of that word's own difficulty. Skipped words award zero.
- The category can be changed mid-turn from a picker with a Back button. This must never pause, reset, or otherwise affect the timer (the timer runs from a fixed deadline).
- When the timer expires, return to the "Who's up?" screen. The game ends after each player has had one turn.
- Results screen: announce the highest scorer (show all tied winners), per-player guessed/skipped/points, the group's all-time leaderboard, play again with the same players, copy results, or start fresh.

## Saved groups and leaderboard
- Starting a game saves the group (name + players + turn length) to SQLite: a new group is created, or the loaded group is updated in place. The group name is optional; it defaults to the player names.
- The setup screen lists saved groups (most recently played first). Tapping one loads its players and turn length; **Start a new group instead** clears the selection; **Delete** removes the group and all its games (asks first).
- Every game is a row in `games` with the line-up, turn length, word logs and finished-player indexes. Progress is saved after every finished turn and every review change (debounced ~400ms, flushed with a `keepalive` request on `pagehide`, Play again and Start fresh). Nothing is sent mid-turn: a turn interrupted by closing the tab is simply played again.
- A group with an unfinished game shows **Resume game · x/y turns**, which restores the game on the "Who's up?" screen (or results if every turn was done). Only one unfinished game per group is kept; starting a new one discards the old. **Quit game** deletes the unfinished game.
- When the results screen appears the game is marked `finished`; later review edits keep updating that same row, so the all-time leaderboard stays correct.
- The all-time leaderboard is **derived on the server from the stored word logs** (same Easy 1 / Medium 2 / Hard 5 rule as `summarize`; keep `server/db.js` in sync if scoring changes). Per player name (case-insensitive): games, wins (every tied top scorer with more than 0 points gets a win), total points, guessed, skipped, best game. Sorted by wins, then points.
- If the server can't be reached the game still plays; a small error explains that the result may not be kept.
- Word review: every word a clue-giver sees is logged per player with its result (`guessed` or `skipped`). Guessed/skipped counts, points, rankings and the winner are always **derived from that log** (`summarize`), never stored separately, so they cannot drift out of sync.
  - Review is available as soon as a player finishes, not only at the end. The "Who's up?" screen shows a recap with a **Review words** button for the player who just finished, and **every finished player keeps their own Review words button** under their name until the game ends, so earlier players can be corrected at any time. Starting the next turn closes any open review.
  - On the results screen every player row has a **Review** button.
  - In review, each word can be switched between **Guessed** and **Skipped**. Points use that word's own difficulty, and the leaderboard and winner update immediately.
  - A word still on screen when the turn ends (time up or ended early) is logged as skipped and labelled "on screen when time ran out", so it can be corrected.
  - Review edits only change scores. They do not touch the remembered-words list used to avoid repeats.

## UX requirements
- Keep the active word prominent and private to the clue-giver's view.
- Make the timer visible and warn visually in the final 30 seconds.
- Make score changes immediate and visible.
- Support name, category, and difficulty selection before each player's turn, and difficulty/category changes during the turn.
- Show live turn stats (guessed, skipped, points) and flash the points earned on each correct guess.
- Let players check and correct what was recorded (word review) after their turn and again at the end of the game. Review toggles must be at least 44px tall.
- Provide responsive layouts for desktop, tablet, and phone. **Tablets are the primary target** (a shared device passed around a group):
  - Touch targets are at least 44px tall; text inputs are at least 16px (avoids iOS zoom-on-focus).
  - At 601px and wider, type and controls scale up; at 900px and wider the game screen uses two columns (word on the left, stats and controls on the right).
  - Buttons use `touch-action: manipulation`, there is no pull-to-refresh (`overscroll-behavior: none`), and sticky hover states are disabled on touch devices.
  - The Screen Wake Lock API keeps the screen on during play where supported (needs HTTPS or localhost; silently ignored otherwise).
  - Respect safe-area insets (`viewport-fit=cover`) and add new controls with tablet tap size in mind.

## API
- `GET /api/categories`: list categories with `count` (all words) and `soundCount` (sound-friendly words).
- `POST /api/word` with `{ category, difficulty, mode, exclude: [ids] }`: random matching word `{ id, word, category, difficulty, sound }`. `mode: "sound"` keeps only sound-friendly words. **The client uses this POST form**, because the exclude list can be thousands of ids, far too long for a URL.
  - 404 `{ exhausted: true, poolIds }`: every word in that pool was excluded; the client forgets just those ids (except ones already shown in this game) and retries.
  - 404 `{ exhausted: false }`: the selection has no words at all (for example no sound words for that category/difficulty).
- `GET /api/word?category=&difficulty=&mode=&exclude=<comma-separated-ids>`: same, kept for quick manual testing.
- `GET /api/health`: health check.
- `GET /api/groups`: saved groups with `gamesPlayed`, `lastPlayedAt` and `activeGame` (`{ id, turnsPlayed, players }` or null).
- `POST /api/groups` / `PUT /api/groups/:id` with `{ name, players, turnMinutes }`: create or update a group (2–12 unique names, max 24 chars each; name max 40; turn length must be one of the allowed options, else 7).
- `DELETE /api/groups/:id`: delete a group and its games.
- `GET /api/groups/:id/leaderboard`: `{ games, players: [{ name, games, wins, points, guessed, skipped, best, rank }] }`.
- `POST /api/groups/:id/games` with `{ players, turnMinutes }`: start a game (drops any other unfinished game of the group).
- `GET /api/games/:id`, `PUT /api/games/:id` with `{ logs, played, status: 'playing' | 'finished' }`, `DELETE /api/games/:id`.
- Request bodies are validated and normalised on the server; unknown `/api/*` routes return JSON 404.

## Word list
`server/words.json` is grouped by category, then difficulty:
```json
"Animals": { "prefix": "animal", "easy": ["Cat", "..."], "medium": ["..."], "hard": ["..."], "sound": ["Cat", "Dog", "..."] }
```
- The server expands this into `{ id, word, category, difficulty }` entries at startup. Ids are `<prefix>-<slug of the word>` (for example `animal-cat`), so keep prefixes stable.
- `sound` (optional) lists the words of that category, from any difficulty, that a player can clue with non-verbal noises alone. Only those are used by the Make sounds style. Be strict: add a word only if it has its **own recognisable sound** that a group could guess from noises alone (animal calls, engines and vehicles, instruments, household machines, weather, body noises such as sneezing). Never tag movie titles, people or character names, abstract or technical terms, places, or anything that is silent or only guessable by saying words. A category with no sound words (Movies & Actors) is simply left out of the picker in Make sounds mode. Hard-level sound words are rare, so the Hard pool is small in that mode.
- The server refuses to start if two words produce the same id, if the same word (case-insensitive) appears in two categories (the "All categories" pool would show it twice), or if a `sound` word isn't in that category's lists.
- Keep pools large so words don't repeat across games: aim for about 140+ easy and 80+ medium/hard words per category. Current size: **16 categories, 5,823 words** (2,461 easy, 1,702 medium, 1,660 hard), of which 533 are sound-friendly (Movies & Actors has none). Categories: Animals, Food & Drink, Everyday Objects, Places, Actions, Nature, People & Jobs, Sports & Hobbies, Travel & Transport, Science & Tech, Music & Arts, Body & Health, Clothing & Fashion, Fantasy & Legends, Toys & Games, Movies & Actors (prefix `cinema`: famous films, actors, directors and iconic characters).
- Never remove or rename an existing word or prefix unless intended: ids are stored in played-word memory and saved game logs.
- A flat array of `{ id, word, category, difficulty }` entries is still accepted.
- The client sends only the ids already played in the requested category/difficulty pool.

## Icon
The browser-tab icon is a gold rounded square with a dark "W" (the same mark as the in-app logo). Files live in `public/` and Vite copies them into `dist/`: `favicon.svg` (main), `favicon.ico` (fallback) and `apple-touch-icon.png` (180px, for Add to Home Screen on tablets). `index.html` links them with root-style hrefs, which Vite rewrites to relative `./favicon.svg` because of `base: './'`, so they also load behind Caddy at `/word-party/`. Regenerate the PNG/ICO from the SVG with `rsvg-convert` if the design changes.

## Running behind Caddy
The app runs behind the Caddy reverse proxy in `../caddy` at `http://<host>:8800/word-party/` (dashboard tile "Word Party"), and also works directly at `http://<host>:8085/`. It needs **no** extra configuration, base-path variable or environment setting in either case.
- Caddy route: `redir /word-party /word-party/` plus `handle /word-party/*` with `uri strip_prefix /word-party` and `reverse_proxy host.docker.internal:8085`, so the app never sees the prefix.
- This works only because the client uses **relative URLs**. Keep it that way:
  - `vite.config.js` sets `base: './'`, so built assets load from `./assets/...`.
  - Client code calls `fetch('api/...')` with **no leading slash**. Never write `fetch('/api/...')` or root-absolute `/assets/...` / `/images/...` paths, because behind the proxy those hit the wrong service (Caddy sends `/api/*` to the Admin Console).
  - The page must be opened with a trailing slash (`/word-party/`); Caddy redirects `/word-party` for you.
- Do not change host port 8085 without also changing the Caddyfile route and the dashboard tile in `../caddy`.
- The Screen Wake Lock needs HTTPS or localhost, so it is not active over plain `http://<host>:8800`; this is expected.

## Development
```bash
npm install
npm run dev
```
Run frontend and API together with `npm run dev:all` only if a local proxy is configured; the production Docker image builds the Vite app and serves it through Express. Locally, `npm run build && npm start` serves everything on 8080 and creates `data/word-party.db` (git-ignored; delete it to start with an empty database).

## Database
Tables (created on startup with `CREATE TABLE IF NOT EXISTS`, so add new columns with a migration rather than editing the schema in place):
- `groups(id, name, players JSON, turn_minutes, created_at, updated_at)`
- `games(id, group_id → groups ON DELETE CASCADE, status 'playing'|'finished', players JSON, turn_minutes, logs JSON, played JSON, started_at, updated_at, finished_at)`
A game keeps its own copy of the line-up, so renaming a group's players later does not break old logs (log keys are indexes into the game's own `players`). To back up, copy `data/word-party.db` while the container is stopped (WAL mode also writes `-wal`/`-shm` files).

## Quality checks
- Validate player names: require at least two players and unique names (players find themselves by name).
- No root-absolute URLs in client code (see "Running behind Caddy").
- Never expose the answer in the guessers' prompt text; it is intentionally displayed for the active clue-giver.
- Never repeat a word during a game, and avoid repeating words from earlier games on the same device. Played words are remembered in the browser (`localStorage`, key `word-party:v1`) until that category/difficulty pool is exhausted; then only that pool is reshuffled, and words already shown in the current game stay excluded (small pools, such as some sound pools, then show "No more words" instead of repeating). The setup screen offers "Forget played words" to clear the memory.
- The same storage also remembers the chosen turn length. Groups, games and the leaderboard are persisted in SQLite (see above); the turn in progress is not, and resets on refresh.
- Data stays on this server (SQLite file plus the small `localStorage` entry above); do not add analytics or external network calls without an explicit product decision.
