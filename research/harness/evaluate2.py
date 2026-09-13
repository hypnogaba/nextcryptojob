"""Звірка формули з еталонним набором. Рівні на шкалі основних джерел (0–100):
A >= 80, B 60–80, C 40–60, D < 40. Бонуси (запуск, CV) у тесті не підключені."""
import json, sys
import importlib, os; S = importlib.import_module(os.environ.get("FORMULA", "score_v3"))

ROLE = {"engineer": "Інженер", "security_auditor": "Аудитор безпеки", "devrel": "DevRel",
        "data_research": "Дані, дослідження", "product_manager": "Продакт, проєкт-менеджер",
        "bd": "BD, партнерства", "marketing_content": "Маркетинг, контент", "creator_kol": "Креатор, KOL",
        "community": "Ком'юніті", "trader": "Трейдер"}
ORDER = "DCBA"


def band(x):
    return "A" if x >= 80 else "B" if x >= 60 else "C" if x >= 40 else "D"


people = {p["id"]: p for p in json.load(open(sys.argv[1]))}
raw = json.load(open(sys.argv[2]))
rows, exact, near, n, unscored = [], 0, 0, 0, 0
for pid, r in raw.items():
    p = people[pid]
    sc = S.score_person(r)
    role = ROLE.get(p["expected_role"])
    got = sc["roles"].get(role)
    top3 = [k for k, v in sorted(((k, v["score"]) for k, v in sc["roles"].items() if v), key=lambda kv: -kv[1])][:3]
    if p["expected_band"] == "?":
        rows.append((p["name"], role, "?", None, None, top3, sc["sources"])); continue
    n += 1
    if not got:
        unscored += 1
        rows.append((p["name"], role, p["expected_band"], None, "не рахується", top3, sc["sources"])); continue
    norm = got["score"] / (0.9 if S.__name__ == "score_v3" else 1.0)
    b = band(norm)
    exact += b == p["expected_band"]
    near += abs(ORDER.index(b) - ORDER.index(p["expected_band"])) <= 1
    rows.append((p["name"], role, p["expected_band"], round(norm), b, top3, sc["sources"]))

json.dump(rows, open(sys.argv[3], "w"), ensure_ascii=False, indent=1)
for name, role, exp, norm, b, top3, src in rows:
    mark = "" if exp == "?" else ("✓" if b == exp else "≈" if b and b != "не рахується" and abs(ORDER.index(b) - ORDER.index(exp)) == 1 else "✗")
    s = " ".join(f"{k}={v:.0f}" for k, v in src.items() if v is not None and k != "media")
    print(f"{mark} {name[:22]:<22} {role[:18]:<18} очік {exp} → {norm} {b} | {s}")
print(f"\nточно в рівень: {exact}/{n} ({exact * 100 // max(n, 1)}%), в межах сусіднього: {near}/{n} ({near * 100 // max(n, 1)}%), роль не рахується: {unscored}")

# Промахи на 2 рівні і трейдер L8+ (бал >= 70) у людей без мітки трейдера (головна або друга роль з
# reference_set.json поруч з people): 4 мітки трейдера замало, щоб ворота бачили зміни цієї ролі (v6).
two = sum(1 for _, _, exp, _, b, _, _ in rows
          if exp != "?" and b in ("A", "B", "C", "D") and abs(ORDER.index(b) - ORDER.index(exp)) >= 2)
_ref_path = os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), "reference_set.json")
_ref = {p["id"]: p for p in json.load(open(_ref_path))} if os.path.exists(_ref_path) else {}
l8 = 0
for pid, r in raw.items():
    p = people[pid]
    if p["expected_band"] == "?" or p["expected_role"] == "trader" or "trader" in (_ref.get(pid, {}).get("secondary_roles") or []):
        continue
    t = S.score_person(r)["roles"].get(ROLE["trader"])
    l8 += bool(t) and t["score"] >= 70
print(f"промахів на 2 рівні: {two}; трейдер L8+ без мітки трейдера: {l8}")
