/**
 * Colors of the host, and the two standard ways to use them.
 *
 * A plugin can pick one of two strategies:
 *
 * 1. **Theme type** — read `init().theme` (`light` / `dark`) and keep its own
 *    palette in CSS, one block per mode. `watchThemeMode` follows the changes
 *    of the host and sets `data-novyse-theme` and `color-scheme` for you.
 * 2. **`themeColors`** (the default) — the host computes the palette from the
 *    theme mode, the selected palette and the surface treatment of the app and
 *    sends it as an array. `watchTheme` writes the array to the CSS custom
 *    properties below and follows the changes live.
 *
 * On Novyse `themeColors` is always present. The development host has no
 * palette to compute, so it sends [DEFAULT_THEME_COLORS] for the active mode:
 * a plugin that uses `themeColors` keeps working in `npm run dev` without the
 * app, and `?theme=light` switches the sample palette.
 *
 * The array is positional, not named, so it stays small on the wire. This is
 * the order:
 *
 * | # | Name | CSS custom property | Used for |
 * | :-- | :--- | :--- | :--- |
 * | 0 | `background` | `--nv-background` | page background |
 * | 1 | `surface` | `--nv-surface` | cards, panels, bars |
 * | 2 | `surfaceHover` | `--nv-surface-hover` | hover of a surface |
 * | 3 | `field` | `--nv-field` | inputs, code areas |
 * | 4 | `line` | `--nv-line` | borders and dividers |
 * | 5 | `outline` | `--nv-outline` | tracks, stronger outlines |
 * | 6 | `text` | `--nv-text` | primary text |
 * | 7 | `muted` | `--nv-muted` | secondary text and icons |
 * | 8 | `primary` | `--nv-primary` | the call to action |
 * | 9 | `onPrimary` | `--nv-on-primary` | text on `primary` |
 * | 10 | `primarySoft` | `--nv-primary-soft` | tinted primary (16% alpha) |
 * | 11 | `danger` | `--nv-danger` | errors and destructive actions |
 * | 12 | `success` | `--nv-success` | success and "go" states |
 * | 13 | `warning` | `--nv-warning` | warnings |
 * | 14 | `info` | `--nv-info` | neutral information |
 *
 * The corner radius travels with the palette but is not a color, so it is not
 * part of the array: `themeRadii` carries `sm` (controls), `md` (cards) and
 * `lg` (dialogs, sheets) in CSS pixels, and `watchTheme` writes them to
 * `--nv-radius-sm`, `--nv-radius-md` and `--nv-radius-lg`. A plugin that
 * hardcodes its corners looks bolted on next to the app.
 *
 * A theme-only plugin never reads `themeColors`; a `themeColors` plugin must
 * keep [DEFAULT_THEME_COLORS] as its fallback, because the array is missing in
 * plain `vite` (the dev host adds it, but the helpers are safe without it).
 */
import type { AppSDK, InitPayload } from './index';

export const THEME_COLOR_NAMES = [
  'background',
  'surface',
  'surfaceHover',
  'field',
  'line',
  'outline',
  'text',
  'muted',
  'primary',
  'onPrimary',
  'primarySoft',
  'danger',
  'success',
  'warning',
  'info',
] as const;

export type ThemeColorName = (typeof THEME_COLOR_NAMES)[number];

export type ThemeMode = 'light' | 'dark';

/** Positional palette, see [THEME_COLOR_NAMES] for the order. */
export type ThemeColors = readonly string[];

/** Corner radii of the host, in CSS pixels. */
export interface ThemeRadii {
  /** Controls, chips, small inputs. */
  sm: number;
  /** Cards, panels, surfaces. */
  md: number;
  /** Dialogs, sheets, large containers. */
  lg: number;
}

export type ThemeRadiusName = keyof ThemeRadii;

/** The palette of the host: the mode, the colors and the radii. */
export interface ThemeState {
  theme: ThemeMode;
  themeColors: ThemeColors;
  radii: ThemeRadii;
}

/** The CSS custom property written for every slot. */
export const THEME_COLOR_VARIABLES: Record<ThemeColorName, string> = {
  background: '--nv-background',
  surface: '--nv-surface',
  surfaceHover: '--nv-surface-hover',
  field: '--nv-field',
  line: '--nv-line',
  outline: '--nv-outline',
  text: '--nv-text',
  muted: '--nv-muted',
  primary: '--nv-primary',
  onPrimary: '--nv-on-primary',
  primarySoft: '--nv-primary-soft',
  danger: '--nv-danger',
  success: '--nv-success',
  warning: '--nv-warning',
  info: '--nv-info',
};

