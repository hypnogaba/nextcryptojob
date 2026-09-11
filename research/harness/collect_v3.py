"""Збір v3 для тесту формули NextCryptoJob. Лише публічні дані, лише читання.
Правило: помилка джерела дає None з причиною, ніколи не 0."""
import json, os, re, subprocess, sys, time, urllib.request, urllib.parse
from email.utils import parsedate_to_datetime

HERE = os.path.dirname(os.path.abspath(__file__))
TW = os.environ["TWITTER_TOKEN"]
HELIUS = os.environ.get("HELIUS_KEY", "")
NOW = time.time()
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) ncj-test/0.3"}


def get_json(url, body=None, headers=None, tries=5, pause=3):
    last = None
    for i in range(tries):
        try:
            h = {**UA, **(headers or {})}
            if body is not None:
                h["Content-Type"] = "application/json"
            req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=h)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            time.sleep(min(45, pause * (i + 1) * (3 if e.code == 429 else 1)))
        except Exception as e:
            last = str(e)[:80]
            time.sleep(pause * (i + 1))
    return {"_error": last}


def get_text(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
            return r.read().decode("utf-8", "replace")
    except Exception as e:
        return None


def ts_tw(s):
    try:
        return parsedate_to_datetime(s).timestamp()
    except Exception:
        return None


# ---------- X через 6551 ----------
def x6551(path, body):
    for i in range(5):
        d = get_json(f"https://ai.6551.io/open/{path}", body, {"Authorization": f"Bearer {TW}"})
        if d.get("data"):
            return d["data"]
        time.sleep(4 * (i + 1))
    return None


def collect_x(handle):
    info = x6551("twitter_user_info", {"username": handle})
    time.sleep(2)
    kol = x6551("twitter_kol_followers", {"username": handle})
    time.sleep(2)
    tw = x6551("twitter_user_tweets", {"username": handle, "maxResults": 100, "product": "Latest"}) or []
    if isinstance(tw, dict):
        tw = tw.get("tweets", [])
    own = [t for t in tw if str(t.get("conversationId")) == str(t.get("id")) and not (t.get("text") or "").startswith("RT @")]
    replies = [t for t in tw if str(t.get("conversationId")) != str(t.get("id"))]
    def avg(xs, k):
        vals = [x.get(k) or 0 for x in xs]
        return sum(vals) / len(vals) if vals else None
    span = None
    if tw:
        tss = [ts_tw(t.get("createdAt")) for t in tw if ts_tw(t.get("createdAt"))]
        span = (max(tss) - min(tss)) / 86400 if len(tss) > 1 else None
    return {
        "followers": (info or {}).get("followersCount"),
        "kol": (kol or {}).get("totalCount") if isinstance(kol, dict) else None,
        "kol_source_gap": kol is None,
        "fetched": len(tw), "own": len(own), "replies_made": len(replies),
        "own_30d": sum(1 for t in own if (ts_tw(t.get("createdAt")) or 0) > NOW - 30 * 86400),
        "own_avg_likes_rt": (sum((t.get("favoriteCount") or 0) + (t.get("retweetCount") or 0) for t in own) / len(own)) if own else None,
        "own_avg_views": avg(own, "viewCount"),
        "own_avg_replies": avg(own, "replyCount"),
        "days_covered": span,
        "_error": None if info else "6551 не віддав профіль",
    }


# ---------- GitHub ----------
def gh(args):
    r = subprocess.run(["gh"] + args, capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else {"_error": r.stderr[:200]}


def collect_github(login):
    q = """query($login:String!){ user(login:$login){ createdAt followers{totalCount}
      repositories(ownerAffiliations:OWNER,isFork:false,first:100,orderBy:{field:STARGAZERS,direction:DESC}){
        totalCount nodes{ stargazerCount pushedAt homepageUrl primaryLanguage{name} } }
      contributionsCollection{ totalCommitContributions totalPullRequestReviewContributions
        contributionCalendar{ totalContributions } } } }"""
    for i in range(3):
        d = gh(["api", "graphql", "-f", f"query={q}", "-f", f"login={login}"])
        u = (d.get("data") or {}).get("user")
        if u:
            break
        time.sleep(15)
    if not u:
        return {"_error": "GitHub не відповів"}
    repos = u["repositories"]["nodes"]
    s = gh(["api", "-X", "GET", "search/issues", "-f", f"q=is:pr is:merged author:{login} -user:{login}"])
    time.sleep(2.5)
    year_ago = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW - 365 * 86400))
    return {
        "createdAt": u["createdAt"], "followers": u["followers"]["totalCount"],
        "stars": sum(r["stargazerCount"] for r in repos),
        "contrib_12m": u["contributionsCollection"]["contributionCalendar"]["totalContributions"],
        "commits_12m": u["contributionsCollection"]["totalCommitContributions"],
        "reviews_12m": u["contributionsCollection"]["totalPullRequestReviewContributions"],
        "merged_prs_elsewhere": s.get("total_count"),
        "repos_pushed_12m": sum(1 for r in repos if (r.get("pushedAt") or "") > year_ago),
        "repos_with_site": sum(1 for r in repos if r.get("homepageUrl")),
    }


