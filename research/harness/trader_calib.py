"""Калібрування ролі «Трейдер» (дослідження 13.09.2026, звіт research/trader-calibration-2026-09-13.md).

Запуск: python3 trader_calib.py ../data
Друкує лише зведені числа. Рядки про окремих людей пише в ../data/trader_calib_2026-09-13.json
(research/data/ у .gitignore: це реальні люди). У цьому файлі немає імен і ніків.

Кожен варіант міняє лише роль «Трейдер» (джерело trading і ядро ролі); решта ролей рахується
score_v5 без змін. Власник = єдиний рядок еталону з expected_band '?'."""
import json, math, os, sys

DATA = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "data"))
os.environ["RAW_EXTRA"] = os.path.join(DATA, "raw_extra.json")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score_v3 as V3  # noqa: E402
import score_v5 as S  # noqa: E402
from score_v3 import logn, lin, combine  # noqa: E402

ROLE = {"engineer": "Інженер", "security_auditor": "Аудитор безпеки", "devrel": "DevRel",
        "data_research": "Дані, дослідження", "product_manager": "Продакт, проєкт-менеджер",
        "bd": "BD, партнерства", "marketing_content": "Маркетинг, контент", "creator_kol": "Креатор, KOL",
        "community": "Ком'юніті", "trader": "Трейдер"}
ORDER = "DCBA"
TRADER = "Трейдер"


def band(x):
    return "A" if x >= 80 else "B" if x >= 60 else "C" if x >= 40 else "D"


def level(x):
    return min(10, math.floor(x / 10) + 1)


# Власник, живий прогін рушія 12.09.2026: 342 угоди, 5 мереж угод, $36.7k Hyperliquid, onchain з 2021.
# onchain: 6 мереж, вік 5.59 р., tx ~8300 дають onchain 96.9, і тоді v5 (held = null) = 85.8, як на проді.
OWNER_LIVE = {"trades": 342, "trade_chains": ["arbitrum", "base", "ethereum", "hyperliquid", "optimism"],
              "hl_volume": 36710.29, "held": None, "trade_gap": False, "age_years": 5.59, "tx": 8300,
              "chains": ["arbitrum", "base", "ethereum", "hyperliquid", "optimism", "solana"]}


def onchain(w):
    return S.v4.src_onchain(w)


# ---------- варіанти trading ----------
def trading_v5(w, held_mode):
    """held_mode: 'zero' = як у гармошці звірки (held = 0), 'null' = як у рушії (held випадає)."""
    if not w:
        return None
    if not w["trades"]:
        return None if w.get("trade_gap") else 0.0
    held = 0 if held_mode == "zero" else None
    return combine([(45, logn(w["trades"], 3000)), (20, lin(len(w["trade_chains"]), 4)),
                    (20, logn(w["hl_volume"], 5_000_000)), (15, None if held is None else logn(held, 20))])


def trading_generic(w, wt_trades, cap_trades, wt_ch, cap_ch, wt_hl, cap_hl):
    if not w:
        return None
    if not w["trades"]:
        return None if w.get("trade_gap") else 0.0
    return combine([(wt_trades, logn(w["trades"], cap_trades)), (wt_ch, lin(len(w["trade_chains"]), cap_ch)),
                    (wt_hl, logn(w["hl_volume"], cap_hl))])


def size_proven(w, min_trades, min_hl):
    return bool(w) and ((w["trades"] or 0) >= min_trades or (w["hl_volume"] or 0) >= min_hl)


# Варіант: (опис, trading(w), ядро ролі, додатки, стеля без доказу розміру або None)
V = {}
V["v5_gate"] = ("v5 як у звірці 12.09 (held = 0)", lambda w: trading_v5(w, "zero"),
                {"trading": 80, "onchain": 20}, {"x": 5, "site": 5}, None)
V["v5_prod"] = ("v5 як на проді (held = null випадає)", lambda w: trading_v5(w, "null"),
                {"trading": 80, "onchain": 20}, {"x": 5, "site": 5}, None)
# A. Лише шкали: мережі lin 6, угоди cap 10000, обсяг cap $1B; held прибрано з формули.
V["A_scales"] = ("A: held прибрано; 45/20/20 -> угоди cap 10k, мережі lin 6, обсяг cap $1B",
                 lambda w: trading_generic(w, 45, 10_000, 20, 6, 20, 1e9),
                 {"trading": 80, "onchain": 20}, {"x": 5, "site": 5}, None)
# B. held як нуль, доки не збираємо (штраф покриття), + мережі lin 6.
V["B_heldzero"] = ("B: held = 0 до збору (штраф покриття) + мережі lin 6",
                   lambda w: (None if not w else (None if not w["trades"] and w.get("trade_gap") else
                              0.0 if not w["trades"] else
                              combine([(45, logn(w["trades"], 3000)), (20, lin(len(w["trade_chains"]), 6)),
                                       (20, logn(w["hl_volume"], 5_000_000)), (15, 0.0)]))),
                   {"trading": 80, "onchain": 20}, {"x": 5, "site": 5}, None)
