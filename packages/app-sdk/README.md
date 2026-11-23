# @novyse/app-sdk

Types of the `window.AppSDK` contract, plus a development host that stands in
for the app while you build a plugin.

```ts
import { getAppSDK, type InitPayload, type StateEvent } from '@novyse/app-sdk';

const sdk = getAppSDK();
const init: InitPayload = await sdk.init();

// Late joiner: the whole history is here, oldest first.
for (const event of init.state.events) apply(event);
```

## Development host

```ts
import { installDevHost } from '@novyse/app-sdk/dev';

if (import.meta.env.DEV) installDevHost({ slug: 'hello-activity' });
```

Call it before the first `getAppSDK()`, then open the plugin in two tabs: each
tab is a participant, and a tab opened later receives the history from the
others through a `hello` / `sync` handshake, which is the late joiner path.

`init().locale` is the language of the host (`it-IT`, `en-GB`, ...). The dev
host takes it from `?lang=`, then from `navigator.language`; `plugin.json`
lists the languages the plugin ships (`locales`), and `en` is the fallback.
`state`, `action`, `stream`, `users`, `ui` and `storage` all work; the caps and
the server authority do not, since there is no server.

## Colors

Two standard modes, both driven by the host.

### `themeColors` (default)

`init().themeColors` is the palette the app is drawing with, computed from the
theme mode, the selected palette and the surface treatment. It is positional:

| # | Name | CSS variable |
| :-- | :--- | :--- |
| 0 | `background` | `--nv-background` |
| 1 | `surface` | `--nv-surface` |
| 2 | `surfaceHover` | `--nv-surface-hover` |
| 3 | `field` | `--nv-field` |
| 4 | `line` | `--nv-line` |
| 5 | `outline` | `--nv-outline` |
| 6 | `text` | `--nv-text` |
| 7 | `muted` | `--nv-muted` |
| 8 | `primary` | `--nv-primary` |
| 9 | `onPrimary` | `--nv-on-primary` |
| 10 | `primarySoft` | `--nv-primary-soft` |
| 11 | `danger` | `--nv-danger` |
| 12 | `success` | `--nv-success` |
| 13 | `warning` | `--nv-warning` |
| 14 | `info` | `--nv-info` |

The corner radius travels with the palette but is not a color: `themeRadii`
carries `sm`, `md` and `lg` in CSS pixels, written to `--nv-radius-sm`,
`--nv-radius-md` and `--nv-radius-lg` by `watchTheme`:

```css
.card {
  border-radius: var(--nv-radius-md, 16px);
}
```

```ts
import { getAppSDK, watchTheme } from '@novyse/app-sdk';

watchTheme(getAppSDK());
```

```css
.panel {
  background: var(--nv-surface, #0a182f);
  color: var(--nv-text, #eaf2ff);
}
```

`watchTheme` applies the palette and subscribes to `sdk.onTheme`, so a theme,
palette or surface change reaches the plugin live. `DEFAULT_THEME_COLORS` is
the fallback for development and for an app older than the plugin; a plugin
does not need a special case.

### Theme type

A plugin that keeps its own palettes reads `init().theme` only:

```ts
import { getAppSDK, watchThemeMode } from '@novyse/app-sdk';

watchThemeMode(getAppSDK());
```

```css
[data-novyse-theme="light"] {
  --bg: #f5f9ff;
}
```

`watchThemeMode` sets `data-novyse-theme` and `color-scheme` on the document
and follows the changes live. Use `sdk.onTheme` directly only for a canvas or
another surface that CSS cannot color.

## Development theme

The dev host sends the stock palette of the active mode, so the default mode
works in `npm run dev` without the app. `?theme=light` previews the light mode
and `?colors=%23f5f9ff,%23f1f6ff,...` overrides the slots, in the order above.
The `installDevHost` options `theme`, `themeColors` and `themeRadii` do the same
from code:

```ts
installDevHost({ slug: 'hello-activity', theme: 'light' });
```

When the system theme changes while the page is open, the dev host emits an
`onTheme` event exactly like the app, so the live path is testable locally.

`player` is the exception: a browser tab has no media_kit, so `player.open`
rejects with `E_UNSUPPORTED`. A file link has to be tested inside the app.

The host is imported only in development: `import.meta.env.DEV` is `false` in a
build, so the branch and the import are dropped.
