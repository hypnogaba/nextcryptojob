// Детерміновані випадкові числа для малюнків картки: той самий рядок завжди
// дає ту саму послідовність. Печатка (seal.ts) бере звідси зерно й генератор.
// Раніше тут жив візерунок картки 1200×630; його замінила печатка.

/** FNV-1a, 32 біти: короткий стабільний хеш рядка (UTF-16 одиниці). */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: детермінований генератор чисел [0, 1) з 32-бітного зерна. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
