/**
 * Публічні id: префікс + '_' + 20 символів base62 з crypto.getRandomValues
 * (специфікація CRM, розділ 3.5). 20 символів base62 це ~119 біт: вгадати
 * чужий id неможливо, тож id можна показувати в адресах і API.
 *
 * `candidate_id` сюди не входить: це `users.id` (uuid v4), він нічого не розкриває.
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Префікси з міграцій 0003 і 0004. */
export const ID_PREFIXES = ["co", "job", "int", "ss", "app", "sub", "key", "pay", "msg", "tst"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

export const ID_BODY_LENGTH = 20;

/**
 * `length` рівноймовірних символів base62. Байт ≥ 248 (= 4·62) відкидаємо,
 * інакше перші 8 символів абетки траплялися б частіше за решту.
 */
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length + 16))) {
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

/** Новий id з префіксом, напр. `co_8fK2mQ9xLp3sV7nB1zRt`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBase62(ID_BODY_LENGTH)}`;
}

/** Чи рядок має форму id з цим префіксом (для вхідних даних з адреси чи API). */
export function isId(prefix: IdPrefix, value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9]{${ID_BODY_LENGTH}}$`).test(value);
}
