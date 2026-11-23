/**
 * The chrome of an activity, drawn inside the plugin.
 *
 * The host no longer keeps a rail beside the tile: closing, pinning and going
 * fullscreen are buttons of the plugin, over the same 16:9 surface, and they
 * call the host through the SDK. [mountActivityControls] builds that bar once
 * and keeps it in step with the host, so every plugin gets the same buttons,
 * the same corners (`--nv-radius-md`) and the same behaviour.
 *
 * ```ts
 * // main.tsx, next to watchTheme
 * const sdk = getAppSDK();
 * mountActivityControls(sdk);
 * ```
 *
 * The bar is fixed to the top-right corner of the sandbox and hidden until the
 * host answers `init()`: a plugin never draws a pin state it does not know.
 *
 * It can be mounted open or closed and growing horizontally or vertically, so a
 * plugin whose surface is a video can keep a single small dot in the corner and
 * unfold the options only when asked.
 */
import type { ActivityControls, AppSDK } from './index';

export interface ActivityControlLabels {
  close: string;
  pin: string;
  unpin: string;
  fullscreen: string;
  restore: string;
  more: string;
  expand: string;
  collapse: string;
}

const LABELS: Record<'en' | 'it', ActivityControlLabels> = {
  en: {
    close: 'Close activity',
    pin: 'Pin',
    unpin: 'Unpin',
    fullscreen: 'Full screen',
    restore: 'Exit full screen',
    more: 'More options',
    expand: 'Show options',
    collapse: 'Hide options',
  },
  it: {
    close: 'Chiudi attività',
    pin: 'Fissa',
    unpin: 'Rilascia',
    fullscreen: 'Schermo intero',
    restore: 'Esci da schermo intero',
    more: 'Altre opzioni',
    expand: 'Mostra opzioni',
    collapse: 'Nascondi opzioni',
  },
};

/** The labels of a language tag, English for anything else. */
export function activityControlLabels(locale: string | null | undefined): ActivityControlLabels {
  const base = (locale ?? '').trim().toLowerCase().split(/[-_]/)[0];

  return base === 'it' ? LABELS.it : LABELS.en;
}

/** The part of the box the host menu opens under. */
export interface ControlAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActivityControlsOptions {
  /** Override some labels; the rest comes from the language of the host. */
  labels?: Partial<ActivityControlLabels>;

  /** Whether the options are shown from the start. Defaults to `true`. */
  open?: boolean;

  /**
   * Which way the bar grows from its corner. The toggle keeps the corner, so a
   * horizontal bar opens to the left and a vertical one opens downwards.
   * Defaults to `horizontal`.
   */
  orientation?: 'horizontal' | 'vertical';
}

const STYLE_ID = 'nv-controls-style';

const STYLES = `
.nv-controls {
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 2147483000;
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--nv-line, #1c2a40);
  border-radius: var(--nv-radius-md, 16px);
  background: color-mix(in srgb, var(--nv-surface, #0a182f) 82%, transparent);
  backdrop-filter: blur(8px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
}
.nv-controls[hidden] { display: none; }
/* The toggle holds the corner: the options grow away from it, left or down. */
.nv-controls__group { display: flex; gap: 4px; }
.nv-controls--vertical { flex-direction: column; align-items: flex-end; }
.nv-controls--vertical .nv-controls__group { flex-direction: column; }
.nv-controls--vertical .nv-controls__toggle { order: -1; }
.nv-controls--collapsed .nv-controls__group { display: none; }
.nv-controls__toggle { color: var(--nv-muted, #b8cff2); }
.nv-control {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--nv-radius-md, 16px);
  background: transparent;
  color: var(--nv-muted, #b8cff2);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.nv-control:hover { background: var(--nv-surface-hover, #102038); color: var(--nv-text, #eaf2ff); }
.nv-control:active { transform: scale(0.94); }
.nv-control:focus-visible { outline: 2px solid var(--nv-primary, #5a9cff); outline-offset: 1px; }
.nv-control--active { color: var(--nv-primary, #5a9cff); }
.nv-control--danger:hover { color: var(--nv-danger, #e45757); background: color-mix(in srgb, var(--nv-danger, #e45757) 16%, transparent); }
.nv-control svg { width: 16px; height: 16px; display: block; }
@media (max-width: 320px) {
  .nv-controls { top: 4px; right: 4px; gap: 2px; padding: 2px; }
  .nv-control { width: 26px; height: 26px; }
  .nv-control svg { width: 14px; height: 14px; }
}
`;