# ---------- EVM ----------
CHAINS = {
    "ethereum": ("eth.blockscout.com", "https://ethereum-rpc.publicnode.com"),
    "base": ("base.blockscout.com", "https://mainnet.base.org"),
    "arbitrum": ("arbitrum.blockscout.com", "https://arb1.arbitrum.io/rpc"),
    "optimism": ("optimism.blockscout.com", "https://mainnet.optimism.io"),
}
SWAP_METHOD = re.compile(r"swap|exactinput|exactoutput|^execute$|fillorder|fillquote|multicall|^0x3593564c$|^0x24856bc3$", re.I)
SWAP_TO = re.compile(r"router|uniswap|1inch|aggregat|odos|paraswap|augustus|0x ?exchange|cow|kyber|sushi|curve|balancer|velodrome|aerodrome|camelot|relay|lifi|jumper|okx dex|matcha|pancake", re.I)


def collect_evm_chain(addr, host, rpc, max_pages=int(os.environ.get("EVM_PAGES", "8"))):
    n = get_json(rpc, {"jsonrpc": "2.0", "id": 1, "method": "eth_getTransactionCount", "params": [addr, "latest"]})
    sent = int(n["result"], 16) if "result" in n else None
    first = get_json(f"https://{host}/api?module=account&action=txlist&address={addr}&sort=asc&page=1&offset=1", pause=3)
    res = first.get("result") if isinstance(first.get("result"), list) else None
    first_ts = int(res[0]["timeStamp"]) if res else None
    swaps, seen, params, pages, err = 0, 0, {"filter": "from"}, 0, None
    if sent:
        while pages < max_pages:
            d = get_json(f"https://{host}/api/v2/addresses/{addr}/transactions?" + urllib.parse.urlencode(params), pause=3)
            if "_error" in d:
                err = d["_error"]; break
            for it in d.get("items", []):
                seen += 1
                m = it.get("method") or ""
                to = (it.get("to") or {}).get("name") or ""
                if SWAP_METHOD.search(m) or SWAP_TO.search(to):
                    swaps += 1
            pages += 1
            nxt = d.get("next_page_params")
            if not nxt:
                break
            params = {**nxt, "filter": "from"}
            time.sleep(1.5)
    toks = get_json(f"https://{host}/api/v2/addresses/{addr}/tokens?type=ERC-20", pause=3)
    held = 0
    for t in toks.get("items", []) if isinstance(toks, dict) else []:
        tok = t.get("token") or {}
        try:
            usd = int(t.get("value") or 0) / 10 ** int(tok.get("decimals") or 18) * float(tok.get("exchange_rate") or 0)
        except Exception:
            usd = 0
        if usd >= 10:
            held += 1
    return {"sent": sent, "first_ts": first_ts, "swaps_seen": swaps, "tx_scanned": seen,
            "swaps_est": round(swaps * sent / seen) if sent and seen and seen < sent else swaps,
            "tokens_held_10usd": held, "_error": err}


def collect_hl(addr):
    p = get_json("https://api.hyperliquid.xyz/info", {"type": "portfolio", "user": addr})
    f = get_json("https://api.hyperliquid.xyz/info", {"type": "userFills", "user": addr})
    if isinstance(p, dict) and p.get("_error"):
        return {"_error": p["_error"]}
    alltime = {k: v for k, v in p} if isinstance(p, list) else {}
    return {"volume_usd": float((alltime.get("allTime") or {}).get("vlm") or 0),
            "fills_recent": len(f) if isinstance(f, list) else None}


# ---------- Solana через Helius ----------
def collect_sol(addr, max_pages=30):
    if not HELIUS:
        return {"_error": "немає ключа Helius"}
    rpc = f"https://mainnet.helius-rpc.com/?api-key={HELIUS}"
    before, n, oldest, capped = None, 0, None, False
    for i in range(max_pages):
        params = {"limit": 1000, **({"before": before} if before else {})}
        d = get_json(rpc, {"jsonrpc": "2.0", "id": 1, "method": "getSignaturesForAddress", "params": [addr, params]})
        res = d.get("result") or []
        if not res:
            break
        n += len(res); oldest = res[-1].get("blockTime") or oldest; before = res[-1]["signature"]
        if len(res) < 1000:
            break
    else:
        capped = True
    swaps, sb, pages = 0, None, 0
    while pages < 20:
        url = f"https://api.helius.xyz/v0/addresses/{addr}/transactions?api-key={HELIUS}&type=SWAP&limit=100" + (f"&before={sb}" if sb else "")
        d = get_json(url)
        if not isinstance(d, list) or not d:
            break
        swaps += len(d); sb = d[-1]["signature"]; pages += 1
        if len(d) < 100:
            break
        time.sleep(0.5)
    assets = get_json(rpc, {"jsonrpc": "2.0", "id": 1, "method": "getAssetsByOwner",
                            "params": {"ownerAddress": addr, "page": 1, "limit": 1000, "displayOptions": {"showFungible": True}}})
    held = 0
    for a in ((assets.get("result") or {}).get("items") or []):
        pi = (a.get("token_info") or {}).get("price_info") or {}
        if (pi.get("total_price") or 0) >= 10:
            held += 1
    return {"sigs": n, "sigs_capped": capped, "first_ts": oldest, "swaps": swaps, "swaps_capped": pages >= 20,
            "tokens_held_10usd": held}


