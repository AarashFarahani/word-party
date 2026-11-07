import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const DIFFICULTIES = [
  { id: 'easy', name: 'Easy', points: 1, note: 'Everyday words' },
  { id: 'medium', name: 'Medium', points: 2, note: 'A little trickier' },
  { id: 'hard', name: 'Hard', points: 5, note: 'Challenge words' }
];
const TURN_OPTIONS = [2, 3, 5, 7, 10, 15];   // minutes per turn, chosen on the setup screen
const DEFAULT_MINUTES = 7;
const STORAGE_KEY = 'word-party:v1';
const MAX_PLAYERS = 8;
const MODES = [
  { id: 'explain', name: 'Explain', icon: '💬', detail: 'Describe it without saying the word.' },
  { id: 'act', name: 'Act it out', icon: '🎭', detail: 'Use gestures. No speaking.' },
  { id: 'sound', name: 'Make sounds', icon: '🔊', detail: 'Make noises that help the group guess.' }
];
const MEDALS = ['🥇', '🥈', '🥉'];

const pointsFor = id => DIFFICULTIES.find(d => d.id === id)?.points ?? 0;
// Scores are always derived from a turn's word log, so correcting a word in the review updates everything.
const summarize = log => log.reduce((s, e) => e.result === 'guessed'
  ? { ...s, guessed: s.guessed + 1, points: s.points + pointsFor(e.difficulty) }
  : { ...s, skipped: s.skipped + 1 }, { points: 0, guessed: 0, skipped: 0 });
const formatTime = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// A little data kept on this device only (nothing leaves the browser): turn length and words already played.
const loadStore = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; } };
const saveStore = patch => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadStore(), ...patch })); } catch { /* storage unavailable */ } };
const loadSeen = () => { const s = loadStore().seen; return Array.isArray(s) ? s.filter(u => u && typeof u.id === 'string') : []; };

function DifficultyPicker({ value, onChange, compact }) {
  return <div className={`difficulty-grid ${compact ? 'compact' : ''}`} role="group" aria-label="Difficulty">
    {DIFFICULTIES.map(d => <button key={d.id} type="button" aria-pressed={value === d.id}
      className={`difficulty ${value === d.id ? 'selected' : ''} ${d.id}`} onClick={() => onChange(d.id)}>
      <b>{d.name}</b><strong>{d.points} pt{d.points > 1 ? 's' : ''}</strong>
    </button>)}
  </div>;
}

function ReviewCard({ name, log, onSet, onClose }) {
  const s = summarize(log);
  return <div className="review-card">
    <div className="review-head"><div><b>{name}'s words</b><small>{s.guessed} guessed · {s.skipped} skipped · {s.points} pts</small></div>{onClose && <button className="text-button" onClick={onClose}>Done</button>}</div>
    <p className="review-hint">Tap Guessed or Skipped to correct a word. Scores update straight away.</p>
    {log.length ? <ul className="review-list">{log.map((e, k) => <li key={k} className="review-row">
      <div className="review-word"><b>{e.word}</b><small>{e.category} · {e.difficulty} · {pointsFor(e.difficulty)} pt{pointsFor(e.difficulty) > 1 ? 's' : ''}{e.timeUp ? ' · on screen when time ran out' : ''}</small></div>
      <div className="review-toggle" role="group" aria-label={`Result for ${e.word}`}>
        <button type="button" aria-pressed={e.result === 'guessed'} className={e.result === 'guessed' ? 'on guessed' : ''} onClick={() => onSet(k, 'guessed')}>✓ Guessed</button>
        <button type="button" aria-pressed={e.result === 'skipped'} className={e.result === 'skipped' ? 'on skipped' : ''} onClick={() => onSet(k, 'skipped')}>Skipped</button>
      </div>
    </li>)}</ul> : <p className="review-empty">No words were shown this turn.</p>}
  </div>;
}

