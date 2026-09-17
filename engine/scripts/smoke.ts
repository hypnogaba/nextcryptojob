/**
 * Ручна жива перевірка одного збирача на справжніх ключах із оточення. У тестах не запускається.
 *
 *   npm run smoke -- x <handle>
 *   npm run smoke -- site example.com
 *   GITHUB_TOKEN=… npm run smoke -- github <login>
 *   GITHUB_TOKEN=… npm run smoke -- dune <login>
 *   npm run smoke -- youtube @handle
 *   npm run smoke -- audits <sherlock> --github <login> --x <handle>
 *
 * Друкує лише результат Fetched і час; ключів не друкує.
 */
import { collectAudits } from "../src/collectors/audits.js";
import type { CollectorContext } from "../src/collectors/context.js";
import { collectDune } from "../src/collectors/dune.js";
import { collectGithub } from "../src/collectors/github.js";
import { collectSite } from "../src/collectors/site.js";
import { collectX } from "../src/collectors/x.js";
import { collectYoutube } from "../src/collectors/youtube.js";

const [kind, value, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const kinds: Record<string, (v: string, ctx: CollectorContext) => Promise<unknown>> = {
  x: collectX,
  github: collectGithub,
  site: collectSite,
  youtube: collectYoutube,
  dune: collectDune,
  audits: (v, ctx) => collectAudits(v, { github: flag("github"), x: flag("x") }, ctx),
};

const run = kind ? kinds[kind] : undefined;
if (!run || !value) {
  console.error(`usage: smoke <${Object.keys(kinds).join("|")}> <value> [--github login] [--x handle]`);
  process.exit(2);
}
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(new Error("smoke: 180 s timeout")), 180_000);
const t0 = performance.now();
const result = await run(value, { env: process.env, signal: ac.signal });
clearTimeout(timer);
console.log(JSON.stringify(result, null, 2));
console.log(`${kind} ${value}: ${Math.round(performance.now() - t0)} ms`);
process.exit(0);
