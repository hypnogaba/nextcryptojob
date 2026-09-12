// Помічники формули (docs/contracts.md §4). null на вході = прогалина, вона ніколи не стає нулем.

/** Логарифмічна шкала 0..1: перші кроки важать більше за останні. */
export function logn(x: number | null, cap: number): number | null {
  if (x === null) return null;
  return Math.min(1, Math.log10(1 + Math.max(0, x)) / Math.log10(1 + cap));
}

/** Лінійна шкала 0..1. */
export function lin(x: number | null, cap: number): number | null {
  if (x === null) return null;
  return Math.min(1, Math.max(0, x) / cap);
}

/** 100 · Σ w·v / Σ w лише по не-null v; якщо всі null → null. */
export function combine(parts: ReadonlyArray<readonly [weight: number, value: number | null]>): number | null {
  let num = 0;
  let den = 0;
  for (const [w, v] of parts) {
    if (v === null) continue;
    num += w * v;
    den += w;
  }
  return den === 0 ? null : (100 * num) / den;
}

/** Найбільше з не-null; якщо всі null → null. */
export function maxOf(...xs: Array<number | null>): number | null {
  const ok = xs.filter((v): v is number => v !== null);
  return ok.length ? Math.max(...ok) : null;
}
