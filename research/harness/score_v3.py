"""Формула NextCryptoJob v3.
Правила:
- підсигнал, якого джерело не віддало (прогалина), не рахується в знаменнику;
- джерело, яке людина не підключила, дає 0 у ролі (крім пари X|YouTube: береться сильніший);
- без головного джерела роль не рахується;
- бал ролі = 90 x основні + 10 x додаткові (запуск, CV; у тесті не підключені)."""
import json, math, sys, time

NOW = time.time()


def logn(x, cap):
    if x is None:
        return None
    return min(1.0, math.log10(1 + max(0, x)) / math.log10(1 + cap))


def lin(x, cap):
    return None if x is None else min(1.0, max(0, x) / cap)


def combine(parts):
    ok = [(w, v) for w, v in parts if v is not None]
    if not ok:
        return None
    return 100 * sum(w * v for w, v in ok) / sum(w for w, _ in ok)


def years(ts):
    return None if not ts else max(0.0, (NOW - ts) / (365.25 * 86400))


def iso(s):
    return time.mktime(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")) if s else None


def src_gh_eng(g):
    if not g or g.get("_error"):
        return None
    return combine([(35, logn(g["merged_prs_elsewhere"], 1500)), (25, logn(g["stars"], 10000)),
                    (15, logn(g["reviews_12m"], 500)), (15, logn(g["followers"], 5000)),
                    (10, logn(g["commits_12m"], 3000))])


def src_gh_builder(g):
    if not g or g.get("_error"):
        return None
    return combine([(40, lin(g["repos_pushed_12m"], 15)), (30, lin(g["repos_with_site"], 5)),
                    (30, logn(g["commits_12m"], 2000))])


def src_x(x):
    if not x or x.get("followers") is None:
        return None
    per30 = None
    if x.get("own") is not None and x.get("days_covered"):
        per30 = x["own"] / max(x["days_covered"], 1) * 30
    return combine([(15, logn(x["followers"], 1_000_000)), (25, None if x.get("kol_source_gap") else logn(x.get("kol"), 1000)),
                    (15, logn(x.get("own_avg_likes_rt"), 3000)), (15, logn(x.get("own_avg_views"), 300_000)),
                    (15, logn(x.get("own_avg_replies"), 300)), (15, lin(per30, 30))])


def src_yt(y):
    if not y or y.get("_error") or y.get("subscribers") is None:
        return None
    return combine([(45, logn(y["subscribers"], 3_000_000)), (35, logn(y.get("avg_views_recent"), 300_000)),
                    (20, lin(y.get("videos_90d"), 24))])


def wallets(r):
    """Зводить усі гаманці людини в факти."""
    evm, sol = r.get("evm") or {}, r.get("sol") or {}
    if not evm and not sol:
        return None
    firsts, sent, swaps, held, chains, tchains, hl_vol, hl_fills, gap = [], 0, 0, 0, set(), set(), 0.0, 0, False
    for per in evm.values():
        for ch, c in per.items():
            if ch == "hyperliquid":
                if (c.get("fills_recent") or 0) > 0 or (c.get("volume_usd") or 0) > 0:
                    chains.add(ch); tchains.add(ch)
                hl_vol += c.get("volume_usd") or 0; hl_fills += c.get("fills_recent") or 0
                continue
            if c.get("first_ts"):
                firsts.append(c["first_ts"])
            if (c.get("sent") or 0) > 0:
                chains.add(ch)
            sent += c.get("sent") or 0
            swaps += c.get("swaps_est") or 0
            if (c.get("swaps_est") or 0) > 0:
                tchains.add(ch)
            held += c.get("tokens_held_10usd") or 0
    for s in sol.values():
        if s.get("_error"):
            continue
        if s.get("first_ts") and not s.get("sigs_capped"):
            firsts.append(s["first_ts"])
        if (s.get("sigs") or 0) > 0:
            chains.add("solana")
        sent += s.get("sigs") or 0
        if s.get("sample_seen") is not None and s["sample_seen"] < 50:
            s = {**s, "swaps": None}  # замала вибірка: прогалина, а не нуль
        if s.get("swaps") is None:
            gap = True
        swaps += s.get("swaps") or 0
        if (s.get("swaps") or 0) > 0:
            tchains.add("solana")
        held += s.get("tokens_held_10usd") or 0
    return {"age_years": years(min(firsts)) if firsts else None, "tx": sent, "chains": sorted(chains),
            "trades": swaps + hl_fills, "trade_chains": sorted(tchains), "hl_volume": hl_vol, "held": held,
            "trade_gap": gap}


def src_onchain(w):
    if not w:
        return None
    return combine([(35, lin(w["age_years"], 7) if w["age_years"] is not None else None),
                    (35, logn(w["tx"], 20000)), (30, lin(len(w["chains"]), 6))])


def src_trading(w):
    if not w:
        return None
    if not w["trades"]:
        return None if w.get("trade_gap") else 0.0
    return combine([(45, logn(w["trades"], 5000)), (20, lin(len(w["trade_chains"]), 4)),
                    (20, logn(w["hl_volume"], 10_000_000)), (15, logn(w["held"], 30))])


def src_site(s):
    if not s or not s.get("reachable"):
        return None
    return 20 + 0.8 * (combine([(40, logn(s.get("feed_items"), 200)), (25, lin(s.get("items_90d"), 12)),
                                (15, logn(s.get("sitemap_urls"), 300))]) or 0)


# Ролі: основні джерела з вагами, головні джерела (потрібне хоча б одне).
ROLES = {
    "Інженер": ({"gh_eng": 70, "onchain": 15, "x": 15}, ["gh_eng"]),
    "Аудитор безпеки": ({"gh_eng": 60, "x": 20, "site": 20}, ["gh_eng"]),
    "DevRel": ({"media": 35, "gh_eng": 35, "site": 30}, ["media", "gh_eng"]),
    "Дані, дослідження": ({"site": 35, "gh_eng": 30, "x": 20, "onchain": 15}, ["site", "gh_eng"]),
    "Продакт, проєкт-менеджер": ({"x": 35, "site": 25, "gh_builder": 25, "onchain": 15}, ["x", "site", "gh_builder"]),
    "BD, партнерства": ({"x": 60, "onchain": 20, "site": 20}, ["x"]),
    "Маркетинг, контент": ({"media": 60, "site": 30, "onchain": 10}, ["media"]),
    "Креатор, KOL": ({"media": 85, "onchain": 15}, ["media"]),
    "Ком'юніті": ({"x": 65, "onchain": 25, "site": 10}, ["x"]),
    "Трейдер": ({"trading": 70, "onchain": 15, "x": 15}, ["trading"]),
}


def score_person(r):
    w = wallets(r)
    s = {"gh_eng": src_gh_eng(r.get("gh")), "gh_builder": src_gh_builder(r.get("gh")), "x": src_x(r.get("x")),
         "yt": src_yt(r.get("yt")), "onchain": src_onchain(w), "trading": src_trading(w), "site": src_site(r.get("site"))}
    media = [v for v in (s["x"], s["yt"]) if v is not None]
    s["media"] = max(media) if media else None
    roles = {}
    for role, (weights, anchors) in ROLES.items():
        if not any(s[a] not in (None, 0.0) for a in anchors):
            roles[role] = None
            continue
        prim = sum(wt * (s[k] or 0) for k, wt in weights.items()) / sum(weights.values())
        cover = sum(wt for k, wt in weights.items() if s[k] is not None)
        roles[role] = {"score": round(0.9 * prim, 1), "cover": cover}
    return {"sources": {k: None if v is None else round(v, 1) for k, v in s.items()}, "wallet": w, "roles": roles}


if __name__ == "__main__":
    raw = json.load(open(sys.argv[1]))
    out = {pid: {"name": r["name"], **score_person(r)} for pid, r in raw.items()}
    json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
    for pid, o in out.items():
        top = sorted(((k, v["score"]) for k, v in o["roles"].items() if v), key=lambda kv: -kv[1])[:4]
        src = " ".join(f"{k}={v:.0f}" for k, v in o["sources"].items() if v is not None)
        print(f"{o['name'][:24]:<24} | {src}\n{'':24} | " + " · ".join(f"{k} {v:.0f}" for k, v in top))
