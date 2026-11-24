import type { Uuid } from '@novyse/app-sdk';

export const NORDLE_STATE = 'NORDLE_STATE';

export type TileColor = 'correct' | 'semi' | 'absent';

export interface GuessSubmission {
  id: string;
  word: string;
  evaluation: TileColor[];
  by: Uuid;
  at: number;
}

export interface RoundHistoryItem {
  round: number;
  word: string;
  durationSeconds: number;
  attempts: number;
  won: boolean;
  timestamp: number;
}

export type GameStatus = 'idle' | 'playing' | 'won' | 'lost';

export interface NordleSnapshot {
  lang: string;
  wordLength: number;
  seed: number;
  roundNumber: number;
  dayIdx?: number;
  guesses: GuessSubmission[];
  currentInput: string;
  status: GameStatus;
  roundStartedAt?: number;
  history?: RoundHistoryItem[];
  lastUpdatedBy?: Uuid;
}

export interface NordleAnchor extends NordleSnapshot {
  seq: number;
  ts: number;
}

export function evaluateGuess(guess: string, target: string): TileColor[] {
  const len = target.length;
  const targetChars = target.split('');
  const guessChars = guess.split('');
  const result: TileColor[] = Array.from({ length: len }, () => 'absent');
  const counts: Record<string, number> = {};

  for (const c of targetChars) {
    counts[c] = (counts[c] || 0) + 1;
  }

  // First pass: exact matches
  for (let i = 0; i < len; i++) {
    if (guessChars[i] === targetChars[i]) {
      result[i] = 'correct';
      counts[guessChars[i]]--;
    }
  }

  // Second pass: misplaced characters
  for (let i = 0; i < len; i++) {
    if (result[i] === 'absent' && (counts[guessChars[i]] || 0) > 0) {
      result[i] = 'semi';
      counts[guessChars[i]]--;
    }
  }

  return result;
}

export function computeKeyColors(guesses: GuessSubmission[]): Record<string, TileColor> {
  const keys: Record<string, TileColor> = {};

  for (const g of guesses) {
    for (let i = 0; i < g.word.length; i++) {
      const c = g.word[i];
      const color = g.evaluation[i];
      if (color === 'correct') {
        keys[c] = 'correct';
      } else if (color === 'semi' && keys[c] !== 'correct') {
        keys[c] = 'semi';
      } else if (color === 'absent' && !keys[c]) {
        keys[c] = 'absent';
      }
    }
  }

  return keys;
}

export function generateId(): string {
  return Math.random().toString(36).slice(2, 9);
}
