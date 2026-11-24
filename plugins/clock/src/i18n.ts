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
  toolTimer: string;
  toolStopwatch: string;
  toolAlarm: string;
  phaseFocus: string;
  phaseShort: string;
  start: string;
  pause: string;
  restart: string;
  reset: string;
  arm: string;
  disarm: string;
  dismiss: string;
  running: string;
  paused: string;
  done: string;
  armed: string;
  ringing: string;
  idle: string;
  duration: string;
  alarmTime: string;
  ringsAt: (time: string) => string;
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
  title: 'Clock',
  tagline: 'Timer, stopwatch and alarm for the room',
  toolTimer: 'Timer',
  toolStopwatch: 'Stopwatch',
  toolAlarm: 'Alarm',
  phaseFocus: 'Focus',
  phaseShort: 'Short break',
  start: 'Start',
  pause: 'Pause',
  restart: 'Restart',
  reset: 'Reset',
  arm: 'Arm',
  disarm: 'Disarm',
  dismiss: 'Dismiss',
  running: 'running',
  paused: 'paused',
  done: 'time is up',
  armed: 'armed',
  ringing: 'ringing',
  idle: 'idle',
  duration: 'Duration',
  alarmTime: 'Alarm time',
  ringsAt: (time) => `Rings at ${time}`,
  hours: 'h',
  minutes: 'm',
  seconds: 's',
  hoursLong: 'hours',
  minutesLong: 'minutes',
  secondsLong: 'seconds',
  increase: (unit) => `Increase ${unit}`,
  decrease: (unit) => `Decrease ${unit}`,
  fullscreen: 'Full screen',
  readOnly: 'Read only: you can follow the clock, not change it.',
  ended: (reason) => `Clock ended (${reason}).`,
  error: 'Error',
  loading: 'Loading…',
};

const IT: Messages = {
  title: 'Clock',
  tagline: 'Timer, cronometro e sveglia per la stanza',
  toolTimer: 'Timer',
  toolStopwatch: 'Cronometro',
  toolAlarm: 'Sveglia',
  phaseFocus: 'Focus',
  phaseShort: 'Pausa breve',
  start: 'Avvia',
  pause: 'Pausa',
  restart: 'Ricomincia',
  reset: 'Azzera',
  arm: 'Attiva',
  disarm: 'Disattiva',
  dismiss: 'Chiudi',
  running: 'in corso',
  paused: 'in pausa',
  done: 'tempo scaduto',
  armed: 'attiva',
  ringing: 'sta suonando',
  idle: 'inattiva',
  duration: 'Durata',
  alarmTime: 'Ora della sveglia',
  ringsAt: (time) => `Suona alle ${time}`,
  hours: 'h',
  minutes: 'm',
  seconds: 's',
  hoursLong: 'ore',
  minutesLong: 'minuti',
  secondsLong: 'secondi',
  increase: (unit) => `Aumenta ${unit}`,
  decrease: (unit) => `Diminuisci ${unit}`,
  fullscreen: 'Schermo intero',
  readOnly: 'Sola lettura: puoi seguire l\'orologio, non modificarlo.',
  ended: (reason) => `Clock terminato (${reason}).`,
  error: 'Errore',
  loading: 'Caricamento…',
};

export function messagesFor(locale: Locale): Messages {
  return locale === 'it' ? IT : EN;
}
