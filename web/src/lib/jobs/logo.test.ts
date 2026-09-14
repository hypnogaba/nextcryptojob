import { beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { jobsTestDb } from "@/test/jobs-db";
import { cleanDomain, companyProfiles, logoPath, profilesOf, resetCompanyProfiles } from "./companies";
import { faviconUrl, logoResponse, MAX_BYTES } from "./logo";

/**
 * Значок компанії через /api/logo: лише домени з реєстру, лише растрові картинки, запит назовні
 * лише на сталий хост, кеш. І профілі компаній (домен, «про компанію») з реєстру.
 */

let jobs: () => JobsDb;
let fetched: string[];

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const upstream = (body: BodyInit | null, type: string, status = 200) =>
  vi.fn(async (url: string | URL | Request) => {
    fetched.push(String(url));
    return new Response(body, { status, headers: { "content-type": type } });
  }) as unknown as typeof fetch;

const req = (domain: string) => new Request(`https://site.test/api/logo/${domain}`);

beforeEach(() => {
  resetCompanyProfiles();
  fetched = [];
  const t = jobsTestDb();
  t.raw.exec(`INSERT INTO companies (slug, name, ats_provider, ats_slug, discovered_via, domain, about) VALUES
    ('aave', 'Aave', 'greenhouse', 'aave', 'manual', 'aave.com', 'Aave runs lending markets.'),
    ('kraken', 'Kraken', 'ashby', 'kraken.com', 'seed', 'kraken.com', NULL),
    ('bad', 'Bad', 'lever', 'bad', 'seed', 'javascript:alert(1)', NULL)`);
  const db = readOnlyJobsDb(t.d1);
  jobs = () => db;
});

describe("/api/logo", () => {
  it("serves a registry domain's favicon from the fixed favicon host, cached for a week", async () => {
    const res = await logoResponse(req("aave.com"), "aave.com", { jobs, fetchImpl: upstream(png, "image/png"), cache: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("max-age=604800");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(fetched).toEqual([faviconUrl("aave.com")]);
    expect(fetched[0]).toMatch(/^https:\/\/www\.google\.com\/s2\/favicons\?domain=aave\.com&sz=64$/);
  });

  it("a domain not in the registry, or a malformed one, is 404 without any request out", async () => {
    for (const d of ["evil.example", "localhost", "169.254.169.254.nip.io", "AAVE.com", "www.aave.com", "aave.com/..", "aave", ""]) {
      const res = await logoResponse(req(d), d, { jobs, fetchImpl: upstream(png, "image/png"), cache: null });
      expect({ d, status: res.status }).toEqual({ d, status: 404 });
    }
    expect(fetched).toEqual([]);
  });

  it("never passes SVG or HTML through, and caps the size", async () => {
    for (const type of ["image/svg+xml", "text/html", "application/octet-stream"]) {
      const res = await logoResponse(req("aave.com"), "aave.com", { jobs, fetchImpl: upstream("<svg onload=alert(1)>", type), cache: null });
      expect({ type, status: res.status }).toEqual({ type, status: 404 });
    }
    const big = new Uint8Array(MAX_BYTES + 1);
    expect((await logoResponse(req("aave.com"), "aave.com", { jobs, fetchImpl: upstream(big, "image/png"), cache: null })).status).toBe(404);
    // Сервіс не знає домену (404 з картинкою-заглушкою): у нас 404, і картка лишає літеру.
    expect((await logoResponse(req("aave.com"), "aave.com", { jobs, fetchImpl: upstream(png, "image/png", 404), cache: null })).status).toBe(404);
  });

  it("answers from the edge cache when it has the icon", async () => {
    const store = new Map<string, Response>();
    const cache = {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => void store.set(r.url, res),
    } as unknown as Cache;
    const first = await logoResponse(req("kraken.com"), "kraken.com", { jobs, fetchImpl: upstream(png, "image/x-icon"), cache });
    expect(first.status).toBe(200);
    const again = await logoResponse(req("kraken.com"), "kraken.com", { jobs, fetchImpl: upstream(png, "image/x-icon"), cache });
    expect(again.status).toBe(200);
    expect(fetched).toHaveLength(1);
  });
});

describe("company profiles", () => {
  it("reads domain and about by company key; a bad domain is dropped", async () => {
    const p = await companyProfiles(jobs);
    expect(p.byKey.get("aave")).toEqual({ domain: "aave.com", about: "Aave runs lending markets." });
    expect(p.byKey.get("kraken")).toEqual({ domain: "kraken.com", about: null });
    expect(p.byKey.get("bad")).toEqual({ domain: null, about: null });
    expect([...p.domains].sort()).toEqual(["aave.com", "kraken.com"]);
  });

  it("two rows for one company: the first non-empty domain and about", () => {
    const p = profilesOf([
      { name: "Aave Labs", domain: null, about: "Aave builds DeFi." },
      { name: "aave labs", domain: "aave.com", about: "Other text." },
    ]);
    expect(p.byKey.get("aave labs")).toEqual({ domain: "aave.com", about: "Aave builds DeFi." });
  });

  it("before db/jobs 0005 there are no columns: empty, no error", async () => {
    const old = { all: async () => Promise.reject(new Error("D1_ERROR: no such column: domain")), first: async () => null };
    const p = await companyProfiles(() => old);
    expect(p.byKey.size).toBe(0);
  });

  it("logo paths and domains", () => {
    expect(logoPath("Aave.com")).toBe("/api/logo/aave.com");
    expect(logoPath("www.aave.com")).toBe("/api/logo/aave.com");
    expect(logoPath(null)).toBeNull();
    for (const bad of ["javascript:alert(1)", "aave", "a b.com", "aave.com/x", "../x.com"]) expect(cleanDomain(bad)).toBeNull();
  });
});
