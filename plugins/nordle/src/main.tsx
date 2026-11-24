import { render } from 'preact';

import { getAppSDK, mountActivityControls, watchTheme } from '@novyse/app-sdk';
import { installDevHost } from '@novyse/app-sdk/dev';

import { App } from './app';
import './style.css';

// Local standalone fallback: if the host AppSDK is not injected (e.g. running in a browser
// directly or in development), the dev host stands in so the game is fully playable standalone.
if (import.meta.env.DEV || !('AppSDK' in window)) {
  installDevHost({ slug: 'nordle', version: '0.1.0' });
}

// Default color mode: the palette computed by the host, written to the
// `--nv-*` custom properties and kept in sync live. In development the dev
// host sends the stock palette; `?theme=light` previews the light one.
watchTheme(getAppSDK());

mountActivityControls(getAppSDK());

render(<App />, document.getElementById('app')!);

