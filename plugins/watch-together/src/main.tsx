import { render } from 'preact';

import { getAppSDK, mountActivityControls, watchTheme } from '@novyse/app-sdk';
import { installDevHost } from '@novyse/app-sdk/dev';

import { App } from './app';
import './style.css';

// Development only: `vite` serves the plugin standalone with a fake host that
// puts two tabs in the same room. A build drops this branch and the import.
if (import.meta.env.DEV) {
  installDevHost({ slug: 'watch-together', version: '0.2.10' });
}

// Default color mode: the palette computed by the host, written to the
// `--nv-*` custom properties and kept in sync live. In development the dev
// host sends the stock palette; `?theme=light` previews the light one.
watchTheme(getAppSDK());


// The surface of this plugin is a video: the chrome stays a small dot in the
// corner until it is asked for, and unfolds downwards.
mountActivityControls(getAppSDK(), { open: false, orientation: 'vertical' });

render(<App />, document.getElementById('app')!);
