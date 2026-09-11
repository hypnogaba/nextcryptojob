"""Формула NextCryptoJob v4.
Зміни проти v3 (після звірки 11.09: 18% точно, 57% в межах сусіднього рівня):
- у ролі є ЯДРО (головні джерела, вага 100) і ДОДАТКИ (до +10, лише додають);
  непідключене необов'язкове джерело більше не тягне бал вниз;
- бал = ядро + додатки, не більше 100 (без множника 0,9);
- шкали джерел відкалібровано так, щоб топи галузі мали 90–100 у своєму джерелі.
Правила, що лишились: прогалина джерела не стає нулем; без головного джерела роль
не рахується; роль обирає людина."""
import json, math, sys, time
from score_v3 import logn, lin, combine, years, wallets

NOW = time.time()


def src_gh_eng(g):
    if not g or g.get("_error"):
        return None
    return combine([(35, logn(g["merged_prs_elsewhere"], 1000)), (25, logn(g["stars"], 5000)),
                    (15, logn(g["reviews_12m"], 300)), (15, logn(g["followers"], 3000)),
                    (10, logn(g["commits_12m"], 2000))])


def src_gh_builder(g):
    if not g or g.get("_error"):
        return None
    return combine([(40, lin(g["repos_pushed_12m"], 12)), (30, lin(g["repos_with_site"], 4)),
                    (30, logn(g["commits_12m"], 1500))])


def src_x(x):
    if not x or x.get("followers") is None:
        return None
    per30 = x["own"] / max(x["days_covered"], 1) * 30 if x.get("own") is not None and x.get("days_covered") else None
    return combine([(15, logn(x["followers"], 500_000)), (30, None if x.get("kol_source_gap") else logn(x.get("kol"), 1000)),
                    (15, logn(x.get("own_avg_likes_rt"), 1500)), (15, logn(x.get("own_avg_views"), 150_000)),
                    (15, logn(x.get("own_avg_replies"), 150)), (10, lin(per30, 20))])


def src_yt(y):
    if not y or y.get("_error") or y.get("subscribers") is None:
        return None
    return combine([(45, logn(y["subscribers"], 1_000_000)), (35, logn(y.get("avg_views_recent"), 100_000)),
                    (20, lin(y.get("videos_90d"), 12))])


def src_onchain(w):
    if not w:
        return None
    return combine([(35, lin(w["age_years"], 6) if w["age_years"] is not None else None),
                    (35, logn(w["tx"], 10000)), (30, lin(len(w["chains"]), 6))])


def src_trading(w):
    if not w:
        return None
    if not w["trades"]:
        return None if w.get("trade_gap") else 0.0
    return combine([(45, logn(w["trades"], 3000)), (20, lin(len(w["trade_chains"]), 4)),
                    (20, logn(w["hl_volume"], 5_000_000)), (15, logn(w["held"], 20))])


def src_site(s):
    if not s or not s.get("reachable"):
        return None
    return 30 + 0.7 * (combine([(40, logn(s.get("feed_items"), 100)), (20, lin(s.get("items_90d"), 8)),
                                (10, logn(s.get("sitemap_urls"), 150))]) or 0)


# роль: (ядро {джерело: вага}, додатки {джерело: макс. балів}, головні джерела)
ROLES = {
    "Інженер": ({"gh_eng": 80, "x": 20}, {"onchain": 5, "site": 5}, ["gh_eng"]),
    "Аудитор безпеки": ({"gh_eng": 70, "x": 30}, {"site": 5, "onchain": 5}, ["gh_eng"]),
    "DevRel": ({"media": 50, "gh_eng": 50}, {"site": 5, "onchain": 5}, ["media", "gh_eng"]),
    "Дані, дослідження": ({"output": 50, "x": 50}, {"onchain": 5, "gh_builder": 5}, ["output"]),
    "Продакт, проєкт-менеджер": ({"x": 50, "gh_builder": 25, "site": 25}, {"onchain": 5, "gh_eng": 5}, ["x"]),
    "BD, партнерства": ({"x": 100}, {"onchain": 5, "site": 5}, ["x"]),
    "Маркетинг, контент": ({"media": 100}, {"site": 7, "onchain": 3}, ["media"]),
    "Креатор, KOL": ({"media": 100}, {"onchain": 5, "site": 5}, ["media"]),
    "Ком'юніті": ({"x": 100}, {"onchain": 7, "site": 3}, ["x"]),
    "Трейдер": ({"trading": 80, "onchain": 20}, {"x": 5, "site": 5}, ["trading"]),
}


def score_person(r):
    w = wallets(r)
    s = {"gh_eng": src_gh_eng(r.get("gh")), "gh_builder": src_gh_builder(r.get("gh")), "x": src_x(r.get("x")),
         "yt": src_yt(r.get("yt")), "onchain": src_onchain(w), "trading": src_trading(w), "site": src_site(r.get("site"))}
    media = [v for v in (s["x"], s["yt"]) if v is not None]
    s["media"] = max(media) if media else None
    out_src = [v for v in (s["site"], s["gh_eng"]) if v is not None]
    s["output"] = max(out_src) if out_src else None
    roles = {}
    for role, (core, bonus, anchors) in ROLES.items():
        if not any(s[a] not in (None, 0.0) for a in anchors):
            roles[role] = None
            continue
        core_score = sum(wt * (s[k] or 0) for k, wt in core.items()) / sum(core.values())
        add = sum(mx * (s[k] or 0) / 100 for k, mx in bonus.items())
        cover = sum(wt for k, wt in core.items() if s[k] is not None)
        roles[role] = {"score": round(min(100.0, core_score + add), 1), "core": round(core_score, 1), "cover": cover}
    return {"sources": {k: None if v is None else round(v, 1) for k, v in s.items()}, "wallet": w, "roles": roles}
