const express = require('express');
const path = require('path');
const wordData = require('./words.json');
const db = require('./db');

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// words.json is grouped by category:
// { "Category": { "prefix": "id-prefix", "easy": [...], "medium": [...], "hard": [...], "sound": [...] } }
// "sound" lists the words in that category you can clue with non-verbal sounds (used by the "Make sounds" style).
// A flat array of { id, word, category, difficulty, sound? } entries is also accepted.
function loadWords(data) {
  if (Array.isArray(data)) return data.map(w => ({ ...w, sound: !!w.sound }));
  const list = [];
  for (const [category, group] of Object.entries(data)) {
    const all = DIFFICULTIES.flatMap(d => group[d] || []);
    const sound = new Set(group.sound || []);
    for (const w of sound) if (!all.includes(w)) throw new Error(`Sound word "${w}" is not in the ${category} lists`);
    for (const difficulty of DIFFICULTIES) {
      for (const word of group[difficulty] || []) list.push({ id: `${group.prefix}-${slug(word)}`, word, category, difficulty, sound: sound.has(word) });
    }
  }
  return list;
}
const words = loadWords(wordData);
const seenIds = new Set();
const seenWords = new Map();
for (const w of words) {
  if (seenIds.has(w.id)) throw new Error(`Duplicate word in words.json: ${w.id}`);
  seenIds.add(w.id);
  const key = w.word.toLowerCase();
  if (seenWords.has(key)) throw new Error(`"${w.word}" appears in both ${seenWords.get(key)} and ${w.category}`);
  seenWords.set(key, w.category);
}
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
// Categories with word counts; soundCount is how many of them suit the "Make sounds" clue style.
app.get('/api/categories', (_req, res) => {
  const counts = new Map();
  for (const w of words) {
    const c = counts.get(w.category) || { id: w.category, name: w.category, count: 0, soundCount: 0 };
    c.count += 1; if (w.sound) c.soundCount += 1;
    counts.set(w.category, c);
  }
  res.json([...counts.values()]);
});

// Picks a random word. `exclude` holds ids already played; `mode=sound` keeps only sound-friendly words.
function pickWord({ category = 'all', difficulty = 'easy', mode = '', exclude = [] }, res) {
  if (!DIFFICULTIES.includes(difficulty)) return res.status(400).json({ error: 'Invalid difficulty' });
  const sound = mode === 'sound';
  const excluded = new Set(exclude);
  const all = words.filter(w => (category === 'all' || w.category === category) && w.difficulty === difficulty && (!sound || w.sound));
  const pool = all.filter(w => !excluded.has(w.id));
  res.set('Cache-Control', 'no-store');
  if (!all.length) return res.status(404).json({ exhausted: false, error: sound
    ? 'No sound words for this category and difficulty. Try another category or difficulty.'
    : 'No words for this selection. Try another category or difficulty.' });
  // Every word in this pool was played: send the pool's ids so the client can forget just those and reshuffle.
  if (!pool.length) return res.status(404).json({ exhausted: true, poolIds: all.map(w => w.id), error: 'No more words for this selection. Try another category or difficulty.' });
  res.json(pool[Math.floor(Math.random() * pool.length)]);
}
const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(String).filter(Boolean);
app.get('/api/word', (req, res) => pickWord({ ...req.query, exclude: list(req.query.exclude) }, res));
// POST form for long exclude lists (the pools are large enough that they would overflow a URL).
app.post('/api/word', express.json({ limit: '1mb' }), (req, res) => {
  const b = req.body || {};
  pickWord({ category: String(b.category || 'all'), difficulty: String(b.difficulty || 'easy'), mode: String(b.mode || ''), exclude: list(b.exclude) }, res);
});
// ---- Saved groups and leaderboard (SQLite) ----
const MAX_PLAYERS = 12;
const TURN_OPTIONS = [2, 3, 5, 7, 10, 15];
app.use('/api', express.json({ limit: '2mb' }));
const bad = (res, error) => res.status(400).json({ error });
const idParam = req => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };

