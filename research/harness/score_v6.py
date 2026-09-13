"""Формула NextCryptoJob v6 = v5 + нова роль «Трейдер» (калібрування 13.09.2026,
research/trader-calibration-2026-09-13.md, варіант C «розмір замість широти»).

Зміни проти v5:
1. Джерело `trading` зібране з трьох фактів, які ми справді збираємо:
     trading = combine(60·logn(trades, 10000), 10·lin(|tradeChains|, 6), 30·logn(hlVolume, 1000000000))
   Угоди 60: єдиний факт, що відділяє трейдерів від решти; 10 000 = стеля збирачів (10 000 підписів
   Solana, 10 000 tx на мережу EVM). Обсяг Hyperliquid 30: єдиний факт розміру; $1 млрд = рівень топів.
   Мережі угод 10, lin до 6 = усі мережі збирача.
2. `held` прибрано. У v5 його не збирали: гармошка рахувала 0, а рушій null, і null у combine мовчки
   ділив решту на 85 замість 100. Тепер обидва рахують однаково, без режимів.
3. Трейдер: ядро trading 90, onchain 10 (onchain однаковий у трейдерів і не-трейдерів еталону).
Решта v5 без змін: джерела, ролі, два шляхи аудитора, x_only дослідника, додатки, якорі."""
import score_v4 as v4
import score_v5 as v5
from score_v3 import combine, lin, logn, wallets

merged = v5.merged
EXTRA = v5.EXTRA
X_ONLY_FACTOR = v5.X_ONLY_FACTOR


def src_trading(w):
    if not w:
        return None
    if not w["trades"]:
        return None if w.get("trade_gap") else 0.0
    return combine([(60, logn(w["trades"], 10_000)), (10, lin(len(w["trade_chains"]), 6)),
                    (30, logn(w["hl_volume"], 1_000_000_000))])


ROLES = dict(v5.ROLES)
ROLES["Трейдер"] = ({"trading": 90, "onchain": 10}, {"x": 5, "site": 5}, ["trading"], None)


def score_person(r):
    r = merged(r)
    w = wallets(r)
    s = {"gh_eng": v4.src_gh_eng(r.get("gh")), "gh_builder": v4.src_gh_builder(r.get("gh")), "x": v4.src_x(r.get("x")),
         "yt": v4.src_yt(r.get("yt")), "onchain": v4.src_onchain(w), "trading": src_trading(w),
         "site": v4.src_site(r.get("site")), "audits": v5.src_audits(r.get("audits")), "dune": v5.src_dune(r.get("dune"))}
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
        core_score, cover = v5._core(core, s)
        if alt is not None:  # два шляхи доказів: беремо сильніший
            alt_score, alt_cover = v5._core(alt, s)
            if alt_score > core_score:
                core_score, cover, reason = alt_score, alt_cover, "path:" + "+".join(alt)
        if role == "Дані, дослідження" and s["output"] is None:
            core_score, cover, reason = X_ONLY_FACTOR * (s["x"] or 0), core["x"], "x_only"
        add = sum(mx * (s[k] or 0) / 100 for k, mx in bonus.items())
        roles[role] = {"score": round(min(100.0, core_score + add), 1), "core": round(core_score, 1), "cover": cover,
                       "reason": reason}
    return {"sources": {k: None if v is None else round(v, 1) for k, v in s.items()}, "wallet": w, "roles": roles}
