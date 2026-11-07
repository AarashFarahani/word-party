# Agent guide — Word Party

## Product goal
Build and maintain a friendly, local, pass-and-play party game where players help others guess meaningful words.

## Stack
- Frontend: React 18 + Vite
- Backend: Node.js + Express
- Deployment: Docker Compose; one application container listens on 8080 inside the container and is published on host port **8085** (8080 is already used by the Stock app on the same host)
- No database or external service is required.

## Core rules
- Minimum two players, maximum 12 (`MAX_PLAYERS` in `src/main.jsx`; the setup screen, "Who's up?" grid, results and copied results all adapt to the count, so raise it there only).
- Turn length is chosen on the setup screen, before the game starts: 2, 3, 5, 7, 10 or 15 minutes (default 7). It applies to every player and cannot change mid-game.
- Each player receives one turn of that length. Players choose their own name from those who haven't played yet; turn order is not fixed.
- The active clue-giver sees the current word; the rest of the group guesses.
- Supported clue styles: Explain (do not say the target word or its obvious spelling), Act (gesture), Sound (non-verbal sounds).
- Difficulty scores: Easy = 1, Medium = 2, Hard = 5.
- Difficulty can be changed before every word. A correctly guessed word awards the active player the points of that word's own difficulty. Skipped words award zero.
- The category can be changed mid-turn from a picker with a Back button. This must never pause, reset, or otherwise affect the timer (the timer runs from a fixed deadline).
- When the timer expires, return to the "Who's up?" screen. The game ends after each player has had one turn.
- Results screen: announce the highest scorer (show all tied winners), per-player guessed/skipped/points, play again with the same players, copy results, or start fresh.
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
- `GET /api/categories`: list categories and word counts.
- `GET /api/word?category=<id>&difficulty=<easy|medium|hard>&exclude=<comma-separated-ids>`: random matching word.
- `GET /api/health`: health check.

## Word list
`server/words.json` is grouped by category, then difficulty:
```json
"Animals": { "prefix": "animal", "easy": ["Cat", "..."], "medium": ["..."], "hard": ["..."] }
```
- The server expands this into `{ id, word, category, difficulty }` entries at startup. Ids are `<prefix>-<slug of the word>` (for example `animal-cat`), so keep prefixes stable.
- The server refuses to start if two words in the file produce the same id. Do not repeat a word across categories either, because the "All categories" pool would show it twice.
- Keep every category/difficulty list at roughly 10 words or more so a long game doesn't exhaust a pool. Current size: 11 categories, 330 words.
- A flat array of `{ id, word, category, difficulty }` entries is still accepted.
- `GET /api/word` receives only the ids already played in the requested pool, which keeps the URL short.

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
Run frontend and API together with `npm run dev:all` only if a local proxy is configured; the production Docker image builds the Vite app and serves it through Express.

## Quality checks
- Validate player names: require at least two players and unique names (players find themselves by name).
- No root-absolute URLs in client code (see "Running behind Caddy").
- Never expose the answer in the guessers' prompt text; it is intentionally displayed for the active clue-giver.
- Never repeat a word during a game, and avoid repeating words from earlier games on the same device. Played words are remembered in the browser (`localStorage`, key `word-party:v1`) until that category/difficulty pool is exhausted; then only that pool is reshuffled. The setup screen offers "Forget played words" to clear the memory.
- The same storage also remembers the chosen turn length. Nothing else is persisted: players, scores and the current turn reset on refresh.
- Keep all game state client-side (in memory, plus the small `localStorage` entry above); do not add analytics or external network calls without an explicit product decision.