# C. Розмір замість широти: угоди 60 (cap 10k), обсяг 30 (cap $1B), мережі 10 (lin 6); ядро trading 90, onchain 10.
V["C_size"] = ("C: угоди 60 cap 10k, обсяг 30 cap $1B, мережі 10 lin 6; ядро trading 90 + onchain 10",
               lambda w: trading_generic(w, 60, 10_000, 10, 6, 30, 1e9),
               {"trading": 90, "onchain": 10}, {"x": 5, "site": 5}, None)
# D. Поріг розміру: v5 прод, але рівень 8+ (бал >= 70) лише з 1000+ угод або $1M+ обсягу Hyperliquid.
V["D_gate"] = ("D: v5 прод + стеля 69.9 без 1000 угод або $1M обсягу",
               lambda w: trading_v5(w, "null"), {"trading": 80, "onchain": 20}, {"x": 5, "site": 5}, (1000, 1e6))
# E = C + поріг розміру D.
V["E_size_gate"] = ("E: C + стеля 69.9 без 1000 угод або $1M обсягу",
                    lambda w: trading_generic(w, 60, 10_000, 10, 6, 30, 1e9),
                    {"trading": 90, "onchain": 10}, {"x": 5, "site": 5}, (1000, 1e6))
# Одна ручка на проді (held = null): лише мережі lin 6; лише угоди cap 10k.
V["S1_chains6"] = ("S1: v5 прод, лише мережі lin 6", lambda w: trading_generic(w, 45, 3000, 20, 6, 20, 5_000_000),
                   {"trading": 80, "onchain": 20}, {"x": 5, "site": 5}, None)
V["S2_trades10k"] = ("S2: v5 прод, лише угоди cap 10k", lambda w: trading_generic(w, 45, 10_000, 20, 4, 20, 5_000_000),
                     {"trading": 80, "onchain": 20}, {"x": 5, "site": 5}, None)
# Чутливість: окремі кроки C.
V["C1_weights_only"] = ("C1: лише ваги trading 60/10/30 (старі шкали 3000, lin 4, $5M), ядро 80/20",
                        lambda w: trading_generic(w, 60, 3000, 10, 4, 30, 5_000_000),
                        {"trading": 80, "onchain": 20}, {"x": 5, "site": 5}, None)
V["C2_trading_only"] = ("C2: trading як у C, ядро лишається 80/20",
                        lambda w: trading_generic(w, 60, 10_000, 10, 6, 30, 1e9),
                        {"trading": 80, "onchain": 20}, {"x": 5, "site": 5}, None)
V["C3_core_only"] = ("C3: лише ядро 90/10 (trading v5 прод)", lambda w: trading_v5(w, "null"),
                     {"trading": 90, "onchain": 10}, {"x": 5, "site": 5}, None)


def trader_score(w, x, site, variant, onchain_override=None):
    _, tfun, core, bonus, gate = V[variant]
    s = {"trading": tfun(w), "onchain": onchain_override if onchain_override is not None else onchain(w), "x": x, "site": site}
    if s["trading"] in (None, 0.0):
        return None, s
    core_v = sum(wt * (s[k] or 0) for k, wt in core.items()) / sum(core.values())
    add = sum(mx * (s[k] or 0) / 100 for k, mx in bonus.items())
    sc = min(100.0, core_v + add)
    if gate and not size_proven(w, *gate):
        sc = min(sc, 69.9)
    return round(sc, 1), s


