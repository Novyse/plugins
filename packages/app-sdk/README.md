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
`state`, `action`, `stream`, `users`, `ui` and `storage` all work; the caps and
the server authority do not, since there is no server.

The host is imported only in development: `import.meta.env.DEV` is `false` in a
build, so the branch and the import are dropped.
