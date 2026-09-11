"""Швидкий збір для NextCryptoJob: великі запити, джерела паралельно, ліміт на кожен хост.
Використання: python3 collect_fast.py people.json raw_out.json [workers]"""
import json, os, re, sys, threading, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
import collect_v3 as v3  # X, YouTube, сайт, Hyperliquid беремо звідти

HERE = os.path.dirname(os.path.abspath(__file__))
HELIUS = os.environ.get("HELIUS_KEY", "")
NOW = time.time()

# Скільки одночасних запитів дозволяємо кожному хосту.
LIMITS = {"blockscout": 3, "6551": 2, "github": 4, "helius": 4, "hl": 4, "web": 4}
SEM = {k: threading.Semaphore(v) for k, v in LIMITS.items()}


def limited(kind, fn, *a):
    with SEM[kind]:
        return fn(*a)


# ---------- EVM: одна вибірка txlist на мережу ----------
HOSTS = {"ethereum": "eth.blockscout.com", "base": "base.blockscout.com",
         "arbitrum": "arbitrum.blockscout.com", "optimism": "optimism.blockscout.com"}
SEL_CACHE_PATH = os.path.join(HERE, "selectors.json")
SEL = json.load(open(SEL_CACHE_PATH)) if os.path.exists(SEL_CACHE_PATH) else {}
SEL_LOCK = threading.Lock()
SWAP_NAME = re.compile(r"swap(?!ETH\(uint16)|exactinput|exactoutput|^execute\(bytes|fillorder|fillquote|sellto|transformerc20|unoswap", re.I)


def txlist(host, addr, sort, offset):
    url = f"https://{host}/api?module=account&action=txlist&address={addr}&sort={sort}&page=1&offset={offset}"
    d = v3.get_json(url, pause=2, tries=int(os.environ.get("BS_TRIES", "5")))
    return d.get("result") if isinstance(d.get("result"), list) else None


ETHERSCAN = {"ethereum": 1, "arbitrum": 42161}  # на безкоштовному плані Base і Optimism закриті
ES_KEY = os.environ.get("ETHERSCAN_KEY", "")
ES_LOCK = threading.Lock()
ES_LAST = [0.0]


def etherscan_txlist(chainid, addr):
    rows = []
    for page in range(1, 11):
        with ES_LOCK:  # не більше 4 запитів на секунду (ліміт 5)
            wait = ES_LAST[0] + 0.25 - time.time()
            if wait > 0:
                time.sleep(wait)
            ES_LAST[0] = time.time()
        url = (f"https://api.etherscan.io/v2/api?chainid={chainid}&module=account&action=txlist&address={addr}"
               f"&startblock=0&endblock=99999999&page={page}&offset=1000&sort=desc&apikey={ES_KEY}")
        d = v3.get_json(url, pause=2)
        r = d.get("result")
        if not isinstance(r, list):
            if "No transactions found" in str(d.get("message")):
                break
            return None if not rows else rows
        rows += r
        if len(r) < 1000:
            break
    return rows


def evm_chain(chain, addr):
    if ES_KEY and chain in ETHERSCAN:
        rows = etherscan_txlist(ETHERSCAN[chain], addr)
        src = "etherscan"
    else:
        rows = limited("blockscout", txlist, HOSTS[chain], addr, "desc", 10000)
        src = "blockscout"
    if rows is None:
        return {"_error": f"{src} не віддав транзакції"}
    a = addr.lower()
    sent = [r for r in rows if (r.get("from") or "").lower() == a]
    capped = len(rows) >= 10000
    first_ts = int(rows[-1]["timeStamp"]) if rows and not capped else None
    if capped and src == "blockscout":
        old = limited("blockscout", txlist, HOSTS[chain], addr, "asc", 1)
        first_ts = int(old[0]["timeStamp"]) if old else None
    ok = [r for r in sent if (r.get("isError") or "0") == "0"]
    return {"sent": len(sent), "sent_capped": capped, "first_ts": first_ts, "source": src,
            "methods": [r.get("methodId") or "0x" for r in ok],
            "names": [r.get("functionName") or "" for r in ok]}


def resolve_selectors(sels):
    need = sorted({s for s in sels if s not in SEL and s != "0x" and len(s) == 10})
    for i in range(0, len(need), 40):
        chunk = need[i:i + 40]
        d = v3.get_json("https://api.openchain.xyz/signature-database/v1/lookup?filter=true&function=" + ",".join(chunk))
        fn = ((d.get("result") or {}).get("function") or {})
        with SEL_LOCK:
            for s in chunk:
                SEL[s] = (fn.get(s) or [{}])[0].get("name") if fn.get(s) else None
    json.dump(SEL, open(SEL_CACHE_PATH, "w"), indent=0)


def evm_summary(per_chain):
    out = {}
    for chain, c in per_chain.items():
        if c.get("_error"):
            out[chain] = c; continue
        if not any(c.get("names") or []):
            resolve_selectors(c["methods"])
        swaps = sum(1 for m, nm in zip(c["methods"], c.get("names") or [""] * len(c["methods"]))
                    if SWAP_NAME.search(nm or SEL.get(m) or ""))
        out[chain] = {"sent": c["sent"], "sent_capped": c["sent_capped"], "first_ts": c["first_ts"],
                      "swaps_est": swaps, "tokens_held_10usd": None}
    return out


