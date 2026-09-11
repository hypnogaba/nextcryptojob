"""Перезбір EVM для всіх людей: Etherscan для Ethereum і Arbitrum, Blockscout для Base і Optimism."""
import json, sys, time
from concurrent.futures import ThreadPoolExecutor
import collect_fast as F

path, people_path = sys.argv[1], sys.argv[2]
raw = json.load(open(path))
people = {p["id"]: p for p in json.load(open(people_path))}
t0 = time.time()
for pid, r in raw.items():
    addrs = people[pid].get("evm") or []
    if not addrs:
        continue
    t = time.time()
    with F.ThreadPoolExecutor(max_workers=8) as ex:
        jobs = {(a, ch): ex.submit(F.evm_chain, ch, a) for a in addrs for ch in F.HOSTS}
        for a in addrs:
            hl = (r.get("evm") or {}).get(a, {}).get("hyperliquid")
            r["evm"][a] = F.evm_summary({ch: jobs[(a, ch)].result() for ch in F.HOSTS})
            r["evm"][a]["hyperliquid"] = hl
    errs = [f"{a[:6]}:{ch}" for a in addrs for ch, c in r["evm"][a].items() if isinstance(c, dict) and c.get("_error")]
    print(pid, f"{time.time() - t:.1f} с", {ch: (c.get("sent"), c.get("swaps_est")) for ch, c in r["evm"][addrs[0]].items() if isinstance(c, dict) and "sent" in c}, errs or "", flush=True)
    json.dump(raw, open(path, "w"), ensure_ascii=False, indent=1)
print(f"усього {time.time() - t0:.0f} с")
