import { render } from 'preact';

import { installDevHost } from '@novyse/app-sdk/dev';

import { App } from './app';
import './style.css';

// Local development only: `vite` serves the plugin standalone and the fake
// host answers as the app would. A build drops this branch and the import.
if (import.meta.env.DEV) {
  installDevHost({ slug: 'hello-activity', version: '0.1.0' });
}

render(<App />, document.getElementById('app')!);
