# Word Party

A Dockerized, pass-and-play word guessing game for a group sharing one screen.

## Run
```bash
docker compose up --build -d
```
Open http://localhost:8085 (or http://localhost:8800/word-party/ if you run the Caddy proxy, see below)

Stop with `docker compose down`.

## How to play
- Add at least two players, up to 12 (each with a different name).
- Choose how long each turn lasts: 2, 3, 5, 7, 10 or 15 minutes (default 7). This is set once, before the game, and is the same for everyone.
- When it's your turn, tap **your name** on the "Who's up?" screen, then choose a category (or All categories), a difficulty, and a clue style. Players can go in any order.
- Each player gets one timed turn. The active player sees the secret word and helps everyone else guess it.
- Choose **They guessed it!** to award the points for that word's difficulty (Easy 1, Medium 2, Hard 5), or **Skip** to draw another word without points.
- You can change the difficulty before every next word, and **Change category** lets you switch category at any time. The timer keeps running while you do.
- The game ends after every player has taken a turn. The results screen shows the winner (ties are shown), each player's guessed/skipped/points, and lets you play again with the same players or copy the results.
- As soon as a player finishes, tap **Review words** to see which words they guessed or skipped. Every finished player keeps a **Review words** button on the "Who's up?" screen, so you can go back to anyone's words before the next turn starts, and the results screen has a **Review** button for every player too. Switch any word between **Guessed** and **Skipped** to fix a mistake; points and the winner update immediately. A word still showing when time ran out is counted as skipped, and you can change it here.
- Clue styles: Explain (describe without saying the word), Act (gesture), and Sound (make noises).

The app runs entirely locally. Scores and the current game are held in the browser session; refreshing the page resets the game. The browser does remember your chosen turn length and which words have been played, so words don't come back in later games until a category/difficulty pool is used up. Use **Forget played words** on the setup screen to start fresh.

## Words
The word list (330 words across 11 categories) is in `server/words.json`, grouped by category and difficulty. To add words, append them to the right `easy` / `medium` / `hard` array and rebuild. The server refuses to start if the same word appears twice in a category, so mistakes are caught immediately.

## Playing on a tablet
- Open `http://<your-computer-ip>:8800/word-party/` (through Caddy) or `http://<your-computer-ip>:8085` on the tablet while both are on the same Wi-Fi.
- Controls are sized for touch, and in landscape the game shows the word on the left and the score and buttons on the right.
- To keep the screen from sleeping mid-turn, the app asks the browser to stay awake, but browsers only allow that on HTTPS or localhost. Over plain `http://` on your network, set the tablet's auto-lock to a long time instead.
- For a full-screen, app-like game, use your browser's **Add to Home Screen**.

## Behind Caddy
Word Party is routed by the Caddy proxy in `../caddy` at **http://localhost:8800/word-party/** and has a "Word Party" tile on the dashboard. The container is published on host port **8085**, because 8080 is used by the Stock app. No extra configuration is needed: the app uses relative URLs, so it works the same at `/word-party/` and at `:8085`.

After changing the Caddyfile or dashboard, reload with `docker compose restart caddy` from the caddy folder.

## Services
- `word-party`: Node/Express API plus built React app. Listens on 8080 inside the container, published on host port 8085.
- `docker-compose.yml`: one-container deployment for a lightweight local game.
