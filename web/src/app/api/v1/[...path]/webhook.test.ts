import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifySignature, webhookSecret } from "@/lib/crm/webhooks";
import { rest, schemaErrors, setupApi } from "@/test/api-fixtures";
import { addApiKey, addCompany, addSubscription } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { GET, POST, PUT } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

/** Три операції вебхука через справжній маршрут REST з ключем підпису: тіла за схемами openapi.yaml. */

const KEY = "test-webhook-signing-key-0123456789abcdef";
const HANDLERS = { GET, POST, PUT } as const;
type Method = keyof typeof HANDLERS;
const call = (method: Method, path: string, o: Parameters<typeof rest>[3] = {}) => rest(HANDLERS[method], method, path, o);

let db: TestDb;
const hits: { headers: Headers; body: string }[] = [];

beforeEach(() => {
  ({ db } = setupApi({ WEBHOOK_SIGNING_KEY: KEY }));
  hits.length = 0;
  const base = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://hooks.acme.io/")) {
      hits.push({ headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response("ok");
    }
    return base(input, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("webhook operations over REST", () => {
  it("set, read and test the webhook; every body matches the contract", async () => {
    const co = addCompany(db.raw);
    addSubscription(db.raw, co);
    const { key } = await addApiKey(db.raw, co);

    const bad = await call("PUT", "/webhook", { key, body: { url: "https://127.0.0.1/hook" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.fields.url).toContain("IP addresses");
    expect(schemaErrors("PUT", "/webhook", bad)).toEqual([]);

    const set = await call("PUT", "/webhook", { key, body: { url: "https://hooks.acme.io/ncj" } });
    expect(set.status).toBe(200);
    expect(schemaErrors("PUT", "/webhook", set)).toEqual([]);
    const secret = await webhookSecret(KEY, co, 1);
    expect(set.body).toMatchObject({ url: "https://hooks.acme.io/ncj", enabled: true, secret });

    const read = await call("GET", "/webhook", { key });
    expect(schemaErrors("GET", "/webhook", read)).toEqual([]);
    expect(read.body).toMatchObject({ secret: null, failing_since: null, events: ["intro.accepted", "intro.declined", "intro.expired"] });

    const test = await call("POST", "/webhook/test", { key });
    expect(test.status).toBe(200);
    expect(schemaErrors("POST", "/webhook/test", test)).toEqual([]);
    expect(test.body).toMatchObject({ delivered: true, status_code: 200 });
    expect(await verifySignature(hits[0].headers.get("NCJ-Signature")!, hits[0].body, secret)).toBe(true);

    const extra = await call("PUT", "/webhook", { key, body: { url: "https://hooks.acme.io/ncj", secret: "mine" } });
    expect(extra.status).toBe(422);
    expect((await call("PUT", "/webhook", { key, body: {} })).status).toBe(422);
  });
});
