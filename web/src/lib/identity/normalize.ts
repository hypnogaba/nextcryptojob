// Нормалізація ніків і посилань до `identities.value` (docs/contracts.md, §2).
// Людина вставляє що завгодно: нік з @, посилання на профіль, адресу без
// https. Тут це стає одним записом або зрозумілою причиною англійською.

export type IdentityKind = "x" | "github" | "youtube" | "site" | "evm" | "solana" | "sherlock";

export type Normalized = { ok: true; value: string } | { ok: false; error: string };

const ok = (value: string): Normalized => ({ ok: true, value });
const fail = (error: string): Normalized => ({ ok: false, error });

/** Посилання без схеми («x.com/ada») теж посилання. */
function asUrl(raw: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/** Перший сегмент шляху, якщо хост з переліку; інакше null. */
function pathOn(raw: string, hosts: string[]): string[] | null {
  if (!raw.includes("/") && !hosts.some((h) => raw.toLowerCase().startsWith(h))) return null;
  const url = asUrl(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  if (!hosts.includes(host)) return null;
  return url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
}

const X_HANDLE = /^[a-z0-9_]{1,15}$/;

/** X: нік без `@`, нижній регістр. Приймає `@Ada`, `x.com/Ada`, `twitter.com/ada`. */
export function normalizeX(input: string): Normalized {
  let raw = input.trim();
  if (!raw) return fail("Enter your X handle.");
  const path = pathOn(raw, ["x.com", "twitter.com"]);
  if (path) raw = path[0] ?? "";
  const value = raw.replace(/^@/, "").toLowerCase();
  if (!X_HANDLE.test(value)) return fail("An X handle has up to 15 letters, digits or _.");
  return ok(value);
}

const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

/** GitHub: логін, нижній регістр. Приймає `@ada`, `github.com/Ada`. */
export function normalizeGithub(input: string): Normalized {
  let raw = input.trim();
  if (!raw) return fail("Enter your GitHub login.");
  const path = pathOn(raw, ["github.com"]);
  if (path) raw = path[0] ?? "";
  const value = raw.replace(/^@/, "").toLowerCase();
  if (!GITHUB_LOGIN.test(value)) return fail("A GitHub login has letters, digits and single dashes.");
  return ok(value);
}

const YT_HANDLE = /^@[a-z0-9._-]{3,30}$/;
const YT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/**
 * YouTube: `@handle` нижній регістр або channel id `UC…` як є.
 * Приймає `@Ada`, `youtube.com/@Ada`, `youtube.com/channel/UC…`.
 */
export function normalizeYoutube(input: string): Normalized {
  const raw = input.trim();
  if (!raw) return fail("Enter your YouTube @handle or channel link.");
  if (YT_CHANNEL_ID.test(raw)) return ok(raw);
  const path = pathOn(raw, ["youtube.com"]);
  let candidate = raw;
  if (path) {
    if (path[0] === "channel" && path[1] && YT_CHANNEL_ID.test(path[1])) return ok(path[1]);
    if (!path[0]?.startsWith("@")) return fail("Use the @handle or the /channel/ link of your YouTube channel.");
    candidate = path[0];
  } else if (raw.includes("/")) {
    return fail("Use the @handle or the /channel/ link of your YouTube channel.");
  }
  const value = (candidate.startsWith("@") ? candidate : `@${candidate}`).toLowerCase();
  if (!YT_HANDLE.test(value)) return fail("A YouTube handle has 3 to 30 letters, digits, dots, dashes or _.");
  return ok(value);
}

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Публічне доменне ім'я (нижній регістр): хоч одна крапка, зона з літер, без
 * локальних і зарезервованих зон. IP-літерал сюди не проходить ніколи: у
 * IPv4 остання частина цифрова, IPv6 має дужки, а URL сам перетворює
 * 2130706433 чи 0x7f.1 на 127.0.0.1. Той самий захист мають вебхуки компаній
 * (crm/webhooks.ts): за адресою потім ходить наш сервер.
 */
export function isPublicHostname(host: string): boolean {
  return HOST.test(host) && !/\.(local|localhost|internal|lan|home|arpa|test|invalid|example)$/.test(host);
}

/**
 * Сайт: `https://` + хост + шлях без кінцевого `/`, хост нижній регістр.
 * Без схеми додаємо https; http не приймаємо. Лише публічне доменне ім'я:
 * за цією адресою потім ходить рушій.
 */
export function normalizeSite(input: string): Normalized {
  const raw = input.trim();
  if (!raw) return fail("Enter the address of your website.");
  if (/^http:\/\//i.test(raw)) return fail("Use the https:// address of your site.");
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https:\/\//i.test(raw)) {
    return fail("Use the https:// address of your site.");
  }
  const url = asUrl(raw);
  if (!url || url.username || url.password || url.port) return fail("This does not look like a website address.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!isPublicHostname(host)) {
    return fail("This does not look like a public website address.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return ok(`https://${host}${path}`);
}

const SHERLOCK_HANDLE = /^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/;

/** Sherlock: нік, нижній регістр. Приймає `audits.sherlock.xyz/watson/<нік>`. */
export function normalizeSherlock(input: string): Normalized {
  let raw = input.trim();
  if (!raw) return fail("Enter your Sherlock handle.");
  const path = pathOn(raw, ["audits.sherlock.xyz", "app.sherlock.xyz", "sherlock.xyz"]);
  if (path) raw = path[0] === "watson" ? (path[1] ?? "") : (path.at(-1) ?? "");
  const value = raw.replace(/^@/, "").toLowerCase();
  if (!SHERLOCK_HANDLE.test(value)) return fail("A Sherlock handle has letters, digits, dots, dashes or _.");
  return ok(value);
}

export const NORMALIZERS = {
  x: normalizeX,
  github: normalizeGithub,
  youtube: normalizeYoutube,
  site: normalizeSite,
  sherlock: normalizeSherlock,
} as const;
