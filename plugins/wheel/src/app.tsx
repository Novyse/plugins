import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import {
  getAppSDK,
  type InitPayload,
  type StateEvent,
  type ThemeMode,
} from '@novyse/app-sdk';

import { messagesFor, normalizeLocale, type Locale } from './i18n';
import {
  DEFAULT_OPTIONS,
  MAX_HISTORY,
  MAX_LABEL,
  MAX_OPTIONS,
  SPIN_MS,
  WHEEL,
  colorAt,
  createId,
  latestWheel,
  pickIndex,
  textColorFor,
  turnCount,
  wheelFromEvent,
  type WheelAnchor,
  type WheelOption,
  type WheelSnapshot,
  type WinnerMode,
} from './wheel';

const CENTER = 100;
const RADIUS = 92;
/** Above this many slices the labels would be unreadable, so the wheel keeps
 * the colours and the options list remains the reference. */
const MAX_LABELS = 48;

type Panel = 'options' | 'results';
type TransferMode = 'export' | 'import';

function segmentPath(index: number, total: number): string {
  const angle = 360 / total;
  const start = ((index * angle - 90) * Math.PI) / 180;
  const end = (((index + 1) * angle - 90) * Math.PI) / 180;
  const x0 = CENTER + RADIUS * Math.cos(start);
  const y0 = CENTER + RADIUS * Math.sin(start);
  const x1 = CENTER + RADIUS * Math.cos(end);
  const y1 = CENTER + RADIUS * Math.sin(end);
  const large = angle > 180 ? 1 : 0;

  return `M ${CENTER} ${CENTER} L ${x0} ${y0} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${x1} ${y1} Z`;
}

