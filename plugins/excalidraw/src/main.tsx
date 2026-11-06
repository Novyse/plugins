import './assets';

import { createRoot } from 'react-dom/client';

import { installDevHost } from '@novyse/app-sdk/dev';

import '@excalidraw/excalidraw/index.css';
import './style.css';

import { App } from './app';
import { messagesFor, normalizeLocale } from './i18n';

// Development only: `vite` serves the board standalone with a fake host, so two
// tabs are two participants and a third tab is the late joiner. A build drops
// this branch, and the real `window.AppSDK` of the app is used instead.
if (import.meta.env.DEV) {
  installDevHost({ slug: 'excalidraw', version: '0.1.0' });

  // `?readonly=1` exercises the passive view without the app, which is the only
  // way to check it locally.
  if (new URLSearchParams(window.location.search).has('readonly') && window.AppSDK) {
    const sdk = window.AppSDK;
    const init = sdk.init.bind(sdk);

    sdk.init = async () => ({ ...(await init()), readOnly: true });
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

// No host means no room, and therefore no board: say so instead of throwing the
// SDK error into an empty page.
function NoHost() {
  const t = messagesFor(normalizeLocale(navigator.language));

  return (
    <main className="board board--loading">
      <p>{t.noHost}</p>
    </main>
  );
}

createRoot(root).render(window.AppSDK ? <App /> : <NoHost />);