function cleanGroup(body = {}) {
  const players = Array.isArray(body.players) ? body.players.map(p => String(p ?? '').trim().slice(0, 24)).filter(Boolean) : [];
  if (players.length < 2 || players.length > MAX_PLAYERS) return { error: `A group needs 2 to ${MAX_PLAYERS} players.` };
  if (new Set(players.map(p => p.toLowerCase())).size !== players.length) return { error: 'Player names must be different.' };
  const name = String(body.name ?? '').trim().slice(0, 40) || players.join(', ').slice(0, 40);
  const turnMinutes = TURN_OPTIONS.includes(body.turnMinutes) ? body.turnMinutes : 7;
  return { value: { name, players, turnMinutes } };
}
function cleanProgress(body = {}, playerCount) {
  const logs = {};
  for (const [k, list] of Object.entries(body.logs && typeof body.logs === 'object' ? body.logs : {})) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= playerCount || !Array.isArray(list)) continue;
    logs[i] = list.filter(e => e && typeof e.id === 'string').map(e => ({
      id: e.id, word: String(e.word ?? ''), category: String(e.category ?? ''),
      difficulty: DIFFICULTIES.includes(e.difficulty) ? e.difficulty : 'easy',
      result: e.result === 'guessed' ? 'guessed' : 'skipped', ...(e.timeUp ? { timeUp: true } : {})
    }));
  }
  const played = [...new Set((Array.isArray(body.played) ? body.played : []).filter(i => Number.isInteger(i) && i >= 0 && i < playerCount))];
  return { logs, played, status: body.status === 'finished' ? 'finished' : 'playing' };
}

app.use('/api/groups', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api/games', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/api/groups', (_req, res) => res.json(db.listGroups()));
app.post('/api/groups', (req, res) => {
  const { value, error } = cleanGroup(req.body);
  if (error) return bad(res, error);
  res.status(201).json(db.createGroup(value));
});
app.get('/api/groups/:id', (req, res) => {
  const g = idParam(req) && db.getGroup(idParam(req));
  g ? res.json(g) : res.status(404).json({ error: 'Group not found' });
});
app.put('/api/groups/:id', (req, res) => {
  const { value, error } = cleanGroup(req.body);
  if (error) return bad(res, error);
  const g = idParam(req) && db.updateGroup(idParam(req), value);
  g ? res.json(g) : res.status(404).json({ error: 'Group not found' });
});
app.delete('/api/groups/:id', (req, res) => {
  idParam(req) && db.deleteGroup(idParam(req)) ? res.status(204).end() : res.status(404).json({ error: 'Group not found' });
});
app.get('/api/groups/:id/leaderboard', (req, res) => {
  const id = idParam(req);
  if (!id || !db.getGroup(id)) return res.status(404).json({ error: 'Group not found' });
  res.json(db.leaderboard(id));
});
app.post('/api/groups/:id/games', (req, res) => {
  const id = idParam(req);
  const group = id && db.getGroup(id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const { value, error } = cleanGroup({ ...group, ...req.body, name: group.name });
  if (error) return bad(res, error);
  const progress = cleanProgress(req.body, value.players.length);
  res.status(201).json(db.createGame(id, { players: value.players, turnMinutes: value.turnMinutes, ...progress }));
});
app.get('/api/games/:id', (req, res) => {
  const g = idParam(req) && db.getGame(idParam(req));
  g ? res.json(g) : res.status(404).json({ error: 'Game not found' });
});
app.put('/api/games/:id', (req, res) => {
  const id = idParam(req);
  const game = id && db.getGame(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json(db.updateGame(id, cleanProgress(req.body, game.players.length)));
});
app.delete('/api/games/:id', (req, res) => {
  idParam(req) && db.deleteGame(idParam(req)) ? res.status(204).end() : res.status(404).json({ error: 'Game not found' });
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Word Party listening on ${PORT}`));