def main():
    people = {p["id"]: p for p in json.load(open(os.path.join(DATA, "people_all.json")))}
    ref = {p["id"]: p for p in json.load(open(os.path.join(DATA, "reference_set.json")))}
    raw = json.load(open(os.path.join(DATA, "raw_all.json")))
    base = {pid: S.score_person(r) for pid, r in raw.items()}
    wal = {pid: V3.wallets(S.merged(r)) for pid, r in raw.items()}
    owner = next(pid for pid, p in people.items() if p["expected_band"] == "?")

    def trader_label(pid):
        p = people[pid]
        return p["expected_role"] == "trader" or "trader" in (ref.get(pid, {}).get("secondary_roles") or [])

    per_person, summary = {}, {}
    for vk, (desc, *_rest) in V.items():
        exact = near = n = unscored = 0
        two_level, trader_rows = [], []
        dist, l8_untagged, l8_total = {}, 0, 0
        for pid, r in raw.items():
            p, sc = people[pid], base[pid]
            src = sc["sources"]
            ts, tsrc = trader_score(wal[pid], src["x"], src["site"], vk)
            per_person.setdefault(pid, {"expected": [p["expected_role"], p["expected_band"]]})[vk] = {
                "trader": ts, "trading": None if tsrc["trading"] is None else round(tsrc["trading"], 1),
                "onchain": src["onchain"]}
            if ts is not None and pid != owner:
                lv = level(ts)
                dist[lv] = dist.get(lv, 0) + 1
                if lv >= 8:
                    l8_total += 1
                    l8_untagged += not trader_label(pid)
            if p["expected_band"] == "?":
                continue
            n += 1
            role = ROLE[p["expected_role"]]
            got = ts if role == TRADER else (sc["roles"][role] or {}).get("score")
            if got is None:
                unscored += 1
                if role == TRADER:
                    trader_rows.append((p["expected_band"], None))
                continue
            b = band(got)
            exact += b == p["expected_band"]
            d = abs(ORDER.index(b) - ORDER.index(p["expected_band"]))
            near += d <= 1
            if d >= 2:
                two_level.append(role == TRADER)
            if role == TRADER:
                trader_rows.append((p["expected_band"], b))
        o_src = base[owner]["sources"]
        owner_cached, _ = trader_score(wal[owner], o_src["x"], o_src["site"], vk)
        owner_live, olsrc = trader_score(OWNER_LIVE, o_src["x"], o_src["site"], vk, onchain_override=onchain(OWNER_LIVE))
        owner_next = max(v["score"] for k, v in base[owner]["roles"].items() if v and k != TRADER)
        summary[vk] = {"desc": desc, "n": n, "exact": exact, "near": near, "unscored": unscored,
                       "two_level": len(two_level), "two_level_trader": sum(two_level),
                       "trader_rows": sorted(trader_rows, key=lambda t: t[0]), "dist": dict(sorted(dist.items())),
                       "l8": l8_total, "l8_no_trader_label": l8_untagged,
                       "owner_cached": owner_cached, "owner_live": owner_live,
                       "owner_live_trading": round(olsrc["trading"], 1), "owner_next_role": owner_next}

    json.dump({"per_person": per_person, "summary": summary}, open(os.path.join(DATA, "trader_calib_2026-09-13.json"), "w"),
              ensure_ascii=False, indent=1)
    scored = sum(1 for pid in raw if pid != owner and summary and per_person[pid]["v5_prod"]["trader"] is not None)
    print(f"людей з балом трейдера (без власника): {scored}; позначених трейдером (головна або друга роль): "
          f"{sum(trader_label(pid) for pid in raw)}")
    print(f"{'варіант':<16} {'точно':>7} {'сусід':>9} {'2рівні':>6} {'2р.трейд':>8} {'без балу':>8} "
          f"{'L8+':>4} {'L8+ без мітки':>13} {'власн.кеш':>9} {'власн.живий':>11}  рядки трейдерів (очік->отр)")
    for vk, s in summary.items():
        rows = " ".join(f"{e}->{g or '-'}" for e, g in s["trader_rows"])
        print(f"{vk:<16} {s['exact']:>3}/{s['n']} {s['near']:>3}/{s['n']} {100 * s['near'] / s['n']:>3.0f}% {s['two_level']:>6} "
              f"{s['two_level_trader']:>8} {s['unscored']:>8} {s['l8']:>4} {s['l8_no_trader_label']:>13} "
              f"{s['owner_cached']:>9} {s['owner_live']:>11}  {rows}")
    print("\nрозподіл рівнів трейдера (без власника):")
    for vk, s in summary.items():
        print(f"  {vk:<16} " + " ".join(f"L{k}:{v}" for k, v in s["dist"].items()))
    print(f"\nвласник, наступна роль (не трейдер): {summary['v5_prod']['owner_next_role']}")
    for vk, s in summary.items():
        print(f"  {vk:<16} {s['desc']}")


