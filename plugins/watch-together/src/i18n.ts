/**
 * Translations of the plugin UI.
 *
 * The host sends its language in `init().locale`, a BCP-47 tag (`it-IT`,
 * `en-GB`, ...); `plugin.json` lists the languages this plugin ships. A tag we
 * do not know falls back to English, and so does the first frame, rendered
 * before `init()` resolves.
 */
import type { EmbedErrorCode } from './embed';

export type Locale = 'en' | 'it';

/** The languages of the manifest, in the order the store shows them. */
export const LOCALES: Locale[] = ['en', 'it'];

/** `it-IT` and `it` are the same language; anything unknown is English. */
export function normalizeLocale(tag: string | null | undefined): Locale {
  const base = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];

  return LOCALES.includes(base as Locale) ? (base as Locale) : 'en';
}

export interface Messages {
  placeholder: string;
  watch: string;
  detected: (platform: string) => string;
  readOnlyHint: string;
  hint: string;
  backToVideo: string;
  errorEmpty: string;
  errorInsecure: string;
  errorInvalid: string;
  activityClosed: string;
  fileNeedsApp: string;
  chooseAnother: string;
  playingInApp: string;
  changeVideo: string;
  changeVideoHint: string;
  loading: string;
  platformYoutube: string;
  platformTwitchLive: string;
  platformTwitchVideo: string;
  platformFile: string;
  embedError: (code: EmbedErrorCode, detail?: number) => string;
}

const EN_ERRORS: Record<Exclude<EmbedErrorCode, 'youtube-refused'>, string> = {
  'youtube-not-available': 'The YouTube player is not available',
  'youtube-fetch-failed': 'The YouTube player could not be fetched',
  'twitch-no-domain': 'Twitch cannot be embedded here: no domain to declare',
  'twitch-not-available': 'The Twitch player is not available',
  'twitch-fetch-failed': 'The Twitch player could not be fetched',
};

const IT_ERRORS: Record<Exclude<EmbedErrorCode, 'youtube-refused'>, string> = {
  'youtube-not-available': 'Il player di YouTube non è disponibile',
  'youtube-fetch-failed': 'Impossibile caricare il player di YouTube',
  'twitch-no-domain': 'Twitch non può essere incorporato qui: nessun dominio da dichiarare',
  'twitch-not-available': 'Il player di Twitch non è disponibile',
  'twitch-fetch-failed': 'Impossibile caricare il player di Twitch',
};

const EN: Messages = {
  placeholder: 'Paste a YouTube, Twitch or video link',
  watch: 'Watch',
  detected: (platform) => `Detected ${platform}`,
  readOnlyHint: 'Only participants who can start activities can pick the video.',
  hint: 'YouTube · Twitch · direct video files',
  backToVideo: 'Back to the video',
  errorEmpty: 'Paste a link',
  errorInsecure: 'Only https video links are supported',
  errorInvalid: 'Not a video link',
  activityClosed: 'The activity was closed.',
  fileNeedsApp: 'Video files play in the Novyse app, not in a browser tab.',
  chooseAnother: 'Choose another link',
  playingInApp: 'Playing in the app player…',
  changeVideo: 'Change video',
  changeVideoHint: 'Change video (Esc)',
  loading: 'Loading…',
  platformYoutube: 'YouTube',
  platformTwitchLive: 'Twitch · live',
  platformTwitchVideo: 'Twitch · video',
  platformFile: 'Video',
  embedError: (code, detail) =>
    code === 'youtube-refused'
      ? `YouTube refused this video (code ${detail ?? 0}).`
      : EN_ERRORS[code],
};

const IT: Messages = {
  placeholder: 'Incolla un link di YouTube, Twitch o un video',
  watch: 'Guarda',
  detected: (platform) => `Riconosciuto ${platform}`,
  readOnlyHint: 'Solo chi può avviare le attività può scegliere il video.',
  hint: 'YouTube · Twitch · file video diretti',
  backToVideo: 'Torna al video',
  errorEmpty: 'Incolla un link',
  errorInsecure: 'Sono supportati solo link video https',
  errorInvalid: 'Non è un link video',
  activityClosed: "L'attività è stata chiusa.",
  fileNeedsApp: 'I file video si riproducono nella app Novyse, non in una scheda del browser.',
  chooseAnother: 'Scegli un altro link',
  playingInApp: "Riproduzione nel player dell'app…",
  changeVideo: 'Cambia video',
  changeVideoHint: 'Cambia video (Esc)',
  loading: 'Caricamento…',
  platformYoutube: 'YouTube',
  platformTwitchLive: 'Twitch · live',
  platformTwitchVideo: 'Twitch · video',
  platformFile: 'Video',
  embedError: (code, detail) =>
    code === 'youtube-refused'
      ? `YouTube ha rifiutato questo video (codice ${detail ?? 0}).`
      : IT_ERRORS[code],
};

export function messagesFor(locale: Locale): Messages {
  return locale === 'it' ? IT : EN;
}