export function App() {
  const sdk = getAppSDK();

  const [init, setInit] = useState<InitPayload | null>(null);
  const [anchor, setAnchor] = useState<WheelAnchor | null>(null);
  const [locale, setLocale] = useState<Locale>(() => normalizeLocale(navigator.language));
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [readOnly, setReadOnly] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [spinning, setSpinning] = useState(false);
  const [resultVisible, setResultVisible] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [panel, setPanel] = useState<Panel>('options');
  const [panelOpen, setPanelOpen] = useState(true);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferMode, setTransferMode] = useState<TransferMode>('export');
  const [transferText, setTransferText] = useState('');
  const [transferError, setTransferError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const anchorRef = useRef<WheelAnchor | null>(null);
  const offsetRef = useRef(0);
  const lastSeqRef = useRef(0);
  const readyRef = useRef(false);
  const queuedRef = useRef<StateEvent[]>([]);
  const readOnlyRef = useRef(false);
  const selfRef = useRef('');
  const appliedRef = useRef<string | null>(null);
  const rotorRef = useRef<SVGGElement | null>(null);
  const rotationRef = useRef(0);
  const rafRef = useRef(0);
  const transferRef = useRef<HTMLTextAreaElement | null>(null);

  const t = messagesFor(locale);
  const options = anchor?.options ?? DEFAULT_OPTIONS;
  const wheelOptions = options.filter((option) => !option.hidden);
  const hiddenCount = options.length - wheelOptions.length;
  const spin = anchor?.spin ?? null;
  const winnerMode = anchor?.winnerMode ?? 'keep';
  const history = anchor?.history ?? [];
  const locked = readOnly || ended !== null;
  const busy = spinning || locked;
  const canSpin = wheelOptions.length >= 2 && !spinning && !locked;
  const winner = resultVisible && spin ? spin.label : null;
  const labelsVisible = wheelOptions.length <= MAX_LABELS;
  const hint =
    options.length === 0
      ? t.empty
      : wheelOptions.length < 2
        ? t.needVisible
        : options.length >= MAX_OPTIONS
          ? t.maxReached(MAX_OPTIONS)
          : hiddenCount > 0
            ? t.hiddenCount(hiddenCount)
            : null;

  const snapshot = (): WheelSnapshot => {
    const current = anchorRef.current;

    return {
      options: current?.options ?? DEFAULT_OPTIONS,
      spin: current?.spin ?? null,
      winnerMode: current?.winnerMode ?? 'keep',
      history: current?.history ?? [],
    };
  };

  const adopt = useCallback((next: WheelAnchor | null) => {
    anchorRef.current = next;
    setAnchor(next);
  }, []);

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  const handle = useCallback(
    (event: StateEvent) => {
      if (!readyRef.current) {
        queuedRef.current.push(event);
        return;
      }

      if (event.seq <= lastSeqRef.current) return;

      const next = wheelFromEvent(event);
      if (!next) return;

      lastSeqRef.current = event.seq;
      adopt(next);
    },
    [adopt],
  );

  const publish = useCallback(
    async (next: WheelSnapshot) => {
      if (readOnlyRef.current) return;

      setError(null);
      adopt({ ...next, seq: lastSeqRef.current, ts: serverNow() });

      try {
        const ack = await sdk.state.send(WHEEL, next);

        if (ack.seq > lastSeqRef.current) {
          lastSeqRef.current = ack.seq;
          adopt({ ...next, seq: ack.seq, ts: ack.ts });
        }
      } catch (cause) {
        setError(describe(cause));
      }
    },
    [adopt, serverNow, sdk],
  );

  useEffect(() => {
    let alive = true;

    const offState = sdk.state.on(WHEEL, handle);
    const offEnded = sdk.onEnded((reason) => setEnded(reason));
    const offTheme =
      sdk.onTheme?.((next) => setTheme(next.theme === 'light' ? 'light' : 'dark')) ?? (() => {});

    sdk
      .init()
      .then((payload) => {
        if (!alive) return;

        offsetRef.current = payload.serverNow - Date.now();
        lastSeqRef.current = payload.state.seq;
        readOnlyRef.current = payload.readOnly;
        selfRef.current = payload.self;

        setInit(payload);
        setLocale(normalizeLocale(payload.locale));
        setTheme(payload.theme === 'light' ? 'light' : 'dark');
        setReadOnly(payload.readOnly);
        adopt(latestWheel(payload.state.events));

        readyRef.current = true;

        const queued = queuedRef.current;
        queuedRef.current = [];
        for (const event of queued) handle(event);
      })
      .catch((cause: unknown) => {
        if (alive) setError(describe(cause));
      });

    return () => {
      alive = false;
      offState();
      offEnded();
      offTheme();
    };
  }, [adopt, handle, sdk]);

  // The rotor is driven imperatively: a 60 fps state update would re-render
  // every slice on every frame. The winner highlight is the only render that
  // follows the animation. `wheelOptions.length` is deliberately not a
  // dependency: when the winner is hidden or removed after the result, the
  // options change but this spin must not start again.
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);

    const rotor = rotorRef.current;
    if (!rotor) return;

    const place = (angle: number) => {
      rotationRef.current = angle;
      rotor.setAttribute('transform', `rotate(${angle} ${CENTER} ${CENTER})`);
    };

    if (!spin) {
      place(0);
      setSpinning(false);
      setResultVisible(false);
      return;
    }

    setSpinning(true);
    setResultVisible(false);

    const total = Math.max(1, wheelOptions.length);
    const segment = 360 / total;
    const target = -(spin.index * segment + segment / 2);
    const from = rotationRef.current;
    const delta = ((target - from) % 360 + 360) % 360;
    const final = from + turnCount(spin.id) * 360 + delta;
    const elapsed = Math.max(0, Date.now() + offsetRef.current - spin.at);
    const left = Math.max(0, SPIN_MS - elapsed);

    if (left <= 0) {
      place(final);
      setSpinning(false);
      setResultVisible(true);
      return;
    }

    const started = performance.now();

    const animate = (time: number) => {
      const progress = Math.min(1, (time - started) / left);
      const eased = 1 - Math.pow(1 - progress, 3);

      place(from + (final - from) * eased);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        setSpinning(false);
        setResultVisible(true);
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(rafRef.current);
  }, [spin?.id, spin?.index]);

  // Only the client that started the spin applies the winner rule. Every
  // client sees the same new options through STATE; the result card keeps the
  // winner label, so hiding or removing it does not erase the result.
  useEffect(() => {
    if (!resultVisible || !spin || spin.by !== selfRef.current) return;
    if (appliedRef.current === spin.id) return;

    appliedRef.current = spin.id;

    const current = anchorRef.current;
    if (!current || current.winnerMode === 'keep') return;

    const winning = current.options.find((option) => option.id === spin.optionId);
    if (!winning) return;

    const next =
      current.winnerMode === 'remove'
        ? current.options.filter((option) => option.id !== winning.id)
        : current.options.map((option) =>
            option.id === winning.id ? { ...option, hidden: true } : option,
          );
    const changed =
      current.winnerMode === 'remove'
        ? next.length !== current.options.length
        : next.some(
            (option, index) => option.hidden !== current.options[index]?.hidden,
          );

    if (!changed) return;

    void publish({
      options: next,
      spin,
      winnerMode: current.winnerMode,
      history: current.history,
    });
  }, [resultVisible, spin, publish]);

  useEffect(() => {
    if (!transferOpen) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTransferOpen(false);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [transferOpen]);

  const applyOptions = (next: WheelOption[]) => {
    setResultVisible(false);
    void publish({ ...snapshot(), options: next, spin: null });
  };

  const clearOptions = () => {
    if (busy) return;

    setConfirmClear(false);
    applyOptions([]);
  };

  const addOption = () => {
    const label = draft.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);

    if (!label || busy) return;

    const current = snapshot();
    if (current.options.length >= MAX_OPTIONS) return;

    setConfirmClear(false);
    setDraft('');
    applyOptions([...current.options, { id: createId(), label }]);
  };

  const removeOption = (id: string) => {
    if (busy) return;

    applyOptions(snapshot().options.filter((option) => option.id !== id));
  };

  const toggleHidden = (id: string) => {
    if (busy) return;

    applyOptions(
      snapshot().options.map((option) =>
        option.id === id ? { ...option, hidden: !option.hidden } : option,
      ),
    );
  };

  const shuffle = () => {
    if (busy) return;

    const current = snapshot();
    if (current.options.length < 2) return;

    const next = [...current.options];
    for (let index = next.length - 1; index > 0; index -= 1) {
      const other = Math.floor(Math.random() * (index + 1));
      [next[index], next[other]] = [next[other], next[index]];
    }

    applyOptions(next);
  };

  const sortOptions = () => {
    if (busy) return;

    const current = snapshot();
    if (current.options.length < 2) return;

    applyOptions(
      [...current.options].sort((a, b) =>
        a.label.localeCompare(b.label, locale, { sensitivity: 'base', numeric: true }),
      ),
    );
  };

  const chooseWinnerMode = (mode: WinnerMode) => {
    if (busy) return;

    const current = snapshot();
    if (current.winnerMode === mode) return;

    void publish({ ...current, winnerMode: mode });
  };

  const clearHistory = () => {
    if (locked || history.length === 0) return;

    void publish({ ...snapshot(), history: [] });
  };

  const spinWheel = () => {
    if (!canSpin) return;

    const current = snapshot();
    const visible = current.options.filter((option) => !option.hidden);
    if (visible.length < 2) return;

    const index = pickIndex(visible.length);
    const winning = visible[index];
    const id = createId();
    const at = serverNow();
    const nextSpin = {
      id,
      index,
      optionId: winning.id,
      label: winning.label,
      at,
      by: selfRef.current,
    };
    const nextHistory = [{ id, label: winning.label, at }, ...current.history].slice(
      0,
      MAX_HISTORY,
    );

    setSpinning(true);
    setResultVisible(false);
    void publish({ ...current, spin: nextSpin, history: nextHistory });
  };

  const openTransfer = () => {
    if (locked) return;

    setTransferMode('export');
    setTransferText(JSON.stringify(snapshot().options.map((option) => option.label), null, 2));
    setTransferError(null);
    setCopied(false);
    setTransferOpen(true);
  };

  const showTransfer = (mode: TransferMode) => {
    setTransferMode(mode);
    setTransferError(null);
    setCopied(false);
    setTransferText(
      mode === 'export'
        ? JSON.stringify(snapshot().options.map((option) => option.label), null, 2)
        : '',
    );
  };

  const closeTransfer = () => {
    setTransferOpen(false);
    setTransferError(null);
    setCopied(false);
  };

  const copyTransfer = async () => {
    try {
      await navigator.clipboard.writeText(transferText);
      setCopied(true);
      return;
    } catch {
      const area = transferRef.current;
      if (!area) {
        setTransferError(t.copyFailed);
        return;
      }

      area.focus();
      area.select();

      try {
        if (document.execCommand('copy')) {
          setCopied(true);
          return;
        }
      } catch {
        // Fall through to the message.
      }

      setTransferError(t.copyFailed);
    }
  };

  const importTransfer = () => {
    if (busy || locked) return;

    let payload: unknown;
    try {
      payload = JSON.parse(transferText);
    } catch {
      setTransferError(t.importInvalid);
      return;
    }

    if (!Array.isArray(payload)) {
      setTransferError(t.importInvalid);
      return;
    }

    if (payload.length > MAX_OPTIONS) {
      setTransferError(t.importTooMany(MAX_OPTIONS));
      return;
    }

    const labels: string[] = [];

    for (const item of payload) {
      if (typeof item !== 'string') {
        setTransferError(t.importStrings);
        return;
      }

      const label = item.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
      if (label) labels.push(label);
    }

    if (labels.length === 0) {
      setTransferError(t.importEmpty);
      return;
    }

    applyOptions(labels.map((label) => ({ id: createId(), label })));
    closeTransfer();
  };

  const requestFullscreen = () => {
    try {
      sdk.ui.requestFullscreen();
    } catch {
      // The host may refuse: the wheel keeps working in the tile.
    }
  };

  const formatClock = (at: number): string => {
    if (!at) return '';

    return new Date(at - offsetRef.current).toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (!init) {
    return (
      <main class="wheel-app wheel-app--dark">
        <p class="wheel-app__loading">{error ? `${t.error}: ${error}` : t.loading}</p>
      </main>
    );
  }

  return (
    <main class={`wheel-app wheel-app--${theme}`}>
      <header class="wheel-app__header">
        <div>
          <h1 class="wheel-app__title">{t.title}</h1>
          <p class="wheel-app__subtitle">{t.tagline}</p>
        </div>

        <div class="wheel-app__actions">
          {!panelOpen ? (
            <button
              type="button"
              class="icon-button"
              title={t.openPanel}
              aria-label={t.openPanel}
              onClick={() => setPanelOpen(true)}
            >
              <PanelIcon />
            </button>
          ) : null}

          <button
            type="button"
            class="icon-button"
            title={t.fullscreen}
            aria-label={t.fullscreen}
            onClick={requestFullscreen}
          >
            <ExpandIcon />
          </button>
        </div>
      </header>

      <div
        class={`wheel-app__body${
          panelOpen ? '' : ' wheel-app__body--collapsed'
        }`}
      >
        <section class="wheel-stage">
          <div class="wheel">
            <svg
              class="wheel__svg"
              viewBox="0 0 200 200"
              role="img"
              aria-label={t.wheelLabel}
            >
              <g ref={rotorRef}>
                {wheelOptions.length === 0 ? (
                  <circle class="wheel__blank" cx={CENTER} cy={CENTER} r={RADIUS} />
                ) : wheelOptions.length === 1 ? (
                  <circle
                    class="wheel__segment"
                    cx={CENTER}
                    cy={CENTER}
                    r={RADIUS}
                    fill={colorAt(0)}
                  />
                ) : (
                  wheelOptions.map((option, index) => (
                    <path
                      key={option.id}
                      class={`wheel__segment ${
                        resultVisible && spin?.optionId === option.id
                          ? 'wheel__segment--winner'
                          : ''
                      }`}
                      d={segmentPath(index, wheelOptions.length)}
                      fill={colorAt(index)}
                    />
                  ))
                )}

                {labelsVisible ? wheelOptions.map((option, index) => {
                  const angle = 360 / Math.max(1, wheelOptions.length);
                  const center = index * angle + angle / 2 - 90;
                  const limit =
                    wheelOptions.length <= 6 ? 13 : wheelOptions.length <= 10 ? 12 : 10;
                  const label =
                    option.label.length > limit
                      ? `${option.label.slice(0, limit - 1)}…`
                      : option.label;
                  const fontSize =
                    wheelOptions.length <= 6
                      ? 12
                      : wheelOptions.length <= 10
                        ? 10.5
                        : wheelOptions.length <= 16
                          ? 9
                          : 8;

                  return (
                    <g
                      key={`label-${option.id}`}
                      transform={`rotate(${center} ${CENTER} ${CENTER})`}
                    >
                      <text
                        x={180}
                        y={CENTER}
                        text-anchor="end"
                        dominant-baseline="middle"
                        fill={textColorFor(colorAt(index))}
                        style={{
                          pointerEvents: 'none',
                          fontSize: `${fontSize}px`,
                          fontWeight: 700,
                        }}
                      >
                        {label}
                      </text>
                    </g>
                  );
                }) : null}
              </g>

              <path class="wheel__pointer" d="M100 19 L91 3 L109 3 Z" />
              <circle class="wheel__hub" cx={CENTER} cy={CENTER} r={24} />
            </svg>

            <button
              type="button"
              class="wheel__spin"
              onClick={spinWheel}
              disabled={!canSpin}
            >
              {spinning ? t.spinning : t.spin}
            </button>

            {winner ? (
              <div class="wheel-result">
                <div
                  class="wheel-result__card"
                  role="dialog"
                  aria-modal="true"
                  aria-label={t.winner}
                >
                  <span class="wheel-result__emoji" aria-hidden="true">
                    🎉
                  </span>
                  <p class="wheel-result__eyebrow">{t.winner}</p>
                  <p class="wheel-result__label">{winner}</p>

                  <div class="wheel-result__actions">
                    <button
                      type="button"
                      class="button button--primary"
                      onClick={spinWheel}
                      disabled={!canSpin}
                    >
                      {t.again}
                    </button>

                    <button
                      type="button"
                      class="button"
                      onClick={() => setResultVisible(false)}
                    >
                      {t.close}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {panelOpen ? (
          <aside class="options">
            <div class="options__head">
              <div class="options__tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel === 'options'}
                  class={`options__tab${panel === 'options' ? ' is-active' : ''}`}
                  onClick={() => {
                    setPanel('options');
                    setConfirmClear(false);
                  }}
                >
                  {t.options}
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={panel === 'results'}
                  class={`options__tab${panel === 'results' ? ' is-active' : ''}`}
                  onClick={() => {
                    setPanel('results');
                    setConfirmClear(false);
                  }}
                >
                  {t.results}
                  <span class="options__tab-count">{history.length}</span>
                </button>
              </div>

              <button
                type="button"
                class="options__collapse options__tool"
                onClick={() => setPanelOpen(false)}
                title={t.collapsePanel}
                aria-label={t.collapsePanel}
              >
                <ChevronRightIcon />
              </button>
            </div>

            {panel === 'options' ? (
              <>
                <div class="options__toolbar">
                  <span class="options__count">
                    {options.length}/{MAX_OPTIONS}
                  </span>

                  <button
                    type="button"
                    class="options__sort options__tool"
                    onClick={sortOptions}
                    disabled={busy || options.length < 2}
                    title={t.sort}
                    aria-label={t.sort}
                  >
                    <SortIcon />
                  </button>

                  <button
                    type="button"
                    class="options__shuffle options__tool"
                    onClick={shuffle}
                    disabled={busy || options.length < 2}
                    title={t.shuffle}
                    aria-label={t.shuffle}
                  >
                    <ShuffleIcon />
                  </button>

                  <button
                    type="button"
                    class="options__transfer options__tool"
                    onClick={openTransfer}
                    disabled={locked}
                    title={t.transfer}
                    aria-label={t.transfer}
                  >
                    <TransferIcon />
                  </button>

                  <button
                    type="button"
                    class="options__clear options__tool options__tool--danger"
                    onClick={() => setConfirmClear(true)}
                    disabled={busy || options.length === 0}
                    title={t.clear}
                    aria-label={t.clear}
                  >
                    <TrashIcon />
                  </button>
                </div>

                {confirmClear && options.length > 0 ? (
                  <div
                    class="options__confirm"
                    role="alertdialog"
                    aria-label={t.clearConfirm}
                  >
                    <span class="options__confirm-text">{t.clearConfirm}</span>
                    <div class="options__confirm-actions">
                      <button
                        type="button"
                        class="button button--danger"
                        onClick={clearOptions}
                        disabled={busy}
                      >
                        {t.clear}
                      </button>

                      <button
                        type="button"
                        class="button"
                        onClick={() => setConfirmClear(false)}
                      >
                        {t.cancel}
                      </button>
                    </div>
                  </div>
                ) : null}

                <div class="options__form">
                  <input
                    class="options__input"
                    type="text"
                    value={draft}
                    maxLength={MAX_LABEL}
                    placeholder={t.addPlaceholder}
                    disabled={busy || options.length >= MAX_OPTIONS}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') addOption();
                    }}
                  />

                  <button
                    type="button"
                    class="options__add"
                    onClick={addOption}
                    disabled={busy || !draft.trim() || options.length >= MAX_OPTIONS}
                    title={t.add}
                    aria-label={t.add}
                  >
                    <PlusIcon />
                  </button>
                </div>

                <label class="options__mode">
                  <span>{t.onWin}</span>
                  <select
                    value={winnerMode}
                    disabled={busy}
                    onChange={(event) =>
                      chooseWinnerMode(event.currentTarget.value as WinnerMode)
                    }
                  >
                    <option value="keep">{t.winnerKeep}</option>
                    <option value="hide">{t.winnerHide}</option>
                    <option value="remove">{t.winnerRemove}</option>
                  </select>
                </label>

                <div class="options__list">
                  {options.length === 0 ? (
                    <p class="options__empty">{t.empty}</p>
                  ) : (
                    options.map((option) => {
                      const visibleIndex = wheelOptions.findIndex(
                        (item) => item.id === option.id,
                      );
                      const dotColor =
                        visibleIndex >= 0 ? colorAt(visibleIndex) : 'var(--line)';

                      return (
                        <div
                          class={`option${option.hidden ? ' option--hidden' : ''}`}
                          key={option.id}
                        >
                          <span
                            class="option__dot"
                            style={{ background: dotColor }}
                            aria-hidden="true"
                          />
                          <span class="option__label" title={option.label}>
                            {option.label}
                          </span>
                          <button
                            type="button"
                            class="option__hide"
                            onClick={() => toggleHidden(option.id)}
                            disabled={busy}
                            title={
                              option.hidden
                                ? t.show(option.label)
                                : t.hide(option.label)
                            }
                            aria-label={
                              option.hidden
                                ? t.show(option.label)
                                : t.hide(option.label)
                            }
                            aria-pressed={Boolean(option.hidden)}
                          >
                            <EyeIcon off={Boolean(option.hidden)} />
                          </button>
                          <button
                            type="button"
                            class="option__remove"
                            onClick={() => removeOption(option.id)}
                            disabled={busy}
                            title={t.remove(option.label)}
                            aria-label={t.remove(option.label)}
                          >
                            <CloseIcon />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>

                {hint ? <p class="options__hint">{hint}</p> : null}
              </>
            ) : (
              <>
                <div class="options__toolbar">
                  <span class="options__count">{history.length}</span>

                  <button
                    type="button"
                    class="options__clear-results options__tool options__tool--danger"
                    onClick={clearHistory}
                    disabled={locked || history.length === 0}
                    title={t.clearResults}
                    aria-label={t.clearResults}
                  >
                    <TrashIcon />
                  </button>
                </div>

                <div class="results">
                  {history.length === 0 ? (
                    <p class="options__empty">{t.resultsEmpty}</p>
                  ) : (
                    <ol class="results__list">
                      {history.map((entry, index) => (
                        <li class="result-row" key={entry.id}>
                          <span class="result-row__rank">
                            {history.length - index}
                          </span>
                          <span class="result-row__label" title={entry.label}>
                            {entry.label}
                          </span>
                          <span class="result-row__time">
                            {formatClock(entry.at)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </>
            )}
          </aside>
        ) : null}
      </div>

      {readOnly ? <p class="banner">{t.readOnly}</p> : null}
      {ended ? <p class="banner">{t.ended(ended)}</p> : null}
      {error ? (
        <p class="banner banner--error" role="alert">
          {t.error}: {error}
        </p>
      ) : null}

      {transferOpen ? (
        <div
          class="modal"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeTransfer();
          }}
        >
          <div
            class="modal__card"
            role="dialog"
            aria-modal="true"
            aria-label={t.transfer}
          >
            <div class="modal__head">
              <span class="modal__title">{t.transfer}</span>
              <button
                type="button"
                class="icon-button"
                onClick={closeTransfer}
                title={t.close}
                aria-label={t.close}
              >
                <CloseIcon />
              </button>
            </div>

            <div class="modal__tabs">
              <button
                type="button"
                class={`modal__tab${transferMode === 'export' ? ' is-active' : ''}`}
                onClick={() => showTransfer('export')}
              >
                {t.exportLabel}
              </button>
              <button
                type="button"
                class={`modal__tab${transferMode === 'import' ? ' is-active' : ''}`}
                onClick={() => showTransfer('import')}
              >
                {t.importLabel}
              </button>
            </div>

            <p class="modal__hint">
              {transferMode === 'export' ? t.exportHint : t.importHint}
            </p>

            <textarea
              ref={transferRef}
              class="modal__text"
              aria-label={
                transferMode === 'export' ? t.exportLabel : t.importLabel
              }
              value={transferText}
              readOnly={transferMode === 'export'}
              onInput={(event) => {
                setTransferText(event.currentTarget.value);
                setTransferError(null);
              }}
            />

            {transferError ? (
              <p class="modal__error" role="alert">
                {transferError}
              </p>
            ) : null}

            <div class="modal__actions">
              {transferMode === 'export' ? (
                <>
                  <button
                    type="button"
                    class="button button--primary"
                    onClick={copyTransfer}
                  >
                    {copied ? t.copied : t.copy}
                  </button>
                  <button type="button" class="button" onClick={closeTransfer}>
                    {t.close}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    class="button button--primary"
                    onClick={importTransfer}
                    disabled={busy || locked}
                  >
                    {t.importLabel}
                  </button>
                  <button type="button" class="button" onClick={closeTransfer}>
                    {t.cancel}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function describe(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return String((cause as { message: unknown }).message);
  }

  return String(cause);
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PanelIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
      />
      <path d="M9 4v16" fill="none" stroke="currentColor" strokeWidth={1.8} />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="m9 6 6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M12 5v14M5 12h14"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        d="m6 6 12 12M18 6 6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SortIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M4 7h10M4 12h7M4 17h4M17 5v14M14 16l3 3 3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TransferIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M7 4v13m0 0-3-3m3 3 3-3M17 20V7m0 0-3 3m3-3 3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinejoin="round"
      />
      <circle
        cx="12"
        cy="12"
        r="2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
      />
      {off ? (
        <path
          d="m3 3 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M4 7h3l10 10h3M4 17h3L17 7h3M17 3l3 4-3 4M17 13l3 4-3 4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
