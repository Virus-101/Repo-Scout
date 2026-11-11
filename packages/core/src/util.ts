export const nowIso = () => new Date().toISOString();
export function daysSince(iso: string | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.max(0, (now - t) / 86400000);
}
export const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
export const uniq = <T>(a: T[]): T[] => [...new Set(a)];
export function sha(s: string): string {
  // small non-crypto FNV-1a 64-bit-ish hash for keys (cache keys, ids)
  let h1 = 0x811c9dc5,
    h2 = 0xdeadbeef;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822507);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
export function pLimit(concurrency: number) {
  let active = 0;
  const q: Array<() => void> = [];
  const next = () => {
    active--;
    q.shift()?.();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((res, rej) => {
      const run = () => {
        active++;
        fn().then(res, rej).finally(next);
      };
      if (active < concurrency) run();
      else q.push(run);
    });
}
export function pickDefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
