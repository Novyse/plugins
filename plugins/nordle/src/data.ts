import languagesData from './languages.json';

export interface LanguageMeta {
  code: string;
  name: string;
  nativeName: string;
  keyboard: string[][];
  rtl: boolean;
  availableLengths: number[];
  totalWords: number;
}

const languagesMap = new Map<string, LanguageMeta>();
for (const item of languagesData as LanguageMeta[]) {
  languagesMap.set(item.code, item);
}

export function getLanguageList(): LanguageMeta[] {
  return Array.from(languagesMap.values()).sort((a, b) =>
    a.nativeName.localeCompare(b.nativeName)
  );
}

export function getLanguageMeta(code: string): LanguageMeta {
  return (
    languagesMap.get(code) ??
    languagesMap.get('it') ??
    Array.from(languagesMap.values())[0]
  );
}

// Statically import all JSON word lists from the data folder at build time
const wordFiles = import.meta.glob<string[]>('../public/data/*/*.json', {
  eager: true,
  import: 'default',
});

const wordsCache = new Map<string, string[]>();
const setsCache = new Map<string, Set<string>>();

export async function loadWordList(
  lang: string,
  length: number
): Promise<{ words: string[]; set: Set<string> }> {
  const key = `${lang}:${length}`;
  if (wordsCache.has(key)) {
    return {
      words: wordsCache.get(key)!,
      set: setsCache.get(key)!,
    };
  }

  const path = `../public/data/${lang}/${length}.json`;
  const fallbackPath = `../public/data/it/${length}.json`;
  const words: string[] = wordFiles[path] ?? wordFiles[fallbackPath] ?? [];

  const set = new Set(words);
  wordsCache.set(key, words);
  setsCache.set(key, set);
  return { words, set };
}

export function getTodayIdx(): number {
  const start = new Date(2022, 0, 1).getTime();
  const now = Date.now();
  return Math.floor((now - start) / (1000 * 60 * 60 * 24));
}

export function getRandomWordFromList(words: string[], seed: number): string {
  if (!words || words.length === 0) return '';
  const poolSize = Math.min(words.length, 1500);
  const idx = Math.abs(seed % poolSize);
  return words[idx];
}