# ---------- YouTube (сторінка каналу, без ключа API) ----------
def parse_count(s):
    if not s:
        return None
    s = s.replace(" ", " ").replace(",", "").strip()
    m = re.match(r"([\d.]+)\s*([KMB]?)", s, re.I)
    if not m:
        return None
    return float(m.group(1)) * {"": 1, "K": 1e3, "M": 1e6, "B": 1e9}[m.group(2).upper()]


def collect_youtube(ch):
    base = ch if ch.startswith("http") else f"https://www.youtube.com/{ch if ch.startswith('@') else '@' + ch}"
    # З Франції YouTube спершу віддає сторінку згоди на cookies; cookie SOCS її оминає.
    try:
        req = urllib.request.Request(base.rstrip("/") + "/videos", headers={**UA, "Cookie": "SOCS=CAI; CONSENT=YES+cb", "Accept-Language": "en-US,en"})
        html = urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "replace")
    except Exception as e:
        return {"_error": f"YouTube не віддав сторінку: {str(e)[:60]}"}
    subs = re.search(r'([\d.,]+[KMB]?) subscribers', html)
    views = [parse_count(v) for v in re.findall(r'"content":"([\d.,]+[KMB]?) views"', html)][:30]
    ages = re.findall(r'"content":"(\d+) (hour|day|week|month|year)s? ago"', html)
    recent90 = sum(1 for n, u in ages if u in ("hour", "day", "week") or (u == "month" and int(n) <= 3))
    views = [v for v in views if v is not None]
    return {"subscribers": parse_count(subs.group(1)) if subs else None,
            "avg_views_recent": sum(views[:15]) / len(views[:15]) if views else None,
            "videos_90d": recent90, "videos_seen": len(ages)}


# ---------- Сайт і тексти ----------
def collect_site(site):
    url = site if site.startswith("http") else f"https://{site}"
    items, dates = 0, []
    for path in ["/feed", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/rss"]:
        t = get_text(url.rstrip("/") + path)
        if t and ("<rss" in t or "<feed" in t):
            items = len(re.findall(r"<item[ >]|<entry[ >]", t))
            for d in re.findall(r"<(?:pubDate|published|updated)>([^<]+)<", t):
                try:
                    dates.append(parsedate_to_datetime(d).timestamp())
                except Exception:
                    try:
                        dates.append(time.mktime(time.strptime(d[:19], "%Y-%m-%dT%H:%M:%S")))
                    except Exception:
                        pass
            if items:
                break
    sm_urls = 0
    sm = get_text(url.rstrip("/") + "/sitemap.xml")
    if sm and "<urlset" in sm:
        sm_urls = len(re.findall(r"<loc>", sm))
    home = get_text(url)
    return {"feed_items": items, "sitemap_urls": sm_urls, "reachable": home is not None,
            "latest_ts": max(dates) if dates else None,
            "items_90d": sum(1 for d in dates if d > NOW - 90 * 86400)}


def collect(p):
    out = {"id": p["id"], "name": p["name"]}
    if p.get("x"):
        out["x"] = collect_x(p["x"])
    if p.get("github"):
        out["gh"] = collect_github(p["github"])
    if p.get("youtube"):
        out["yt"] = collect_youtube(p["youtube"])
    if p.get("site"):
        out["site"] = collect_site(p["site"])
    out["evm"] = {}
    for a in p.get("evm") or []:
        out["evm"][a] = {ch: collect_evm_chain(a, h, r) for ch, (h, r) in CHAINS.items()}
        out["evm"][a]["hyperliquid"] = collect_hl(a)
    out["sol"] = {a: collect_sol(a) for a in p.get("sol") or []}
    return out


if __name__ == "__main__":
    people = json.load(open(sys.argv[1]))
    dest = sys.argv[2]
    done = json.load(open(dest)) if os.path.exists(dest) else {}
    for p in people:
        if p["id"] in done:
            continue
        print("collect", p["id"], flush=True)
        done[p["id"]] = collect(p)
        json.dump(done, open(dest, "w"), ensure_ascii=False, indent=1)
    print("done", len(done))
