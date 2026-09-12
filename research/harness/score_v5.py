"""Формула NextCryptoJob v5 = v4 + два нові джерела для слабких ролей (звірка 12.09.2026).

Зміни проти v4:
1. Джерело `audits` (0–100) з результатів аудит-конкурсів (collect_audits.py: профіль Sherlock і його
   резюме, що зводить Code4rena, Cantina, Immunefi, CodeHawks, привʼязані людиною):
     audits = combine(60·logn(earnings_usd/1000, 1000), 40·logn(high, 150))
   Заробіток рахуємо в тисячах доларів: до $1k це шум, $1M+ = вершина галузі (100). 150 підтверджених
   High = вершина. Профіль без жодного конкурсу або без профілю → null (нема доказу, а не нуль).
2. Аудитор безпеки має два шляхи доказів, береться сильніший:
     з конкурсами:  audits 60, gh_eng 25, x 15
     без конкурсів: gh_eng 70, x 30 (ядро v4)
   Головні джерела: audits або gh_eng. Сильніший шлях, бо конкурси лише одна з кар'єр аудитора
   (приватні аудити, bug bounty, дослідження їх не мають), і привʼязаний слабкий рекорд не має
   карати більше, ніж неприв'язаний: інакше вигідно ховати дані.
3. Джерело `dune` з відкритого сховища Dune spellbook (злиті PR людини, collect_dune.py):
     dune = combine(70·logn(spellbook_prs, 300), 30·logn(spellbook_prs_12m, 50)); 0 PR → null
   300 PR ≈ п'ятірка найбільших зовнішніх авторів spellbook. Профіль dune.com (дашборди, зірки)
   недоступний законно, тому ці поля = прогалина. output = max(site, gh_eng, dune).
4. Дані, дослідження: X теж головне джерело. Якщо output = null (ні сайту, ні GitHub, ні Dune),
   бал = 0.8·x (+ додатки): праця дослідника в X видна лише через відгук аудиторії, тож знижка 20%
   за неперевірений результат; без output роль не сягає A, доки x < 100.
Правила v4 лишаються: прогалина не нуль; додатки лише додають; бал = ядро + додатки ≤ 100."""
import json, os, sys
import score_v4 as v4
from score_v3 import logn, combine, wallets


def src_audits(a):
    if not a or a.get("gap") or a.get("earnings_usd") is None:
        return None
    return combine([(60, logn(a["earnings_usd"] / 1000, 1000)), (40, logn(a.get("high"), 150))])


def src_dune(d):
    if not d or d.get("_error") or not d.get("spellbook_prs"):
        return None
    return combine([(70, logn(d["spellbook_prs"], 300)), (30, logn(d.get("spellbook_prs_12m"), 50))])


X_ONLY_FACTOR = 0.8

# роль: (ядро, додатки, головні, запасне ядро на випадок, коли перше джерело ядра = null)
ROLES = {r: (core, bonus, anchors, None) for r, (core, bonus, anchors) in v4.ROLES.items()}
ROLES["Аудитор безпеки"] = ({"audits": 60, "gh_eng": 25, "x": 15}, {"site": 5, "onchain": 5}, ["audits", "gh_eng"],
                            {"gh_eng": 70, "x": 30})
ROLES["Дані, дослідження"] = ({"output": 50, "x": 50}, {"onchain": 5, "gh_builder": 5}, ["output", "x"], None)


def _extra_path():
    if os.environ.get("RAW_EXTRA"):
        return os.environ["RAW_EXTRA"]
    if len(sys.argv) > 2:  # evaluate2.py: argv[2] = raw_all.json, raw_extra.json лежить поруч
        return os.path.join(os.path.dirname(os.path.abspath(sys.argv[2])), "raw_extra.json")
    return None


_P = _extra_path()
EXTRA = json.load(open(_P)) if _P and os.path.exists(_P) else {}


def merged(r):
    """Додає до сирого запису людини дані з raw_extra.json: audits, dune і gh лише замість прогалини."""
    e = EXTRA.get(r.get("id"), {})
    r = dict(r)
    for k in ("audits", "dune"):
        if r.get(k) is None and e.get(k) is not None:
            r[k] = e[k]
    if (not r.get("gh") or r["gh"].get("_error")) and e.get("gh") and not e["gh"].get("_error"):
        r["gh"] = e["gh"]
    return r


def _core(core, s):
    return sum(wt * (s[k] or 0) for k, wt in core.items()) / sum(core.values()), sum(wt for k, wt in core.items() if s[k] is not None)


def score_person(r):
    r = merged(r)
    w = wallets(r)
    s = {"gh_eng": v4.src_gh_eng(r.get("gh")), "gh_builder": v4.src_gh_builder(r.get("gh")), "x": v4.src_x(r.get("x")),
         "yt": v4.src_yt(r.get("yt")), "onchain": v4.src_onchain(w), "trading": v4.src_trading(w),
         "site": v4.src_site(r.get("site")), "audits": src_audits(r.get("audits")), "dune": src_dune(r.get("dune"))}
    media = [v for v in (s["x"], s["yt"]) if v is not None]
    s["media"] = max(media) if media else None
    out_src = [v for v in (s["site"], s["gh_eng"], s["dune"]) if v is not None]
    s["output"] = max(out_src) if out_src else None
    roles = {}
    for role, (core, bonus, anchors, alt) in ROLES.items():
        if not any(s[a] not in (None, 0.0) for a in anchors):
            roles[role] = None
            continue
        reason = None
        core_score, cover = _core(core, s)
        if alt is not None:  # два шляхи доказів: беремо сильніший
            alt_score, alt_cover = _core(alt, s)
            if alt_score > core_score:
                core_score, cover, reason = alt_score, alt_cover, "path:" + "+".join(alt)
        if role == "Дані, дослідження" and s["output"] is None:
            core_score, cover, reason = X_ONLY_FACTOR * (s["x"] or 0), core["x"], "x_only"
        add = sum(mx * (s[k] or 0) / 100 for k, mx in bonus.items())
        roles[role] = {"score": round(min(100.0, core_score + add), 1), "core": round(core_score, 1), "cover": cover,
                       "reason": reason}
    return {"sources": {k: None if v is None else round(v, 1) for k, v in s.items()}, "wallet": w, "roles": roles}
