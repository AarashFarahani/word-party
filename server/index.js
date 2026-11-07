const express = require('express');
const path = require('path');
const wordData = require('./words.json');

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// words.json is grouped by category: { "Category": { "prefix": "id-prefix", "easy": [...], "medium": [...], "hard": [...] } }
// A flat array of { id, word, category, difficulty } entries is also accepted.
function loadWords(data) {
  if (Array.isArray(data)) return data;
  const list = [];
  for (const [category, group] of Object.entries(data)) {
    for (const difficulty of DIFFICULTIES) {
      for (const word of group[difficulty] || []) list.push({ id: `${group.prefix}-${slug(word)}`, word, category, difficulty });
    }
  }
  return list;
}
const words = loadWords(wordData);
const seenIds = new Set();
for (const w of words) {
  if (seenIds.has(w.id)) throw new Error(`Duplicate word in words.json: ${w.id}`);
  seenIds.add(w.id);
}
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/categories', (_req, res) => {
  const counts = words.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, {});
  res.json(Object.entries(counts).map(([name, count]) => ({ id: name, name, count })));
});
app.get('/api/word', (req, res) => {
  const { category = 'all', difficulty = 'easy', exclude = '' } = req.query;
  if (!DIFFICULTIES.includes(difficulty)) return res.status(400).json({ error: 'Invalid difficulty' });
  const excluded = new Set(String(exclude).split(',').filter(Boolean));
  const pool = words.filter(w =>
    (category === 'all' || w.category === category) &&
    w.difficulty === difficulty && !excluded.has(w.id)
  );
  if (!pool.length) return res.status(404).json({ error: 'No more words for this selection. Try another category or difficulty.' });
  res.set('Cache-Control', 'no-store');
  res.json(pool[Math.floor(Math.random() * pool.length)]);
});
app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Word Party listening on ${PORT}`));
