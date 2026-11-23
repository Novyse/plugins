/**
 * Translations of the activity, English and Italian.
 *
 * The host sends its language in `init().locale` (a BCP-47 tag like `it-IT`);
 * `plugin.json` lists the languages of the plugin. A tag we do not know falls
 * back to English, so an unsupported client still gets a usable UI.
 */
export type Locale = 'en' | 'it';

export const LOCALES: Locale[] = ['en', 'it'];

export function normalizeLocale(tag: string | null | undefined): Locale {
  const base = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];

  return LOCALES.includes(base as Locale) ? (base as Locale) : 'en';
}

export interface Messages {
  title: string;
  tagline: string;
  phaseFocus: string;
  phaseShort: string;
  start: string;
  pause: string;
  restart: string;
  reset: string;
  running: string;
  paused: string;
  done: string;
  duration: string;
  hours: string;
  minutes: string;
  seconds: string;
  hoursLong: string;
  minutesLong: string;
  secondsLong: string;
  increase: (unit: string) => string;
  decrease: (unit: string) => string;
  fullscreen: string;
  readOnly: string;
  ended: (reason: string) => string;
  error: string;
  loading: string;
}

const EN: Messages = {
  title: 'Timer',
  tagline: 'One timer for the whole room',
  phaseFocus: 'Focus',
  phaseShort: 'Short break',
  start: 'Start',
  pause: 'Pause',
  restart: 'Restart',
  reset: 'Reset',
  running: 'running',
  paused: 'paused',
  done: 'time is up',
  duration: 'Duration',
  hours: 'h',
  minutes: 'm',
  seconds: 's',
  hoursLong: 'hours',
  minutesLong: 'minutes',
  secondsLong: 'seconds',
  increase: (unit) => `Increase ${unit}`,
  decrease: (unit) => `Decrease ${unit}`,
  fullscreen: 'Full screen',
  readOnly: 'Read only: you can follow the timer, not change it.',
  ended: (reason) => `Timer ended (${reason}).`,
  error: 'Error',
  loading: 'Loading…',
};

const IT: Messages = {
  title: 'Timer',
  tagline: 'Un timer per tutta la stanza',
  phaseFocus: 'Focus',
  phaseShort: 'Pausa breve',
  start: 'Avvia',
  pause: 'Pausa',
  restart: 'Ricomincia',
  reset: 'Azzera',
  running: 'in corso',
  paused: 'in pausa',
  done: 'tempo scaduto',
  duration: 'Durata',
  hours: 'h',
  minutes: 'm',
  seconds: 's',
  hoursLong: 'ore',
  minutesLong: 'minuti',
  secondsLong: 'secondi',
  increase: (unit) => `Aumenta ${unit}`,
  decrease: (unit) => `Diminuisci ${unit}`,
  fullscreen: 'Schermo intero',
  readOnly: 'Sola lettura: puoi seguire il timer, non modificarlo.',
  ended: (reason) => `Timer terminato (${reason}).`,
  error: 'Errore',
  loading: 'Caricamento…',
};

export function messagesFor(locale: Locale): Messages {
  return locale === 'it' ? IT : EN;
}
