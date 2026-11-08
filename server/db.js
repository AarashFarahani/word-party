// SQLite storage for saved groups and their game history (Node's built-in node:sqlite, no native dependency).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'word-party.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    players TEXT NOT NULL,              -- JSON array of names
    turn_minutes INTEGER NOT NULL DEFAULT 7,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'playing' CHECK (status IN ('playing', 'finished')),
    players TEXT NOT NULL,              -- JSON array: the line-up of this game (log keys are indexes into it)
    turn_minutes INTEGER NOT NULL,
    logs TEXT NOT NULL DEFAULT '{}',    -- JSON { playerIndex: [{ id, word, category, difficulty, result, timeUp? }] }
    played TEXT NOT NULL DEFAULT '[]',  -- JSON array of player indexes that finished their turn
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS games_group ON games(group_id, status);
`);

const POINTS = { easy: 1, medium: 2, hard: 5 };
// Mirrors summarize() in src/main.jsx: scores are always derived from the word log.
const summarize = log => (Array.isArray(log) ? log : []).reduce((s, e) => e && e.result === 'guessed'
  ? { ...s, guessed: s.guessed + 1, points: s.points + (POINTS[e.difficulty] || 0) }
  : { ...s, skipped: s.skipped + 1 }, { points: 0, guessed: 0, skipped: 0 });

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

const groupRow = g => g && ({
  id: g.id, name: g.name, players: parse(g.players, []), turnMinutes: g.turn_minutes,
  createdAt: g.created_at, updatedAt: g.updated_at,
  gamesPlayed: g.games_played ?? 0, lastPlayedAt: g.last_played_at ?? null,
  activeGame: g.active_id ? { id: g.active_id, turnsPlayed: parse(g.active_played, []).length, players: parse(g.active_players, []).length } : null
});
const gameRow = g => g && ({
  id: g.id, groupId: g.group_id, status: g.status, players: parse(g.players, []), turnMinutes: g.turn_minutes,
  logs: parse(g.logs, {}), played: parse(g.played, []), startedAt: g.started_at, updatedAt: g.updated_at, finishedAt: g.finished_at
});

const GROUP_SELECT = `
  SELECT g.*,
    (SELECT COUNT(*) FROM games x WHERE x.group_id = g.id AND x.status = 'finished') AS games_played,
    (SELECT MAX(finished_at) FROM games x WHERE x.group_id = g.id AND x.status = 'finished') AS last_played_at,
    a.id AS active_id, a.played AS active_played, a.players AS active_players
  FROM groups g
  LEFT JOIN games a ON a.id = (SELECT id FROM games y WHERE y.group_id = g.id AND y.status = 'playing' ORDER BY y.updated_at DESC, y.id DESC LIMIT 1)`;

const q = {
  listGroups: db.prepare(`${GROUP_SELECT} ORDER BY COALESCE(a.updated_at, last_played_at, g.updated_at) DESC, g.id DESC`),
  getGroup: db.prepare(`${GROUP_SELECT} WHERE g.id = ?`),
  insertGroup: db.prepare(`INSERT INTO groups (name, players, turn_minutes) VALUES (?, ?, ?)`),
  updateGroup: db.prepare(`UPDATE groups SET name = ?, players = ?, turn_minutes = ?, updated_at = datetime('now') WHERE id = ?`),
  deleteGroup: db.prepare(`DELETE FROM groups WHERE id = ?`),
  finishedGames: db.prepare(`SELECT * FROM games WHERE group_id = ? AND status = 'finished' ORDER BY finished_at`),
  getGame: db.prepare(`SELECT * FROM games WHERE id = ?`),
  insertGame: db.prepare(`INSERT INTO games (group_id, players, turn_minutes, logs, played) VALUES (?, ?, ?, ?, ?)`),
  abandonOthers: db.prepare(`DELETE FROM games WHERE group_id = ? AND status = 'playing' AND id != ?`),
  updateGame: db.prepare(`UPDATE games SET logs = ?, played = ?, status = ?, updated_at = datetime('now'),
    finished_at = CASE WHEN ? = 'finished' THEN COALESCE(finished_at, datetime('now')) ELSE NULL END WHERE id = ?`),
  deleteGame: db.prepare(`DELETE FROM games WHERE id = ?`)
};

module.exports = {
  listGroups: () => q.listGroups.all().map(groupRow),
  getGroup: id => groupRow(q.getGroup.get(id)),
  createGroup: ({ name, players, turnMinutes }) => {
    const { lastInsertRowid } = q.insertGroup.run(name, JSON.stringify(players), turnMinutes);
    return groupRow(q.getGroup.get(Number(lastInsertRowid)));
  },
  updateGroup: (id, { name, players, turnMinutes }) => {
    if (!q.updateGroup.run(name, JSON.stringify(players), turnMinutes, id).changes) return null;
    return groupRow(q.getGroup.get(id));
  },
  deleteGroup: id => q.deleteGroup.run(id).changes > 0,

  getGame: id => gameRow(q.getGame.get(id)),
  // Only one unfinished game per group: starting a new one drops any abandoned one.
  createGame: (groupId, { players, turnMinutes, logs = {}, played = [] }) => {
    const { lastInsertRowid } = q.insertGame.run(groupId, JSON.stringify(players), turnMinutes, JSON.stringify(logs), JSON.stringify(played));
    const id = Number(lastInsertRowid);
    q.abandonOthers.run(groupId, id);
    return gameRow(q.getGame.get(id));
  },
  updateGame: (id, { logs, played, status }) => {
    if (!q.updateGame.run(JSON.stringify(logs), JSON.stringify(played), status, status, id).changes) return null;
    return gameRow(q.getGame.get(id));
  },
  deleteGame: id => q.deleteGame.run(id).changes > 0,

  // All-time standings for a group, by player name, across its finished games.
  leaderboard: groupId => {
    const games = q.finishedGames.all(groupId).map(gameRow);
    const byName = new Map();
    for (const g of games) {
      const rows = g.players.map((name, i) => ({ name, ...summarize(g.logs[i]) }));
      const top = Math.max(0, ...rows.map(r => r.points));
      for (const r of rows) {
        const key = r.name.toLowerCase();
        const p = byName.get(key) || { name: r.name, games: 0, wins: 0, points: 0, guessed: 0, skipped: 0, best: 0 };
        p.name = r.name; p.games += 1; p.points += r.points; p.guessed += r.guessed; p.skipped += r.skipped;
        p.best = Math.max(p.best, r.points);
        if (top > 0 && r.points === top) p.wins += 1;   // ties: every top scorer gets the win
        byName.set(key, p);
      }
    }
    const rows = [...byName.values()].sort((a, b) => b.wins - a.wins || b.points - a.points || a.name.localeCompare(b.name));
    return { games: games.length, players: rows.map(r => ({ ...r, rank: rows.findIndex(x => x.wins === r.wins && x.points === r.points) + 1 })) };
  }
};