const ICONS = {
  close:
    '<path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  pin: '<path d="M9 3h6l-1 6 3 3v1H7v-1l3-3-1-6Zm3 10v8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>',
  pinOff:
    '<path d="M9 3h6l-1 6 3 3v1H7v-1l3-3-1-6Zm3 10v8M4 4l16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>',
  expand:
    '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  shrink:
    '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  more: '<path d="M12 6.5v.01M12 12v.01M12 17.5v.01" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronRight:
    '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronDown:
    '<path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronUp:
    '<path d="M5 15l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};

function svg(paths: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function iconButton(className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `nv-control ${className}`;
  return button;
}

/**
 * Mounts the controls of the activity into [host] and follows the host state.
 *
 * Returns the teardown: call it when the plugin unmounts (a Preact `useEffect`
 * cleanup), so a second mount does not draw two bars.
 */
export function mountActivityControls(
  sdk: AppSDK,
  options: ActivityControlsOptions = {},
  host: HTMLElement = document.body,
): () => void {
  ensureStyles();

  const vertical = options.orientation === 'vertical';
  let open = options.open ?? true;

  const bar = document.createElement('div');
  bar.className = 'nv-controls';
  bar.hidden = true;
  bar.setAttribute('role', 'group');
  bar.classList.toggle('nv-controls--vertical', vertical);
  bar.classList.toggle('nv-controls--collapsed', !open);

  const close = iconButton('nv-control--danger');
  const pin = iconButton('');
  const fullscreen = iconButton('');
  const more = iconButton('');

  // The options live in their own box: the toggle keeps the corner alone when
  // the chrome is closed, so the video shows a single small dot.
  const group = document.createElement('div');
  group.className = 'nv-controls__group';
  group.append(close, pin, fullscreen, more);

  const toggle = iconButton('nv-controls__toggle');
  toggle.setAttribute('aria-expanded', String(open));

  bar.append(group, toggle);
  host.appendChild(bar);

  let labels: ActivityControlLabels = LABELS.en;
  let controls: ActivityControls = { pinned: false, fullscreen: false, closable: false };

  // `init()` can answer after the first `activity:controls` of the tile (the
  // event is queued before the plugin calls the host): the live state wins,
  // the default of `init` must not overwrite it.
  let fromEvent = false;

  const render = () => {
    close.hidden = !controls.closable;
    close.innerHTML = svg(ICONS.close);
    close.title = labels.close;
    close.setAttribute('aria-label', labels.close);

    pin.innerHTML = svg(controls.pinned ? ICONS.pinOff : ICONS.pin);
    pin.title = controls.pinned ? labels.unpin : labels.pin;
    pin.setAttribute('aria-label', pin.title);
    pin.classList.toggle('nv-control--active', controls.pinned);

    fullscreen.innerHTML = svg(controls.fullscreen ? ICONS.shrink : ICONS.expand);
    fullscreen.title = controls.fullscreen ? labels.restore : labels.fullscreen;
    fullscreen.setAttribute('aria-label', fullscreen.title);

    more.innerHTML = svg(ICONS.more);
    more.title = labels.more;
    more.setAttribute('aria-label', labels.more);

    // The arrow points where the options are: left or down when closed, back to
    // the corner right or up when open.
    toggle.innerHTML = svg(
      open
        ? vertical
          ? ICONS.chevronUp
          : ICONS.chevronRight
        : vertical
          ? ICONS.chevronDown
          : ICONS.chevronLeft,
    );
    toggle.title = open ? labels.collapse : labels.expand;
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-expanded', String(open));
  };

  const apply = (next: ActivityControls, fromHost = false) => {
    if (fromHost) fromEvent = true;

    controls = {
      pinned: Boolean(next?.pinned),
      fullscreen: Boolean(next?.fullscreen),
      closable: Boolean(next?.closable),
    };
    bar.hidden = false;
    render();
  };

  toggle.addEventListener('click', () => {
    open = !open;
    bar.classList.toggle('nv-controls--collapsed', !open);
    render();
  });

  close.addEventListener('click', () => sdk.ui.close());
  pin.addEventListener('click', () => (controls.pinned ? sdk.ui.unpin() : sdk.ui.pin()));
  fullscreen.addEventListener('click', () =>
    controls.fullscreen ? sdk.ui.exitFullscreen() : sdk.ui.requestFullscreen(),
  );
  more.addEventListener('click', () => {
    const rect = more.getBoundingClientRect();

    sdk.ui.openMenu({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  });

  const offControls =
    typeof sdk.ui.onControls === 'function'
      ? sdk.ui.onControls((next) => apply(next, true))
      : () => {};

  void sdk
    .init()
    .then((payload) => {
      labels = { ...activityControlLabels(payload.locale), ...options.labels };

      if (fromEvent) {
        render();
        return;
      }

      apply(
        payload.controls ?? {
          pinned: false,
          fullscreen: false,
          closable: !payload.readOnly,
        },
      );
    })
    .catch(() => {});

  return () => {
    offControls();
    bar.remove();
  };
}
