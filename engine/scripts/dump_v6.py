"""Еталонні бали Python-формули v6 для звірки з TypeScript (scripts/parity.ts).

Використання: python3 dump_v6.py <research/harness> <research/data>
Пише JSON у stdout і нічого не зберігає на диск: у даних реальні люди.
Режимів немає: у v6 немає `held`, тож Python і рушій рахують trading однаково."""
import json, os, sys

harness, data = sys.argv[1], sys.argv[2]
if len(sys.argv) > 3:
    sys.exit("режимів у v6 немає: dump_v6.py <research/harness> <research/data>")
os.environ["RAW_EXTRA"] = os.path.join(data, "raw_extra.json")
sys.path.insert(0, harness)
import score_v3  # noqa: E402
import score_v6  # noqa: E402

raw = json.load(open(os.path.join(data, "raw_all.json")))
out = {"now": score_v3.NOW, "people": {}}
for pid, r in raw.items():
    sc = score_v6.score_person(r)
    out["people"][pid] = {"sources": sc["sources"], "roles": sc["roles"]}
json.dump(out, sys.stdout)