def separation():
    """Чи відрізняють факти позначених трейдерів від решти людей з балом трейдера (середні, без імен)."""
    people = {p["id"]: p for p in json.load(open(os.path.join(DATA, "people_all.json")))}
    ref = {p["id"]: p for p in json.load(open(os.path.join(DATA, "reference_set.json")))}
    raw = json.load(open(os.path.join(DATA, "raw_all.json")))
    groups = {True: [], False: []}
    for pid, r in raw.items():
        if people[pid]["expected_band"] == "?":
            continue
        w = V3.wallets(S.merged(r))
        if not w or not w["trades"]:
            continue
        lab = people[pid]["expected_role"] == "trader" or "trader" in (ref.get(pid, {}).get("secondary_roles") or [])
        groups[lab].append({"onchain": onchain(w), "trade_chains": len(w["trade_chains"]), "trades": w["trades"],
                            "hl_pos": (w["hl_volume"] or 0) > 0})
    for lab, rows in groups.items():
        m = lambda k: sum(x[k] for x in rows) / len(rows)
        med = sorted(x["trades"] for x in rows)[len(rows) // 2]
        print(f"  {'мітка трейдера' if lab else 'без мітки':<15} n={len(rows):>2}  onchain сер.={m('onchain'):5.1f}  "
              f"мереж угод сер.={m('trade_chains'):.2f}  угод медіана={med}  з обсягом HL={sum(x['hl_pos'] for x in rows)}")


def grid():
    """Чутливість варіанта C: чи тримається результат, якщо рухати константи (не підгонка під людей)."""
    weights = [(50, 20, 30), (55, 15, 30), (60, 10, 30), (60, 20, 20), (65, 10, 25), (70, 10, 20), (50, 10, 40)]
    caps_t, caps_v, cores = [5000, 10_000, 20_000], [1e8, 1e9, 1e10], [(80, 20), (90, 10), (100, 0)]
    res = []
    for wt in weights:
        for ct in caps_t:
            for cv in caps_v:
                for co in cores:
                    V["_g"] = ("grid", (lambda wt=wt, ct=ct, cv=cv: lambda w: trading_generic(w, wt[0], ct, wt[1], 6, wt[2], cv))(),
                               {"trading": co[0], "onchain": co[1]} if co[1] else {"trading": 100}, {"x": 5, "site": 5}, None)
                    res.append(((wt, ct, cv, co), eval_variant("_g")))
    ok = [r for r in res if r[1]["near"] >= 42 and r[1]["two_level_trader"] == 0]
    print(f"  точок сітки: {len(res)}; з сусіднім >= 42/49 і без промахів трейдера на 2 рівні: {len(ok)}")
    for key in ("exact", "l8_no_trader_label", "owner_live"):
        vals = sorted(r[1][key] for r in res)
        print(f"  {key:<20} мін {vals[0]}  медіана {vals[len(vals) // 2]}  макс {vals[-1]}")
    core90 = [r for r in res if r[0][3] == (90, 10)]
    ol = sorted(r[1]["owner_live"] for r in core90)
    print(f"  лише ядро 90/10 ({len(core90)} точок): власник живий {ol[0]}..{ol[-1]}, "
          f"L8+ без мітки макс {max(r[1]['l8_no_trader_label'] for r in core90)}, сусід мін {min(r[1]['near'] for r in core90)}/49")
    bad = [r for r in res if r[1]["two_level_trader"]]
    if bad:
        print(f"  промах трейдера на 2 рівні в {len(bad)} точках, напр. ваги/cap: " +
              "; ".join(f"{b[0][0]} cap {b[0][1]} ${b[0][2]:.0e} ядро {b[0][3]}" for b in bad[:4]))


def eval_variant(vk):
    """Короткий прогін одного варіанта (ті самі правила, що в main)."""
    people = {p["id"]: p for p in json.load(open(os.path.join(DATA, "people_all.json")))}
    ref = {p["id"]: p for p in json.load(open(os.path.join(DATA, "reference_set.json")))}
    raw = json.load(open(os.path.join(DATA, "raw_all.json")))
    global _CACHE
    if "_CACHE" not in globals():
        _CACHE = ({pid: S.score_person(r) for pid, r in raw.items()}, {pid: V3.wallets(S.merged(r)) for pid, r in raw.items()})
    base, wal = _CACHE
    owner = next(pid for pid, p in people.items() if p["expected_band"] == "?")
    out = {"exact": 0, "near": 0, "two_level_trader": 0, "l8_no_trader_label": 0}
    for pid in raw:
        p, sc = people[pid], base[pid]
        ts, _ = trader_score(wal[pid], sc["sources"]["x"], sc["sources"]["site"], vk)
        lab = p["expected_role"] == "trader" or "trader" in (ref.get(pid, {}).get("secondary_roles") or [])
        if ts is not None and pid != owner and ts >= 70 and not lab:
            out["l8_no_trader_label"] += 1
        if p["expected_band"] == "?":
            continue
        role = ROLE[p["expected_role"]]
        got = ts if role == TRADER else (sc["roles"][role] or {}).get("score")
        if got is None:
            continue
        d = abs(ORDER.index(band(got)) - ORDER.index(p["expected_band"]))
        out["exact"] += d == 0
        out["near"] += d <= 1
        out["two_level_trader"] += d >= 2 and role == TRADER
    o = base[owner]["sources"]
    out["owner_live"], _ = trader_score(OWNER_LIVE, o["x"], o["site"], vk, onchain_override=onchain(OWNER_LIVE))
    return out


if __name__ == "__main__":
    main()
    print("\nрозділення фактів (люди з угодами, без власника):")
    separation()
    print("\nчутливість варіанта C:")
    grid()
