"""Еталонні бали Python-формули v5 для звірки з TypeScript (scripts/parity.ts).

Використання: python3 dump_v5.py <research/harness> <research/data> [as_is|held_null]
Пише JSON у stdout і нічого не зберігає на диск: у даних реальні люди.
held_null: held = null замість 0, як у договорі §4 («held у релізі 1 = null»)."""
import json, os, sys

harness, data = sys.argv[1], sys.argv[2]
mode = sys.argv[3] if len(sys.argv) > 3 else "as_is"
os.environ["RAW_EXTRA"] = os.path.join(data, "raw_extra.json")
sys.path.insert(0, harness)
import score_v3  # noqa: E402
import score_v5  # noqa: E402

if mode == "held_null":
    _wallets = score_v5.wallets

    def _held_null(r):
        w = _wallets(r)
        if w:
            w["held"] = None
        return w

    score_v5.wallets = _held_null
elif mode != "as_is":
    sys.exit(f"невідомий режим: {mode}")

raw = json.load(open(os.path.join(data, "raw_all.json")))
out = {"now": score_v3.NOW, "people": {}}
for pid, r in raw.items():
    sc = score_v5.score_person(r)
    out["people"][pid] = {"sources": sc["sources"], "roles": sc["roles"]}
json.dump(out, sys.stdout)
