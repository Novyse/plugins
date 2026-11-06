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
  room: (chat: string, sub: number, self: string) => string;
  increment: string;
  ping: string;
  pings: (count: number) => string;
  lastFrom: (sender: string) => string;
  events: (count: number, trimmed: boolean) => string;
  readOnly: string;
  live: string;
  ended: (reason: string) => string;
}

const EN: Messages = {
  title: 'Hello Activity',
  room: (chat, sub, self) => `Room ${chat} · sub ${sub} · you are ${self}`,
  increment: 'Add one',
  ping: 'Ping',
  pings: (count) => `${count} ping${count === 1 ? '' : 's'}`,
  lastFrom: (sender) => `last from ${sender}`,
  events: (count, trimmed) =>
    `${count} event${count === 1 ? '' : 's'}${trimmed ? ' (trimmed)' : ''}`,
  readOnly: 'read only',
  live: 'live',
  ended: (reason) => `Activity ended (${reason}).`,
};

const IT: Messages = {
  title: 'Hello Activity',
  room: (chat, sub, self) => `Stanza ${chat} · sub ${sub} · sei ${self}`,
  increment: 'Aggiungi uno',
  ping: 'Ping',
  pings: (count) => `${count} ping`,
  lastFrom: (sender) => `ultimo da ${sender}`,
  events: (count, trimmed) =>
    `${count} event${count === 1 ? 'o' : 'i'}${trimmed ? ' (troncati)' : ''}`,
  readOnly: 'sola lettura',
  live: 'live',
  ended: (reason) => `Attività terminata (${reason}).`,
};

export function messagesFor(locale: Locale): Messages {
  return locale === 'it' ? IT : EN;
}
