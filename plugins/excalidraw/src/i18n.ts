/**
 * Translations of the board, English and Italian.
 *
 * The host sends its language in `init().locale` as a BCP-47 tag (`it-IT`); a
 * tag we do not know falls back to English, so an older client still gets a
 * usable interface. Excalidraw's own labels follow `langCode`, and their
 * language files travel in the bundle.
 */
export type Locale = 'en' | 'it';

export const LOCALES: Locale[] = ['en', 'it'];

export function normalizeLocale(tag: string | null | undefined): Locale {
  const base = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];

  return LOCALES.includes(base as Locale) ? (base as Locale) : 'en';
}

export interface Messages {
  opening: string;
  readOnly: string;
  ended: string;
  error: string;
  noHost: string;
}

const EN: Messages = {
  opening: 'Opening the board…',
  readOnly: 'Read only: you can follow the board, not draw on it.',
  ended: 'The activity ended. The board stays as it is.',
  error: 'Something went wrong',
  noHost: 'This board lives inside the Novyse app.',
};

const IT: Messages = {
  opening: 'Apro la lavagna…',
  readOnly: 'Sola lettura: puoi seguire la lavagna, non disegnarci.',
  ended: 'Attività terminata. La lavagna resta com’è.',
  error: 'Qualcosa è andato storto',
  noHost: 'Questa lavagna vive dentro l’app Novyse.',
};

export function messagesFor(locale: Locale): Messages {
  return locale === 'it' ? IT : EN;
}
