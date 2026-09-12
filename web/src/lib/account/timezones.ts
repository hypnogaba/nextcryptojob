/**
 * Часові пояси для години добірки. Білий список = пояси IANA, які знає сам
 * рушій (Intl.supportedValuesOf), плюс UTC. Вільний текст у базу не пишемо:
 * рушій добірки рахуватиме місцеву годину саме з цього рядка.
 *
 * V8 віддає застарілі канонічні назви (Europe/Kiev, Asia/Calcutta), а браузер
 * може прислати нові (Europe/Kyiv). Тому вхід спершу зводимо до назви, яку
 * знає рушій, через Intl.DateTimeFormat, і лише тоді звіряємо зі списком.
 */

// Форма назви поясу IANA: Area/Location[/Sub], або UTC. Решту не даємо навіть Intl.
const ZONE_SHAPE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

let cached: readonly string[] | null = null;

/** Усі пояси для вибору, UTC першим. */
export function timezoneList(): readonly string[] {
  if (cached) return cached;
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    // Без списку лишаємо хоча б UTC: краще вузький вибір, ніж вільний текст.
  }
  cached = ["UTC", ...zones.filter((z) => z !== "UTC")];
  return cached;
}

/** Назва поясу з білого списку для цього входу, або null. */
export function canonicalTimezone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 64 || !ZONE_SHAPE.test(raw)) return null;
  const list = timezoneList();
  if (list.includes(raw)) return raw;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (resolved === "Etc/UTC" || resolved === "Etc/GMT" || resolved === "GMT") return "UTC";
  return list.includes(resolved) ? resolved : null;
}