/** The CSS custom property written for every radius. */
export const THEME_RADIUS_VARIABLES: Record<ThemeRadiusName, string> = {
  sm: '--nv-radius-sm',
  md: '--nv-radius-md',
  lg: '--nv-radius-lg',
};

/**
 * Stock radii, in CSS pixels: the corners of the default Novyse theme.
 *
 * A round, a pill and a circle stay fixed in the plugin CSS: the host cannot
 * describe them with one number.
 */
export const DEFAULT_THEME_RADII: ThemeRadii = { sm: 8, md: 16, lg: 24 };

/**
 * Fallback palette, for development and for a host older than the plugin.
 *
 * These are the colors of the default Novyse palette with the `novyse` seed
 * (`#0F6FFF`), in the standard and non-AMOLED surface treatment. They are the
 * same values the client computes from `ColorScheme`, so a plugin developed
 * against them looks exactly like one running inside the app.
 */
export const DEFAULT_THEME_COLORS: Record<ThemeMode, ThemeColors> = {
  dark: [
    '#071427', // background
    '#0A182F', // surface
    '#102038', // surfaceHover
    '#12223B', // field
    '#1C2A40', // line
    '#1D3251', // outline
    '#EAF2FF', // text
    '#B8CFF2', // muted
    '#5A9CFF', // primary
    '#FFFFFF', // onPrimary
    'rgba(90, 156, 255, 0.16)', // primarySoft
    '#E45757', // danger
    '#1DBF73', // success
    '#FFC857', // warning
    '#2D9CDB', // info
  ],
  light: [
    '#F5F9FF', // background
    '#F1F6FF', // surface
    '#ECF3FF', // surfaceHover
    '#FCFDFF', // field
    '#E5EEFA', // line
    '#D9E7FB', // outline
    '#0E1826', // text
    '#53637B', // muted
    '#0F6FFF', // primary
    '#FFFFFF', // onPrimary
    'rgba(15, 111, 255, 0.10)', // primarySoft
    '#E45757', // danger
    '#1DBF73', // success
    '#FFC857', // warning
    '#2D9CDB', // info
  ],
};

/** True when `value` is a full palette sent by the host. */
export function isThemeColors(value: unknown): value is ThemeColors {
  return (
    Array.isArray(value) &&
    value.length === THEME_COLOR_NAMES.length &&
    value.every((color) => typeof color === 'string' && color.trim().length > 0)
  );
}

/** True when `value` is a radius set sent by the host. */
export function isThemeRadii(value: unknown): value is ThemeRadii {
  if (!value || typeof value !== 'object') return false;

  const radii = value as Record<string, unknown>;

  return (['sm', 'md', 'lg'] as const).every((name) => {
    const radius = radii[name];

    return (
      typeof radius === 'number' &&
      Number.isFinite(radius) &&
      radius >= 0 &&
      radius <= 64
    );
  });
}

