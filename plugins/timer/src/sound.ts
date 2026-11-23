/**
 * The bell at the end of a phase.
 *
 * No asset and no channel: every client derives the end of the countdown from
 * the shared snapshot, so each one rings locally at the same second. Browsers
 * suspend an `AudioContext` until a gesture, which is why the app calls
 * `unlockAudio` from the pointer and from every control.
 */
let context: AudioContext | null = null;

function ensureContext(): AudioContext | null {
  try {
    if (!context) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!Ctor) return null;
      context = new Ctor();
    }

    return context;
  } catch {
    return null;
  }
}

/** Creates or resumes the context while a user gesture is still active. */
export async function unlockAudio(): Promise<boolean> {
  const audio = ensureContext();
  if (!audio) return false;

  if (audio.state !== 'running') {
    try {
      await audio.resume();
    } catch {
      return false;
    }
  }

  return audio.state === 'running';
}

/** Two soft notes, a little bell body. */
function scheduleBell(audio: AudioContext, start: number): void {
  const notes = [880, 1318.51];

  notes.forEach((frequency, index) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const at = start + index * 0.16;

    oscillator.type = index === 0 ? 'sine' : 'triangle';
    oscillator.frequency.value = frequency;

    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.14, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);

    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.6);
  });
}

/**
 * Rings the bell a few times, so a timer that ends while the tab is in the
 * background is still noticed. If the context is suspended, `resume` is
 * awaited first: a gesture that happened earlier makes this work.
 */
export function playChime(rings = 3): void {
  const audio = ensureContext();
  if (!audio) return;

  const run = () => {
    if (audio.state !== 'running') return;

    const start = audio.currentTime + 0.02;
    for (let index = 0; index < rings; index += 1) {
      scheduleBell(audio, start + index * 0.85);
    }
  };

  if (audio.state === 'running') {
    run();
    return;
  }

  void audio.resume().then(run).catch(() => {});
}