# ---------- Solana: Helius ----------
def sol(addr):
    """Підписи через публічний вузол Solana. Обміни лише з окремим ключем Helius для NextCryptoJob
    (ключ tradebot не чіпаємо: він потрібен живому боту)."""
    key = os.environ.get("NCJ_HELIUS_KEY", "")
    rpc = "https://api.mainnet-beta.solana.com"
    before, n, oldest, capped, err = None, 0, None, True, None
    for _ in range(5):
        params = {"limit": 1000, **({"before": before} if before else {})}
        d = limited("helius", v3.get_json, rpc, {"jsonrpc": "2.0", "id": 1, "method": "getSignaturesForAddress", "params": [addr, params]})
        if d.get("_error") or d.get("error"):
            err = str(d.get("_error") or d.get("error"))[:80]; break
        res = d.get("result") or []
        if not res:
            capped = False; break
        n += len(res); oldest = res[-1].get("blockTime") or oldest; before = res[-1]["signature"]
        if len(res) < 1000:
            capped = False; break
        time.sleep(1)
    swaps = None
    if key:
        swaps, sb = 0, None
        for _ in range(10):
            url = f"https://api.helius.xyz/v0/addresses/{addr}/transactions?api-key={key}&type=SWAP&limit=100" + (f"&before={sb}" if sb else "")
            d = limited("helius", v3.get_json, url)
            if not isinstance(d, list) or not d:
                break
            swaps += len(d); sb = d[-1]["signature"]
            if len(d) < 100:
                break
    if err and not n:
        return {"_error": f"вузол Solana: {err}"}
    return {"sigs": n, "sigs_capped": capped, "first_ts": oldest, "swaps": swaps,
            "swaps_gap": None if key else "немає ключа Helius для обмінів", "tokens_held_10usd": None}


# ---------- GitHub: один запит GraphQL, без REST-пошуку ----------
def github(login):
    q = """query($login:String!){ user(login:$login){ createdAt followers{totalCount}
      repositories(ownerAffiliations:OWNER,isFork:false,first:100,orderBy:{field:STARGAZERS,direction:DESC}){
        nodes{ stargazerCount pushedAt homepageUrl } }
      pullRequests(states:MERGED,first:100,orderBy:{field:CREATED_AT,direction:DESC}){ totalCount nodes{ repository{ owner{ login } } } }
      contributionsCollection{ totalCommitContributions totalPullRequestReviewContributions } } }"""
    for _ in range(3):
        d = limited("github", v3.gh, ["api", "graphql", "-f", f"query={q}", "-f", f"login={login}"])
        u = (d.get("data") or {}).get("user")
        if u:
            break
        time.sleep(10)
    else:
        return {"_error": "GitHub не відповів"}
    prs = u["pullRequests"]
    nodes = prs["nodes"]
    elsewhere_share = (sum(1 for p in nodes if (p["repository"]["owner"]["login"] or "").lower() != login.lower()) / len(nodes)) if nodes else 0
    year_ago = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW - 365 * 86400))
    repos = u["repositories"]["nodes"]
    return {"createdAt": u["createdAt"], "followers": u["followers"]["totalCount"],
            "stars": sum(r["stargazerCount"] for r in repos),
            "commits_12m": u["contributionsCollection"]["totalCommitContributions"],
            "reviews_12m": u["contributionsCollection"]["totalPullRequestReviewContributions"],
            "merged_prs_elsewhere": round(prs["totalCount"] * elsewhere_share),
            "repos_pushed_12m": sum(1 for r in repos if (r.get("pushedAt") or "") > year_ago),
            "repos_with_site": sum(1 for r in repos if r.get("homepageUrl"))}


def person(p):
    t0 = time.time()
    jobs = {}
    with ThreadPoolExecutor(max_workers=12) as ex:
        if p.get("x"):
            jobs["x"] = ex.submit(limited, "6551", v3.collect_x, p["x"])
        if p.get("github"):
            jobs["gh"] = ex.submit(github, p["github"])
        if p.get("youtube"):
            jobs["yt"] = ex.submit(limited, "web", v3.collect_youtube, p["youtube"])
        if p.get("site"):
            jobs["site"] = ex.submit(limited, "web", v3.collect_site, p["site"])
        evm_jobs = {(a, ch): ex.submit(evm_chain, ch, a) for a in p.get("evm") or [] for ch in HOSTS}
        hl_jobs = {a: ex.submit(limited, "hl", v3.collect_hl, a) for a in p.get("evm") or []}
        sol_jobs = {a: ex.submit(sol, a) for a in p.get("sol") or []}
        out = {"id": p["id"], "name": p["name"]}
        for k, f in jobs.items():
            out[k] = f.result()
        out["evm"] = {}
        for a in p.get("evm") or []:
            out["evm"][a] = evm_summary({ch: evm_jobs[(a, ch)].result() for ch in HOSTS})
            out["evm"][a]["hyperliquid"] = hl_jobs[a].result()
        out["sol"] = {a: f.result() for a, f in sol_jobs.items()}
    out["_seconds"] = round(time.time() - t0, 1)
    return out


if __name__ == "__main__":
    people = json.load(open(sys.argv[1]))
    dest = sys.argv[2]
    workers = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    done = json.load(open(dest)) if os.path.exists(dest) else {}
    todo = [p for p in people if p["id"] not in done]
    t0 = time.time()
    lock = threading.Lock()

    def run(p):
        r = person(p)
        with lock:
            done[p["id"]] = r
            json.dump(done, open(dest, "w"), ensure_ascii=False, indent=1)
        print(f"{p['id']}: {r['_seconds']} с", flush=True)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(run, todo))
    print(f"усього {len(todo)} людей за {time.time() - t0:.0f} с")