function App() {
  const [players, setPlayers] = useState(['Player 1', 'Player 2']);
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState('all');
  const [difficulty, setDifficulty] = useState('easy');
  const [mode, setMode] = useState('explain');
  const [logs, setLogs] = useState({});           // per player index: the words shown on their turn { id, word, category, difficulty, result: 'guessed' | 'skipped' }
  const [played, setPlayed] = useState([]);         // player indexes that finished their turn
  const [activeIndex, setActiveIndex] = useState(null);
  const [phase, setPhase] = useState('setup');      // setup | ready | playing | results
  const [word, setWord] = useState(null);
  const [turnMinutes, setTurnMinutes] = useState(() => { const m = loadStore().turnMinutes; return TURN_OPTIONS.includes(m) ? m : DEFAULT_MINUTES; });
  const [seconds, setSeconds] = useState(turnMinutes * 60);
  const [pickingCategory, setPickingCategory] = useState(false);
  const [lastTurn, setLastTurn] = useState(null);       // { name, index } of the player who just finished
  const [reviewFor, setReviewFor] = useState(null);       // player index whose words are open for review
  const [pop, setPop] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [copied, setCopied] = useState(false);
  const usedRef = useRef(null);     // words already shown on this device, kept across games: { id, category, difficulty }
  if (usedRef.current === null) usedRef.current = loadSeen();
  const [seenCount, setSeenCount] = useState(() => usedRef.current.length);
  const deadlineRef = useRef(0);    // timestamp the current turn ends at
  const turnToken = useRef(0);      // invalidates in-flight word requests when a turn ends

  // API URLs are relative on purpose (no leading slash): the app is served at / directly and at /word-party/ behind Caddy.
  useEffect(() => { fetch('api/categories').then(r => r.json()).then(setCategories).catch(() => {}); }, []);

  const activePlayer = activeIndex === null ? '' : players[activeIndex];
  const categoryLabel = category === 'all' ? 'All categories' : category;
  const selectedMode = MODES.find(m => m.id === mode);
  const current = statsFor(activeIndex);
  const lt = lastTurn ? statsFor(lastTurn.index) : null;
  const turnSeconds = turnMinutes * 60;

  const ranked = useMemo(() => {
    const rows = players.map((name, i) => ({ name, i, ...statsFor(i) })).sort((a, b) => b.points - a.points);
    return rows.map(r => ({ ...r, rank: rows.findIndex(x => x.points === r.points) + 1 }));
  }, [players, logs]);
  const topPoints = ranked[0]?.points || 0;
  const winners = ranked.filter(r => r.rank === 1);
  const totals = ranked.reduce((t, r) => ({ guessed: t.guessed + r.guessed, skipped: t.skipped + r.skipped }), { guessed: 0, skipped: 0 });

  // The timer runs off a fixed deadline, so nothing else on screen (pickers, word requests) can affect it.
  useEffect(() => {
    if (phase !== 'playing') return;
    const tick = () => setSeconds(Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)));
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [phase, activeIndex]);

  useEffect(() => {
    if (phase === 'playing' && seconds === 0) finishTurn();
  }, [seconds, phase]);

  // Keep a tablet's screen awake while people are playing (ignored where unsupported).
  useEffect(() => {
    if (!(phase === 'ready' || phase === 'playing') || !('wakeLock' in navigator)) return;
    let lock = null, cancelled = false;
    const acquire = () => navigator.wakeLock.request('screen').then(l => { if (cancelled) l.release().catch(() => {}); else lock = l; }).catch(() => {});
    const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible); if (lock) lock.release().catch(() => {}); };
  }, [phase]);

  // Bring the review panel into view when it opens on the "Who's up?" screen.
  useEffect(() => {
    if (phase === 'ready' && reviewFor !== null) document.getElementById('review-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [reviewFor, phase]);

  function statsFor(i) { return summarize(logs[i] || []); }
  function updatePlayer(i, value) { setPlayers(p => p.map((name, idx) => idx === i ? value : name)); }
  function addPlayer() { if (players.length < MAX_PLAYERS) setPlayers(p => [...p, `Player ${p.length + 1}`]); }
  function removePlayer(i) { if (players.length > 2) setPlayers(p => p.filter((_, idx) => idx !== i)); }

  function saveSeen() { saveStore({ seen: usedRef.current }); setSeenCount(usedRef.current.length); }
  function forgetPlayedWords() { usedRef.current = []; saveSeen(); }
  function chooseMinutes(m) { setTurnMinutes(m); setSeconds(m * 60); saveStore({ turnMinutes: m }); }

  async function drawWord(cat = category, diff = difficulty) {
    const token = turnToken.current;
    setBusy(true); setMessage('');
    try {
      const inPool = u => (cat === 'all' || u.category === cat) && u.difficulty === diff;
      const request = () => fetch(`api/word?${new URLSearchParams({ category: cat, difficulty: diff, exclude: usedRef.current.filter(inPool).map(u => u.id).join(',') })}`);
      let response = await request();
      let data = await response.json();
      if (response.status === 404) {
        // This pool is used up: reshuffle only the words from this selection and continue.
        usedRef.current = usedRef.current.filter(u => !inPool(u));
        response = await request();
        data = await response.json();
      }
      if (token !== turnToken.current) return;
      if (!response.ok) throw new Error(data.error || 'Could not get a word');
      usedRef.current.push({ id: data.id, category: data.category, difficulty: data.difficulty });
      saveSeen();
      setWord(data);
    } catch (e) {
      if (token === turnToken.current) { setMessage(e.message); setWord(null); }
    } finally {
      if (token === turnToken.current) setBusy(false);
    }
  }

  function logWord(w, result, extra = {}) {
    setLogs(l => ({ ...l, [activeIndex]: [...(l[activeIndex] || []), { id: w.id, word: w.word, category: w.category, difficulty: w.difficulty, result, ...extra }] }));
  }
  function setResult(playerIndex, k, result) {
    setLogs(l => ({ ...l, [playerIndex]: (l[playerIndex] || []).map((e, i) => i === k ? { ...e, result } : e) }));
  }

  function resetRound() {
    turnToken.current += 1;
    setLogs({}); setPlayed([]); setReviewFor(null); setActiveIndex(null); setLastTurn(null); setWord(null);
    setPickingCategory(false); setConfirmEnd(false); setMessage(''); setPop(null); setBusy(false); setSeconds(turnSeconds);
  }

  function startGame() {
    const clean = players.map(p => p.trim()).filter(Boolean);
    if (clean.length < 2) { setMessage('Add at least two players with names.'); return; }
    if (new Set(clean.map(p => p.toLowerCase())).size !== clean.length) {
      setMessage('Give each player a different name so everyone can find theirs.'); return;
    }
    resetRound(); setPlayers(clean); setPhase('ready');
  }

  async function startTurn() {
    if (activeIndex === null) { setMessage('Tap your name first.'); return; }
    turnToken.current += 1;
    deadlineRef.current = Date.now() + turnSeconds * 1000;
    setLogs(l => ({ ...l, [activeIndex]: [] })); setReviewFor(null);
    setLastTurn(null); setPickingCategory(false); setConfirmEnd(false); setWord(null); setPop(null); setMessage('');
    setSeconds(turnSeconds); setPhase('playing');
    await drawWord();
  }

  async function guessedIt() {
    if (!word || busy) return;
    const pts = pointsFor(word.difficulty);
    logWord(word, 'guessed');
    setPop({ pts, key: Date.now() });
    setWord(null);
    await drawWord();
  }

  async function skipWord() {
    if (!word || busy) return;
    logWord(word, 'skipped');
    setWord(null);
    await drawWord();
  }

  // Leaves the category picker and immediately swaps the current word for one from the new category.
  async function drawFromPicker() {
    if (busy) return;
    if (word) { logWord(word, 'skipped'); setWord(null); }
    setPickingCategory(false);
    await drawWord();
  }

  function requestEndTurn() {
    if (confirmEnd) { finishTurn(); return; }
    setConfirmEnd(true); setTimeout(() => setConfirmEnd(false), 3000);
  }

  function finishTurn() {
    turnToken.current += 1;
    // A word still on screen when the turn ends counts as skipped; it can be corrected in the review.
    if (word) logWord(word, 'skipped', { timeUp: true });
    setLastTurn({ name: players[activeIndex], index: activeIndex }); setReviewFor(null);
    const nowPlayed = [...played, activeIndex];
    setPlayed(nowPlayed);
    setWord(null); setPickingCategory(false); setConfirmEnd(false); setBusy(false); setMessage(''); setSeconds(turnSeconds);
    if (nowPlayed.length >= players.length) { setActiveIndex(null); setPhase('results'); return; }
    const remaining = players.map((_, i) => i).filter(i => !nowPlayed.includes(i));
    setActiveIndex(remaining.length === 1 ? remaining[0] : null);
    setPhase('ready');
  }

  function playAgain() { resetRound(); setPhase('ready'); }
  function newGame() { resetRound(); setPhase('setup'); }
  function quitGame() { if (window.confirm('Quit this game and go back to player setup? Scores will be lost.')) newGame(); }

  async function copyResults() {
    const text = ['Word Party results 🏆', ...ranked.map(r =>
      `${topPoints > 0 && r.rank <= 3 ? MEDALS[r.rank - 1] : `${r.rank}.`} ${r.name} — ${r.points} pts (${r.guessed} guessed, ${r.skipped} skipped)`)].join('\n');
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  return <main className="shell">
    <header className="topbar"><div className="brand-mark">W</div><div><div className="brand">WORD PARTY</div><div className="tagline">Think fast. Clue cleverly. Have fun.</div></div><span className="top-pill">PASS & PLAY</span></header>

    {phase === 'setup' && <section className="panel setup">
      <div className="eyebrow">THE GROUP GAME</div><h1>Let the words<br/><span>bring you together.</span></h1>
      <p className="intro">One secret word. One clue-giver. Everyone else guesses. How many can your group get in {turnMinutes} minutes?</p>
      <div className="section-heading"><h2>Who's playing?</h2><span>{players.length}/{MAX_PLAYERS} players</span></div>
      <div className="player-list">{players.map((p, i) => <div className="player-input" key={i}><span className="player-number">{i + 1}</span><input aria-label={`Player ${i + 1} name`} value={p} maxLength="24" onChange={e => updatePlayer(i, e.target.value)} placeholder={`Player ${i + 1}`}/>{players.length > 2 && <button className="remove" onClick={() => removePlayer(i)} aria-label="Remove player">×</button>}</div>)}</div>
      <button className="add-player" onClick={addPlayer} disabled={players.length >= MAX_PLAYERS}>＋ Add another player</button>
      <div className="section-heading"><h2>How long is each turn?</h2><span>Same for every player</span></div>
      <div className="time-grid" role="group" aria-label="Turn length in minutes">{TURN_OPTIONS.map(m => <button key={m} type="button" aria-pressed={turnMinutes === m} className={`difficulty time-option ${turnMinutes === m ? 'selected' : ''}`} onClick={() => chooseMinutes(m)}><b>{m}</b><strong>min</strong></button>)}</div>
      <div className="setup-hint">Everyone plays one turn, in any order. When it's your turn, tap your name and pick a category and difficulty. You can change both again before every word.</div>
      {message && <p className="error">{message}</p>}
      <button className="primary start" onClick={startGame}>Start the game <span>→</span></button>
      <p className="fine-print">{turnMinutes} minutes per player · Up to {MAX_PLAYERS} players · Words you've played won't come back in later games until a pool runs out{seenCount > 0 && <> · <button className="text-button" onClick={forgetPlayedWords}>Forget {seenCount} played words</button></>}</p>
    </section>}

    {phase === 'ready' && <section className="panel ready">
      {lastTurn && <div className="turn-recap-wrap">
        <div className="turn-recap"><span className="recap-emoji">🎉</span><div><b>Nice work, {lastTurn.name}!</b><small>{lt.points} pts · {lt.guessed} guessed · {lt.skipped} skipped</small></div><button className="recap-review" onClick={() => setReviewFor(reviewFor === lastTurn.index ? null : lastTurn.index)}>{reviewFor === lastTurn.index ? 'Hide words' : 'Review words'}</button></div>
      </div>}
      <div className="eyebrow">TURN {played.length + 1} OF {players.length}</div>
      <h1 className="ready-title">Who's up?</h1>
      <p className="intro">Tap your name, choose how you want to play, then start your {turnMinutes}-minute turn.</p>
      <div className="player-picks">{players.map((name, i) => {
        const done = played.includes(i);
        return <div className="player-slot" key={i}><button type="button" disabled={done} aria-pressed={activeIndex === i} className={`player-pick ${activeIndex === i ? 'selected' : ''} ${done ? 'done' : ''}`} onClick={() => { setActiveIndex(i); setMessage(''); }}>
          <span className="avatar">{name.charAt(0).toUpperCase()}</span>
          <div><b>{name}</b><small>{done ? `✓ Played · ${statsFor(i).points} pts` : activeIndex === i ? 'That’s you!' : 'Waiting to play'}</small></div>
        </button>
        {done && <button type="button" className="slot-review" aria-expanded={reviewFor === i} onClick={() => setReviewFor(reviewFor === i ? null : i)}>{reviewFor === i ? 'Hide words' : 'Review words'}</button>}
        </div>;
      })}</div>
      {reviewFor !== null && played.includes(reviewFor) && <div className="ready-review" id="review-panel"><ReviewCard name={players[reviewFor]} log={logs[reviewFor] || []} onSet={(k, r) => setResult(reviewFor, k, r)} onClose={() => setReviewFor(null)} /></div>}

      <div className="section-heading"><h2>{activePlayer ? `${activePlayer}, set up your turn` : 'Set up your turn'}</h2></div>
      <div className="two-col">
        <div><div className="section-heading tight"><h2>Category</h2></div><select aria-label="Category" value={category} onChange={e => setCategory(e.target.value)}><option value="all">All categories</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}</select></div>
        <div><div className="section-heading tight"><h2>Difficulty</h2></div><DifficultyPicker value={difficulty} onChange={setDifficulty} /></div>
      </div>
      <div className="section-heading"><h2>How will you give clues?</h2></div>
      <div className="mode-grid">{MODES.map(m => <button key={m.id} type="button" onClick={() => setMode(m.id)} className={`mode-card ${mode === m.id ? 'selected' : ''}`}><span>{m.icon}</span><b>{m.name}</b><small>{m.detail}</small></button>)}</div>
      {message && <p className="error">{message}</p>}
      <button className="primary start" onClick={startTurn} disabled={activeIndex === null}>{activePlayer ? `Start ${activePlayer}'s turn` : 'Tap your name to start'} <span>→</span></button>
      <p className="fine-print">During your turn you can change the difficulty for each next word, or switch category without stopping the clock.</p>
      <button className="text-button centered" onClick={quitGame}>Quit game</button>
    </section>}

    {phase === 'playing' && <section className="panel game-panel">
      <div className="game-meta"><span className="eyebrow">TURN {played.length + 1} OF {players.length}</span><span className="category-chip">{categoryLabel}</span></div>
      <div className="player-turn"><div><div className="muted-label">IT'S YOUR TURN</div><h1>{activePlayer}</h1></div><div className={`timer ${seconds <= 30 ? 'urgent' : ''}`} role="timer" aria-label="Time left"><span>TIME LEFT</span><strong>{formatTime(seconds)}</strong></div></div>
      <div className="progress"><div style={{ width: `${(seconds / turnSeconds) * 100}%` }}/></div>

      {pickingCategory ? <div className="picker">
        <div className="picker-head"><button className="back-link" onClick={() => setPickingCategory(false)}>← Back to my word</button><span className="timer-note">⏱ Timer keeps running</span></div>
        <h2>Change category</h2>
        <p>Your next word will come from the category you pick. Your current word stays hidden while you choose.</p>
        <div className="chip-grid">{[{ id: 'all', name: 'All categories' }, ...categories].map(c => <button key={c.id} type="button" aria-pressed={category === c.id} className={`chip ${category === c.id ? 'selected' : ''}`} onClick={() => setCategory(c.id)}>{c.name}{c.count ? <small>{c.count}</small> : null}</button>)}</div>
        <div className="game-actions">
          <button className="secondary" onClick={() => setPickingCategory(false)}>Keep my word <span>↩</span></button>
          <button className="primary" onClick={drawFromPicker} disabled={busy}>New word now <span>{categoryLabel}</span></button>
        </div>
      </div> : <div className="game-body"><div className="game-main">
        <div className="word-card"><div className="word-top"><span>YOUR SECRET WORD</span>{word && <span className={`difficulty-tag ${word.difficulty}`}>{word.difficulty} · {pointsFor(word.difficulty)} point{pointsFor(word.difficulty) > 1 ? 's' : ''}</span>}</div>
          {word ? <><div className="secret-word">{word.word}</div><div className="word-category">{word.category}</div></> : <div className="secret-word waiting">{busy ? 'Choosing a word…' : 'No word available'}</div>}
          <div className="mode-hint">{selectedMode.icon} <b>{selectedMode.name}:</b> {selectedMode.detail}</div>
        </div>
        <div className="howto"><span className="howto-icon">👀</span><p><b>Show this word only to the clue-giver.</b><br/>Everyone else: look away, then start guessing!</p></div>
        </div><div className="game-side">
        <div className="turn-stats">
          <div><b>{current.guessed}</b><span>Guessed</span></div>
          <div><b>{current.skipped}</b><span>Skipped</span></div>
          <div className="points-stat"><b>{current.points}</b><span>Points</span>{pop && <i className="score-pop" key={pop.key}>+{pop.pts}</i>}</div>
        </div>
        <div className="next-word">
          <div className="next-head"><span>NEXT WORD DIFFICULTY</span><button className="text-button" onClick={() => setPickingCategory(true)}>{categoryLabel} · Change category</button></div>
          <DifficultyPicker compact value={difficulty} onChange={setDifficulty} />
        </div>
        {message && <p className="error">{message}</p>}
        {word || busy
          ? <div className="game-actions"><button className="secondary" onClick={skipWord} disabled={!word || busy}>Skip word <span>↷</span></button><button className="primary" onClick={guessedIt} disabled={!word || busy}>They guessed it! <span>+{pointsFor(word?.difficulty)} pts</span></button></div>
          : <div className="game-actions single"><button className="primary" onClick={() => drawWord()}>Get a new word <span>↻</span></button></div>}
        <div className="game-footer"><span>Score updates live</span><button className="text-button" onClick={requestEndTurn}>{confirmEnd ? 'Tap again to end turn' : 'End turn early'}</button></div>
      </div></div>}
    </section>}

    {phase === 'results' && <section className="panel results">
      <div className="eyebrow">THAT'S A WRAP</div>
      <div className="trophy">{topPoints > 0 ? '🏆' : '🎲'}</div>
      {topPoints > 0 ? <>
        <h1>{winners.length === 1 ? 'We have a winner!' : 'It’s a tie!'}</h1>
        <p className="winner-names">{winners.map(w => w.name).join(' & ')}</p>
        <p className="winner-sub">{winners.length === 1 ? 'wins' : 'share the win'} with {topPoints} point{topPoints > 1 ? 's' : ''}</p>
      </> : <>
        <h1>No points this time</h1>
        <p className="winner-sub">Nobody scored. Time for a rematch?</p>
      </>}
      <div className="summary-stats">
        <div className="stat-chip"><b>{players.length}</b><span>Players</span></div>
        <div className="stat-chip"><b>{totals.guessed}</b><span>Words guessed</span></div>
        <div className="stat-chip"><b>{totals.skipped}</b><span>Skipped</span></div>
      </div>
      <div className="leaderboard">{ranked.map(r => <div className={`leader-row ${topPoints > 0 && r.rank === 1 ? 'first' : ''}`} key={r.i}>
        <span className="rank">{topPoints > 0 && r.rank <= 3 ? MEDALS[r.rank - 1] : r.rank}</span>
        <div className="leader-info"><b>{r.name}</b><small>{r.guessed} guessed · {r.skipped} skipped</small><div className="bar"><i style={{ width: `${topPoints ? (r.points / topPoints) * 100 : 0}%` }}/></div></div>
        <strong>{r.points} <small>pts</small></strong>
        <button className="row-review" aria-expanded={reviewFor === r.i} onClick={() => setReviewFor(reviewFor === r.i ? null : r.i)}>{reviewFor === r.i ? 'Hide' : 'Review'}</button>
        {reviewFor === r.i && <div className="leader-review"><ReviewCard name={r.name} log={logs[r.i] || []} onSet={(k, res) => setResult(r.i, k, res)} onClose={() => setReviewFor(null)} /></div>}
      </div>)}</div>
      <p className="review-note">Tap Review next to a player to check the words they guessed or skipped and fix any mistakes. The winner updates as you go.</p>
      <div className="result-actions">
        <button className="primary" onClick={playAgain}>Play again with the same players <span>↻</span></button>
        <button className="secondary" onClick={copyResults}>{copied ? '✓ Copied to clipboard' : 'Copy results'}</button>
        <button className="text-button centered" onClick={newGame}>Change players or start fresh</button>
      </div>
    </section>}
    <footer>WORD PARTY <span>·</span> GOOD WORDS. GREAT COMPANY.</footer>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
