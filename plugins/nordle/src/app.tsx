import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getAppSDK,
  type InitPayload,
  type StateEvent,
  type Uuid,
} from '@novyse/app-sdk';

import {
  getLanguageList,
  getLanguageMeta,
  getRandomWordFromList,
  loadWordList,
} from './data';
import { messagesFor, normalizeLocale, type Locale } from './i18n';
import {
  NORDLE_STATE,
  computeKeyColors,
  evaluateGuess,
  generateId,
  type GameStatus,
  type GuessSubmission,
  type TileColor,
  type NordleSnapshot,
  type RoundHistoryItem,
} from './nordle';

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

export function App() {
  const sdk = getAppSDK();

  const [init, setInit] = useState<InitPayload | null>(null);
  const [participants, setParticipants] = useState<Uuid[]>([]);
  const [locale, setLocale] = useState<Locale>('en');

  // Room synchronized state
  const [lang, setLangState] = useState<string>('it');
  const [wordLength, setWordLength] = useState<number>(5);
  const [seed, setSeed] = useState<number>(0);
  const [roundNumber, setRoundNumber] = useState<number>(0);
  const [guesses, setGuesses] = useState<GuessSubmission[]>([]);
  const [currentInput, setCurrentInput] = useState<string>('');
  const [status, setStatus] = useState<GameStatus>('idle');

  // Dynamic word list loading state
  const [wordListData, setWordListData] = useState<{ words: string[]; set: Set<string> }>({
    words: [],
    set: new Set(),
  });
  const [loadingWords, setLoadingWords] = useState<boolean>(true);

  // Round tracking & history state
  const [roundStartedAt, setRoundStartedAt] = useState<number | null>(null);
  const [history, setHistory] = useState<RoundHistoryItem[]>([]);

  // Refs to always access freshest state inside callbacks without stale closures
  const historyRef = useRef<RoundHistoryItem[]>([]);
  historyRef.current = history;
  const roundStartedAtRef = useRef<number | null>(null);
  roundStartedAtRef.current = roundStartedAt;

  // Local UI state
  const [helpOpen, setHelpOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [shakingRow, setShakingRow] = useState<number | null>(null);
  const [flippingRow, setFlippingRow] = useState<number | null>(null);

  const messages = useMemo(() => messagesFor(locale), [locale]);
  const activeMeta = useMemo(() => getLanguageMeta(lang), [lang]);

  // Load words dynamically on demand when language or word length changes
  useEffect(() => {
    let cancelled = false;
    setLoadingWords(true);
    loadWordList(lang, wordLength).then((res) => {
      if (!cancelled) {
        setWordListData(res);
        setLoadingWords(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lang, wordLength]);

  const targetWord = useMemo(() => {
    if (!seed || wordListData.words.length === 0) return '';
    return getRandomWordFromList(wordListData.words, seed);
  }, [wordListData, seed]);

  const isRTL = activeMeta.rtl;
  const keyColors = useMemo(() => computeKeyColors(guesses), [guesses]);

  const notify = useCallback((msg: string, duration = 2200) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((cur) => (cur === msg ? null : cur));
    }, duration);
  }, []);

  // Broadcast state to room
  const broadcast = useCallback(
    async (next: Partial<NordleSnapshot>) => {
      if (init?.readOnly) return;
      const snapshot: NordleSnapshot = {
        lang: next.lang ?? lang,
        wordLength: next.wordLength ?? wordLength,
        seed: next.seed !== undefined ? next.seed : seed,
        roundNumber: next.roundNumber !== undefined ? next.roundNumber : roundNumber,
        guesses: next.guesses ?? guesses,
        currentInput: next.currentInput ?? currentInput,
        status: next.status ?? status,
        roundStartedAt: next.roundStartedAt !== undefined ? next.roundStartedAt : (roundStartedAtRef.current ?? undefined),
        history: next.history ?? historyRef.current,
        lastUpdatedBy: init?.self,
      };

      try {
        await sdk.state.send(NORDLE_STATE, snapshot);
      } catch (err) {
        console.error('State broadcast failed:', err);
      }
    },
    [sdk, init, lang, wordLength, seed, roundNumber, guesses, currentInput, status]
  );

  // Start a new game / round
  const startNewGame = useCallback(() => {
    if (init?.readOnly || loadingWords) return;
    const newSeed = Math.floor(Math.random() * 1000000) + 1;
    const nextRound = (roundNumber || 0) + 1;
    const startTime = Date.now();
    setSeed(newSeed);
    setRoundNumber(nextRound);
    setGuesses([]);
    setCurrentInput('');
    setStatus('playing');
    setRoundStartedAt(startTime);
    roundStartedAtRef.current = startTime;
    setStatsOpen(false);

    broadcast({
      seed: newSeed,
      roundNumber: nextRound,
      guesses: [],
      currentInput: '',
      status: 'playing',
      roundStartedAt: startTime,
      history: historyRef.current,
    });
  }, [init, loadingWords, roundNumber, broadcast]);

  // Initialize and replay state events
  useEffect(() => {
    let unmounted = false;

    sdk.init().then((payload) => {
      if (unmounted) return;
      setInit(payload);
      setParticipants(payload.participants);
      setLocale(normalizeLocale(payload.locale));

      // Replay past state events and aggregate complete history
      const events = payload.state.events;
      let latest: NordleSnapshot | null = null;
      const historyMap = new Map<number, RoundHistoryItem>();

      for (const ev of events) {
        if (ev.type === NORDLE_STATE && ev.data) {
          const snap = ev.data as NordleSnapshot;
          latest = snap;
          if (snap.history && Array.isArray(snap.history)) {
            for (const h of snap.history) {
              historyMap.set(h.round, h);
            }
          }
        }
      }

      const allHistory = Array.from(historyMap.values()).sort((a, b) => a.round - b.round);
      historyRef.current = allHistory;
      setHistory(allHistory);

      if (latest && latest.status && latest.status !== 'idle') {
        setLangState(latest.lang || 'it');
        setWordLength(latest.wordLength || 5);
        setSeed(latest.seed || 0);
        setRoundNumber(latest.roundNumber || 1);
        setGuesses(latest.guesses || []);
        setCurrentInput(latest.currentInput || '');
        setStatus(latest.status);
        if (latest.roundStartedAt) {
          setRoundStartedAt(latest.roundStartedAt);
          roundStartedAtRef.current = latest.roundStartedAt;
        }
      } else {
        // First entry: wait in idle until someone starts
        setStatus('idle');
        if (latest?.roundNumber) setRoundNumber(latest.roundNumber);
      }
    });

    const unlistenParticipants = sdk.onParticipants((next) => {
      setParticipants(next);
    });

    const unlistenState = sdk.state.on<NordleSnapshot>(NORDLE_STATE, (ev: StateEvent<NordleSnapshot>) => {
      const data = ev.data;
      if (!data) return;
      if (data.lang) setLangState(data.lang);
      if (data.wordLength) setWordLength(data.wordLength);
      if (data.seed !== undefined) setSeed(data.seed);
      if (data.roundNumber !== undefined) setRoundNumber(data.roundNumber);
      if (data.guesses) setGuesses(data.guesses);
      if (data.currentInput !== undefined) setCurrentInput(data.currentInput);
      if (data.status) setStatus(data.status);
      if (data.roundStartedAt !== undefined) {
        setRoundStartedAt(data.roundStartedAt);
        roundStartedAtRef.current = data.roundStartedAt;
      }
      if (data.history && Array.isArray(data.history)) {
        setHistory((prev) => {
          const map = new Map<number, RoundHistoryItem>();
          for (const h of prev) map.set(h.round, h);
          for (const h of data.history!) map.set(h.round, h);
          const merged = Array.from(map.values()).sort((a, b) => a.round - b.round);
          historyRef.current = merged;
          return merged;
        });
      }
    });

    return () => {
      unmounted = true;
      unlistenParticipants();
      unlistenState();
    };
  }, [sdk]);

  // Handle language switch
  const handleLanguageChange = useCallback(
    (newLang: string) => {
      const meta = getLanguageMeta(newLang);
      let newLen = wordLength;
      if (!meta.availableLengths.includes(newLen)) {
        newLen = meta.availableLengths.includes(5) ? 5 : meta.availableLengths[0];
      }

      setLangState(newLang);
      setWordLength(newLen);
      setGuesses([]);
      setCurrentInput('');
      setStatus('idle');
      setSeed(0);

      broadcast({
        lang: newLang,
        wordLength: newLen,
        guesses: [],
        currentInput: '',
        status: 'idle',
        seed: 0,
      });
    },
    [broadcast, wordLength]
  );

  // Handle word length switch (2 to 15)
  const handleLengthChange = useCallback(
    (newLen: number) => {
      setWordLength(newLen);
      setGuesses([]);
      setCurrentInput('');
      setStatus('idle');
      setSeed(0);

      broadcast({
        wordLength: newLen,
        guesses: [],
        currentInput: '',
        status: 'idle',
        seed: 0,
      });
    },
    [broadcast]
  );

  // Handle typing & submission
  const handleKey = useCallback(
    (key: string) => {
      if (status !== 'playing' || init?.readOnly || !targetWord || loadingWords) return;
      const upper = key.toUpperCase();

      if (upper === '⌫' || upper === 'BACKSPACE' || upper === 'DELETE') {
        if (currentInput.length > 0) {
          const next = currentInput.slice(0, -1);
          setCurrentInput(next);
          broadcast({ currentInput: next });
        }
        return;
      }

      if (upper === 'ENTER') {
        if (currentInput.length < wordLength) {
          notify(messages.wordTooShort);
          setShakingRow(guesses.length);
          setTimeout(() => setShakingRow(null), 500);
          return;
        }

        const guessWord = currentInput.toLowerCase();
        if (!wordListData.set.has(guessWord)) {
          notify(messages.notInDictionary);
          setShakingRow(guesses.length);
          setTimeout(() => setShakingRow(null), 500);
          return;
        }

        const evaluation = evaluateGuess(guessWord, targetWord);
        const newSubmission: GuessSubmission = {
          id: generateId(),
          word: guessWord,
          evaluation,
          by: init?.self ?? 'local',
          at: Date.now(),
        };

        const nextGuesses = [...guesses, newSubmission];
        const won = guessWord === targetWord;
        const lost = !won && nextGuesses.length >= 6;
        const nextStatus: GameStatus = won ? 'won' : lost ? 'lost' : 'playing';

        let nextHistory = historyRef.current;
        if (won || lost) {
          const startTime = roundStartedAtRef.current;
          const elapsed = startTime ? Math.max(1, Math.round((Date.now() - startTime) / 1000)) : 0;
          const historyItem: RoundHistoryItem = {
            round: roundNumber,
            word: targetWord.toUpperCase(),
            durationSeconds: elapsed,
            attempts: nextGuesses.length,
            won,
            timestamp: Date.now(),
          };
          nextHistory = [...historyRef.current.filter((h) => h.round !== roundNumber), historyItem];
          historyRef.current = nextHistory;
          setHistory(nextHistory);
        }

        setFlippingRow(guesses.length);
        setTimeout(() => setFlippingRow(null), 1000);

        setGuesses(nextGuesses);
        setCurrentInput('');
        setStatus(nextStatus);

        broadcast({
          guesses: nextGuesses,
          currentInput: '',
          status: nextStatus,
          history: nextHistory,
        });

        if (won) {
          setTimeout(() => {
            notify(targetWord.toUpperCase(), 3500);
            setStatsOpen(true);
          }, 600);
        } else if (lost) {
          setTimeout(() => {
            notify(targetWord.toUpperCase(), 4500);
            setStatsOpen(true);
          }, 600);
        }
        return;
      }

      // Append character up to wordLength
      if (currentInput.length < wordLength && key.length === 1) {
        const next = currentInput + key.toLowerCase();
        setCurrentInput(next);
        broadcast({ currentInput: next });
      }
    },
    [status, init, currentInput, wordLength, targetWord, loadingWords, guesses, messages, wordListData, roundNumber, roundStartedAt, history, broadcast, notify]
  );

  // Keyboard listener
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('.modal-overlay')) return;
      if (status !== 'playing') return;
      if (e.key === 'Enter') handleKey('ENTER');
      else if (e.key === 'Backspace') handleKey('⌫');
      else if (e.key.length === 1) handleKey(e.key.toLowerCase());
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleKey, status]);

  // Build grid matrix for rendering
  const gridRows = useMemo(() => {
    const rows: { chars: string[]; colors: TileColor[] }[] = [];
    for (let r = 0; r < 6; r++) {
      if (r < guesses.length) {
        rows.push({
          chars: guesses[r].word.split(''),
          colors: guesses[r].evaluation,
        });
      } else if (r === guesses.length) {
        const chars = currentInput
          .padEnd(wordLength, ' ')
          .split('')
          .map((c) => (c === ' ' ? '' : c));
        rows.push({
          chars,
          colors: Array.from({ length: wordLength }, () => 'absent'),
        });
      } else {
        rows.push({
          chars: Array.from({ length: wordLength }, () => ''),
          colors: Array.from({ length: wordLength }, () => 'absent'),
        });
      }
    }
    return rows;
  }, [guesses, currentInput, wordLength]);

  const allLanguages = useMemo(() => getLanguageList(), []);
  const sortedHistory = useMemo(() => {
    return [...history].sort((a, b) => b.round - a.round);
  }, [history]);

  return (
    <div className="nordle-app">
      <header className="header">
        <div className="header-group">
          <button
            className="icon-btn"
            onClick={() => setHelpOpen(true)}
            title={messages.help}
            type="button"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </button>

          <select
            className="lang-select"
            value={lang}
            onChange={(e) => handleLanguageChange((e.target as HTMLSelectElement).value)}
            disabled={init?.readOnly}
            title={messages.selectLanguage}
          >
            {allLanguages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.nativeName} ({l.code.toUpperCase()})
              </option>
            ))}
          </select>

          <select
            className="len-select"
            value={wordLength}
            onChange={(e) => handleLengthChange(parseInt((e.target as HTMLSelectElement).value, 10))}
            disabled={init?.readOnly}
            title={messages.selectLength}
          >
            {activeMeta.availableLengths.map((len) => (
              <option key={len} value={len}>
                {len} {messages.letters}
              </option>
            ))}
          </select>
        </div>

        <h1 className="title">NORDLE</h1>

        <div className="header-group">
          {(roundNumber > 0 || history.length > 0) && (
            <button
              type="button"
              className="round-badge clickable"
              onClick={() => setHistoryOpen(true)}
              title={messages.roundHistory}
            >
              #{roundNumber > 0 ? roundNumber : 1}
            </button>
          )}

          {status === 'playing' && (
            <button
              className="icon-btn"
              onClick={startNewGame}
              disabled={loadingWords}
              title={messages.newGame}
              type="button"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
            </button>
          )}

          <button
            className="icon-btn"
            onClick={() => setStatsOpen(true)}
            title={messages.stats}
            type="button"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 20V10M12 20V4M6 20v-6" />
            </svg>
          </button>
        </div>
      </header>

      <main className="main-content" style={{ position: 'relative' }}>
        <div className="board-wrap">
          <div className="board" style={{ '--word-length': wordLength }}>
            {gridRows.map((row, rIdx) => {
              const isShaking = shakingRow === rIdx;
              const isFlipping = flippingRow === rIdx;
              return (
                <div
                  key={rIdx}
                  className={`row ${isRTL ? 'rtl' : ''} ${isShaking ? 'shake' : ''}`}
                >
                  {row.chars.map((char, cIdx) => {
                    const color = rIdx < guesses.length ? row.colors[cIdx] : '';
                    const filled = !!char;
                    const tileClass = `tile ${filled ? 'filled' : ''} ${color} ${isFlipping ? 'flip' : ''}`.trim();
                    const style = isFlipping ? { animationDelay: `${cIdx * 120}ms` } : undefined;

                    return (
                      <div key={cIdx} className={tileClass} style={style}>
                        {char}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* Idle Start Game Overlay */}
        {status === 'idle' && (
          <div className="idle-overlay">
            <div className="idle-card">
              <h2 className="idle-title">{messages.idleTitle}</h2>
              <p className="idle-desc">{messages.idleSubtitle}</p>
              <button
                className="button-primary button-start"
                onClick={startNewGame}
                disabled={init?.readOnly || loadingWords}
                type="button"
              >
                {loadingWords ? '...' : messages.startGame}
              </button>
            </div>
          </div>
        )}

        <div className="keyboard">
          {activeMeta.keyboard.map((row, rIdx) => (
            <div key={rIdx} className="kb-row">
              {row.map((k) => {
                const isWide = k === 'ENTER' || k === '⌫' || k === '⇨' || k.length > 2;
                const keyLower = (k === '⇨' ? 'ENTER' : k).toLowerCase();
                const color = keyColors[keyLower] || '';
                const btnClass = `key ${isWide ? 'wide' : ''} ${color}`.trim();
                const label = k === '⇨' ? 'ENTER' : k;

                return (
                  <button
                    key={k}
                    className={btnClass}
                    onClick={() => handleKey(label)}
                    disabled={status !== 'playing' || loadingWords}
                    type="button"
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </main>

      {/* Floating toast */}
      {toastMessage && <div className="toast">{toastMessage}</div>}

      {/* Help Modal */}
      {helpOpen && (
        <div className="modal-overlay" onClick={() => setHelpOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">{messages.help}</h2>
              <button className="modal-close" onClick={() => setHelpOpen(false)} type="button">
                &times;
              </button>
            </div>
            <p style={{ fontSize: '0.88rem', marginBottom: '8px' }}>
              {locale === 'it'
                ? `Indovina la parola di ${wordLength} lettere in 6 tentativi.`
                : `Guess the ${wordLength}-letter word in 6 tries.`}
            </p>
            <p style={{ fontSize: '0.88rem', marginBottom: '8px' }}>
              {locale === 'it'
                ? 'Ogni tentativo deve essere una parola valida della lunghezza selezionata.'
                : 'Each guess must be a valid word of the selected length.'}
            </p>
            <p style={{ fontSize: '0.88rem', marginBottom: '14px' }}>
              {locale === 'it'
                ? 'Il colore delle caselle cambierà per mostrare quanto ti sei avvicinato.'
                : 'The color of the tiles will change to show how close your guess was.'}
            </p>

            <button className="button-primary" onClick={() => setHelpOpen(false)} type="button">
              {locale === 'it' ? 'Chiudi' : 'Close'}
            </button>
          </div>
        </div>
      )}

      {/* Stats / End of Round Modal */}
      {statsOpen && (
        <div className="modal-overlay" onClick={() => setStatsOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">{status === 'won' ? messages.congratulations : messages.stats}</h2>
              <button className="modal-close" onClick={() => setStatsOpen(false)} type="button">
                &times;
              </button>
            </div>

            <div style={{ textAlign: 'center', fontSize: '1.2rem', margin: '14px 0', whiteSpace: 'pre-line' }}>
              {guesses.map((g) => g.evaluation.map((c) => (c === 'correct' ? '🟩' : c === 'semi' ? '🟨' : '⬜')).join('')).join('\n')}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-around', margin: '14px 0', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', padding: '12px 0' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{guesses.length}/6</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{messages.guessesCount}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{participants.length}</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{messages.playersCount}</div>
              </div>
            </div>

            <button
              className="button-primary"
              onClick={startNewGame}
              disabled={loadingWords}
              type="button"
            >
              {messages.newGame}
            </button>

            <button
              className="button-secondary"
              onClick={() => {
                setStatsOpen(false);
                setHistoryOpen(true);
              }}
              type="button"
            >
              {messages.roundHistory}
            </button>

            <button
              className="button-secondary"
              onClick={async () => {
                const text = `Nordle Round #${roundNumber} ${status === 'won' ? guesses.length + '/6' : 'X/6'}\n\n` +
                  guesses.map((g) => g.evaluation.map((c) => (c === 'correct' ? '🟩' : c === 'semi' ? '🟨' : '⬜')).join('')).join('\n');
                if (navigator.clipboard) {
                  await navigator.clipboard.writeText(text);
                  notify(messages.copied);
                }
              }}
              type="button"
            >
              {messages.share}
            </button>
          </div>
        </div>
      )}

      {/* Round History Modal */}
      {historyOpen && (
        <div className="modal-overlay" onClick={() => setHistoryOpen(false)}>
          <div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">{messages.roundHistory}</h2>
              <button className="modal-close" onClick={() => setHistoryOpen(false)} type="button">
                &times;
              </button>
            </div>

            <div className="history-table-wrap">
              {sortedHistory.length === 0 ? (
                <div className="history-empty">{messages.noRoundsYet}</div>
              ) : (
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>{messages.roundCol}</th>
                      <th>{messages.wordCol}</th>
                      <th>{messages.timeCol}</th>
                      <th style={{ textAlign: 'right' }}>{messages.attemptsCol}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedHistory.map((item) => (
                      <tr key={item.round}>
                        <td>
                          <strong>#{item.round}</strong>
                        </td>
                        <td className="history-word">{item.word}</td>
                        <td>{formatDuration(item.durationSeconds)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <span className={`status-pill ${item.won ? 'won' : 'lost'}`}>
                            {item.won ? `${item.attempts}/6` : 'X/6'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <button className="button-primary" onClick={() => setHistoryOpen(false)} type="button">
              {locale === 'it' ? 'Chiudi' : 'Close'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
