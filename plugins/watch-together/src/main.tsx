import { render } from 'preact';

import { installDevHost } from '@novyse/app-sdk/dev';

import { App } from './app';
import './style.css';

// Development only: `vite` serves the plugin standalone with a fake host that
// puts two tabs in the same room. A build drops this branch and the import.
if (import.meta.env.DEV) {
  installDevHost({ slug: 'watch-together', version: '0.2.9' });
}

render(<App />, document.getElementById('app')!);
