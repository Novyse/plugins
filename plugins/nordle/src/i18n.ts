export type Locale = 'en' | 'it';

export const LOCALES: Locale[] = ['en', 'it'];

export function normalizeLocale(tag: string | null | undefined): Locale {
  const base = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return LOCALES.includes(base as Locale) ? (base as Locale) : 'en';
}

export interface Messages {
  title: string;
  tagline: string;
  selectLanguage: string;
  selectLength: string;
  letters: string;
  help: string;
  stats: string;
  wordTooShort: string;
  notInDictionary: string;
  congratulations: string;
  gameOver: string;
  played: string;
  winRate: string;
  currentStreak: string;
  maxStreak: string;
  nextWord: string;
  share: string;
  copied: string;
  roomSync: string;
  guessesCount: string;
  playersCount: string;
  startGame: string;
  newGame: string;
  round: string;
  roundHistory: string;
  roundCol: string;
  wordCol: string;
  timeCol: string;
  attemptsCol: string;
  statusCol: string;
  wonLabel: string;
  lostLabel: string;
  noRoundsYet: string;
  idleTitle: string;
  idleSubtitle: string;
}

export const MESSAGES: Record<Locale, Messages> = {
  en: {
    title: 'Nordle',
    tagline: 'Collaborative daily word puzzle',
    selectLanguage: 'Language',
    selectLength: 'Word length',
    letters: 'letters',
    help: 'How to Play',
    stats: 'Statistics',
    wordTooShort: 'Not enough letters',
    notInDictionary: 'Not in word list',
    congratulations: 'Splendid!',
    gameOver: 'Game Over',
    played: 'Played',
    winRate: 'Win %',
    currentStreak: 'Current Streak',
    maxStreak: 'Max Streak',
    nextWord: 'Next word in',
    share: 'Share',
    copied: 'Copied to clipboard',
    roomSync: 'In sync with room',
    guessesCount: 'Guesses',
    playersCount: 'Players',
    startGame: 'Start Game',
    newGame: 'New Game',
    round: 'Round',
    roundHistory: 'Round History',
    roundCol: 'Round',
    wordCol: 'Word',
    timeCol: 'Time',
    attemptsCol: 'Attempts',
    statusCol: 'Status',
    wonLabel: 'Won',
    lostLabel: 'Lost',
    noRoundsYet: 'No rounds completed yet.',
    idleTitle: 'Ready to Play?',
    idleSubtitle: 'Choose your language and word length, then start the round.'
  },
  it: {
    title: 'Nordle',
    tagline: 'Puzzle di parole quotidiano collaborativo',
    selectLanguage: 'Lingua',
    selectLength: 'Lunghezza parola',
    letters: 'lettere',
    help: 'Come giocare',
    stats: 'Statistiche',
    wordTooShort: 'Lettere insufficienti',
    notInDictionary: 'Parola non valida',
    congratulations: 'Complimenti!',
    gameOver: 'Partita terminata',
    played: 'Partite',
    winRate: 'Vittorie %',
    currentStreak: 'Serie attuale',
    maxStreak: 'Serie record',
    nextWord: 'Prossima parola in',
    share: 'Condividi',
    copied: 'Copiato negli appunti',
    roomSync: 'In sincronia con la stanza',
    guessesCount: 'Tentativi',
    playersCount: 'Giocatori',
    startGame: 'Inizia Partita',
    newGame: 'Nuova Partita',
    round: 'Round',
    roundHistory: 'Cronologia Round',
    roundCol: 'Round',
    wordCol: 'Parola',
    timeCol: 'Tempo',
    attemptsCol: 'Tentativi',
    statusCol: 'Stato',
    wonLabel: 'Vinto',
    lostLabel: 'Perso',
    noRoundsYet: 'Nessun round completato finora.',
    idleTitle: 'Pronto a giocare?',
    idleSubtitle: 'Scegli la lingua e le lettere, poi premi Inizia Partita.'
  }
};

export function messagesFor(locale: string | null | undefined): Messages {
  return MESSAGES[normalizeLocale(locale)];
}
