import { render } from 'preact';

import { getAppSDK, mountActivityControls, watchTheme } from '@novyse/app-sdk';
import { installDevHost } from '@novyse/app-sdk/dev';

import { App } from './app';
import './style.css';

// Local development only: `vite` serves the plugin standalone and the fake
// host answers as the app would. A build drops this branch and the import.
if (import.meta.env.DEV) {
  installDevHost({ slug: 'wheel', version: '0.1.1' });
}

// Default color mode: the palette computed by the host, written to the
// `--nv-*` custom properties and kept in sync live. In development the dev
// host sends the stock palette; `?theme=light` previews the light one.
watchTheme(getAppSDK());

// Close, pin, fullscreen and the context menu belong to the tile, not to a
// rail of the app: the SDK draws them over the 16:9 surface.
mountActivityControls(getAppSDK());

render(<App />, document.getElementById('app')!);