/** `dark` unless the browser clearly prefers light. */
export function defaultThemeMode(): ThemeMode {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * The host palette, with the stock palette for the mode when the host did not
 * send one (development, or an app older than the plugin).
 */
export function themeFromPayload(
  payload?: Pick<InitPayload, 'theme' | 'themeColors' | 'themeRadii'> | null,
): ThemeState {
  const theme: ThemeMode =
    payload?.theme === 'light' ? 'light' : payload?.theme === 'dark' ? 'dark' : defaultThemeMode();
  const themeColors = isThemeColors(payload?.themeColors)
    ? payload.themeColors
    : DEFAULT_THEME_COLORS[theme];
  const radii = isThemeRadii(payload?.themeRadii) ? payload.themeRadii : DEFAULT_THEME_RADII;

  return { theme, themeColors, radii };
}

/** `themeFromPayload` for an `onTheme` event, whose fields are untyped. */
export function normalizeTheme(
  theme: unknown,
  themeColors: unknown,
  themeRadii?: unknown,
): ThemeState {
  return themeFromPayload({
    theme: theme === 'light' || theme === 'dark' ? theme : undefined,
    themeColors: isThemeColors(themeColors) ? themeColors : undefined,
    themeRadii: isThemeRadii(themeRadii) ? themeRadii : undefined,
  });
}

/**
 * Writes [theme] to the CSS custom properties of [root] and to `color-scheme`.
 *
 * The plugin CSS should use them with its own fallback, so the first frame is
 * painted before `init()` answers:
 *
 * ```css
 * .panel {
 *   background: var(--nv-surface, #0a182f);
 *   color: var(--nv-text, #eaf2ff);
 * }
 * ```
 */
export function applyThemeColors(
  theme: ThemeState,
  root: HTMLElement = document.documentElement,
): void {
  THEME_COLOR_NAMES.forEach((name, index) => {
    root.style.setProperty(THEME_COLOR_VARIABLES[name], theme.themeColors[index] ?? '');
  });

  applyThemeRadii(theme.radii, root);
  setThemeMode(theme.theme, root);
}

/**
 * Writes the radii of the host to `--nv-radius-sm|md|lg`, in pixels.
 *
 * A rounded rectangle stays a rounded rectangle: the plugin picks which of the
 * three matches its element, and keeps `50%`, a pill or a circle hardcoded.
 */
export function applyThemeRadii(
  radii: ThemeRadii,
  root: HTMLElement = document.documentElement,
): void {
  (Object.keys(THEME_RADIUS_VARIABLES) as ThemeRadiusName[]).forEach((name) => {
    root.style.setProperty(THEME_RADIUS_VARIABLES[name], `${Math.round(radii[name])}px`);
  });
}

/**
 * Sets only the mode, for a plugin that keeps its own palette per theme.
 *
 * `data-novyse-theme` is available in CSS as `[data-novyse-theme="light"]`, and
 * `color-scheme` makes the native form controls and scrollbars follow.
 */
export function setThemeMode(
  theme: ThemeMode,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.novyseTheme = theme;
  root.style.colorScheme = theme;
}

function onTheme(
  sdk: AppSDK,
  callback: (theme: ThemeState) => void,
): () => void {
  // A plugin can be newer than the app that runs it: the bridge only grows, so
  // a missing member must not throw on every load.
  const subscribe = (sdk as Partial<AppSDK>).onTheme;

  if (typeof subscribe !== 'function') return () => {};

  return subscribe.call(sdk, (payload) => {
    callback(normalizeTheme(payload?.theme, payload?.themeColors, payload?.radii));
  });
}

/**
 * Follows the host palette and writes it to the CSS custom properties.
 *
 * Use it once, in `main.tsx`, before rendering. `listener` receives the same
 * palette when the user changes theme, palette or surface treatment, so a
 * plugin with a canvas (Excalidraw, a chart) can redraw. The returned function
 * unsubscribes.
 */
export function watchTheme(
  sdk: AppSDK,
  listener?: (theme: ThemeState) => void,
  root?: HTMLElement,
): () => void {
  let stopped = false;

  const apply = (payload?: Pick<InitPayload, 'theme' | 'themeColors'> | null) => {
    if (stopped) return;

    const theme = themeFromPayload(payload);

    applyThemeColors(theme, root);
    listener?.(theme);
  };

  void sdk.init().then(apply).catch(() => {});
  const off = onTheme(sdk, (theme) => {
    if (stopped) return;

    applyThemeColors(theme, root);
    listener?.(theme);
  });

  return () => {
    stopped = true;
    off();
  };
}

/**
 * Follows only the theme mode, for a plugin that defines its palette in CSS.
 *
 * `data-novyse-theme` and `color-scheme` are set on [root] by [setThemeMode],
 * and `listener` can rebuild anything that cannot be expressed in CSS. The
 * returned function unsubscribes.
 */
export function watchThemeMode(
  sdk: AppSDK,
  listener?: (theme: ThemeMode) => void,
  root?: HTMLElement,
): () => void {
  let stopped = false;

  const apply = (theme: ThemeMode) => {
    if (stopped) return;

    setThemeMode(theme, root);
    listener?.(theme);
  };

  void sdk
    .init()
    .then((payload) => apply(themeFromPayload(payload).theme))
    .catch(() => {});

  const off = onTheme(sdk, (theme) => apply(theme.theme));

  return () => {
    stopped = true;
    off();
  };
}
