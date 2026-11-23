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
  spin: string;
  spinning: string;
  wheelLabel: string;
  options: string;
  results: string;
  addPlaceholder: string;
  add: string;
  remove: (label: string) => string;
  hide: (label: string) => string;
  show: (label: string) => string;
  shuffle: string;
  sort: string;
  clear: string;
  clearConfirm: string;
  cancel: string;
  empty: string;
  needVisible: string;
  maxReached: (max: number) => string;
  hiddenCount: (count: number) => string;
  onWin: string;
  winnerKeep: string;
  winnerHide: string;
  winnerRemove: string;
  winner: string;
  again: string;
  clearResults: string;
  resultsEmpty: string;
  transfer: string;
  exportLabel: string;
  importLabel: string;
  copy: string;
  copied: string;
  exportHint: string;
  importHint: string;
  importInvalid: string;
  importStrings: string;
  importTooMany: (max: number) => string;
  importEmpty: string;
  copyFailed: string;
  openPanel: string;
  collapsePanel: string;
  close: string;
  fullscreen: string;
  readOnly: string;
  ended: (reason: string) => string;
  error: string;
  loading: string;
}

const EN: Messages = {
  title: 'Wheel',
  tagline: 'Let the room decide',
  spin: 'Spin',
  spinning: 'Spinning…',
  wheelLabel: 'Wheel of fortune',
  options: 'Options',
  results: 'Results',
  addPlaceholder: 'Add an option…',
  add: 'Add option',
  remove: (label) => `Remove ${label}`,
  hide: (label) => `Hide ${label} from the wheel`,
  show: (label) => `Show ${label} on the wheel`,
  shuffle: 'Shuffle',
  sort: 'Sort A–Z',
  clear: 'Clear',
  clearConfirm: 'Clear all options?',
  cancel: 'Cancel',
  empty: 'Add at least two options to spin.',
  needVisible: 'Show at least two options to spin.',
  maxReached: (max) => `Maximum ${max} options.`,
  hiddenCount: (count) => `${count} hidden from the wheel.`,
  onWin: 'On win',
  winnerKeep: 'Keep',
  winnerHide: 'Hide',
  winnerRemove: 'Remove',
  winner: 'The wheel says',
  again: 'Spin again',
  clearResults: 'Clear results',
  resultsEmpty: 'No results yet.',
  transfer: 'Import / Export',
  exportLabel: 'Export',
  importLabel: 'Import',
  copy: 'Copy',
  copied: 'Copied',
  exportHint: 'One JSON string per option. Commas inside a phrase are fine.',
  importHint:
    'Paste a JSON array of strings. It replaces the current options; commas inside a phrase stay in that option.',
  importInvalid: 'Use a valid JSON array, for example ["one", "two"].',
  importStrings: 'Every item must be a string.',
  importTooMany: (max) => `At most ${max} options.`,
  importEmpty: 'The array has no usable options.',
  copyFailed: 'Copy failed: select the text and copy it manually.',
  openPanel: 'Open options',
  collapsePanel: 'Close options panel',
  close: 'Close',
  fullscreen: 'Full screen',
  readOnly: 'Read only: you can watch the spin, not change it.',
  ended: (reason) => `Wheel ended (${reason}).`,
  error: 'Error',
  loading: 'Loading…',
};

const IT: Messages = {
  title: 'Ruota',
  tagline: 'La stanza decide',
  spin: 'Gira',
  spinning: 'Gira…',
  wheelLabel: 'Ruota della fortuna',
  options: 'Opzioni',
  results: 'Risultati',
  addPlaceholder: 'Aggiungi un’opzione…',
  add: 'Aggiungi opzione',
  remove: (label) => `Rimuovi ${label}`,
  hide: (label) => `Nascondi ${label} dalla ruota`,
  show: (label) => `Mostra ${label} sulla ruota`,
  shuffle: 'Mescola',
  sort: 'Ordina A–Z',
  clear: 'Svuota',
  clearConfirm: 'Svuotare tutte le opzioni?',
  cancel: 'Annulla',
  empty: 'Aggiungi almeno due opzioni per girare.',
  needVisible: 'Mostra almeno due opzioni per girare.',
  maxReached: (max) => `Massimo ${max} opzioni.`,
  hiddenCount: (count) => `${count} nascoste dalla ruota.`,
  onWin: 'Al vincitore',
  winnerKeep: 'Mantieni',
  winnerHide: 'Nascondi',
  winnerRemove: 'Rimuovi',
  winner: 'La ruota dice',
  again: 'Gira di nuovo',
  clearResults: 'Pulisci risultati',
  resultsEmpty: 'Nessun risultato.',
  transfer: 'Importa / Esporta',
  exportLabel: 'Esporta',
  importLabel: 'Importa',
  copy: 'Copia',
  copied: 'Copiato',
  exportHint: 'Una stringa JSON per opzione. Le virgole dentro una frase vanno bene.',
  importHint:
    'Incolla un array JSON di stringhe. Sostituisce le opzioni attuali; le virgole dentro una frase restano in quella opzione.',
  importInvalid: 'Usa un array JSON valido, per esempio ["uno", "due"].',
  importStrings: 'Ogni elemento deve essere una stringa.',
  importTooMany: (max) => `Massimo ${max} opzioni.`,
  importEmpty: 'L’array non contiene opzioni utilizzabili.',
  copyFailed: 'Copia non riuscita: seleziona il testo e copialo a mano.',
  openPanel: 'Apri opzioni',
  collapsePanel: 'Chiudi pannello opzioni',
  close: 'Chiudi',
  fullscreen: 'Schermo intero',
  readOnly: 'Sola lettura: puoi guardare la ruota, non modificarla.',
  ended: (reason) => `Ruota terminata (${reason}).`,
  error: 'Errore',
  loading: 'Caricamento…',
};

export function messagesFor(locale: Locale): Messages {
  return locale === 'it' ? IT : EN;
}
