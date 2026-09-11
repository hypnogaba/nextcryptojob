"""Обміни на Solana вибіркою через публічний вузол (для тесту; у продукті окремий ключ Helius).
Беремо до SAMPLE останніх успішних транзакцій, рахуємо частку обмінів, множимо на всі успішні підписи."""
import json, os, sys, time, urllib.request

RPC = "https://api.mainnet-beta.solana.com"
SAMPLE = int(os.environ.get("SOL_SAMPLE", "150"))
DEX = {
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",  # Jupiter
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",  # Raydium AMM, CLMM
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",   # Raydium CPMM, LaunchLab
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",  # Orca
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",   # Pump.fun, PumpSwap
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",  # Meteora
    "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",   # Meteora DAMM v2, DBC
}


def rpc(method, params):
    for i in range(8):
        try:
            req = urllib.request.Request(RPC, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                         headers={"Content-Type": "application/json", "User-Agent": "ncj-test"})
            d = json.loads(urllib.request.urlopen(req, timeout=30).read())
            if "result" in d:
                return d["result"]
        except Exception:
            pass
        time.sleep(1.5 * (i + 1))
    return None


def is_swap(tx, owner):
    msg = tx["transaction"]["message"]
    keys = {k["pubkey"] if isinstance(k, dict) else k for k in msg.get("accountKeys", [])}
    for ix in msg.get("instructions", []):
        if ix.get("programId") in DEX:
            return True
    for inner in (tx.get("meta") or {}).get("innerInstructions") or []:
        for ix in inner.get("instructions", []):
            if ix.get("programId") in DEX:
                return True
    if keys & DEX:
        return True
    meta = tx.get("meta") or {}
    pre = {(b["mint"]): float(b["uiTokenAmount"]["uiAmount"] or 0) for b in meta.get("preTokenBalances") or [] if b.get("owner") == owner}
    post = {(b["mint"]): float(b["uiTokenAmount"]["uiAmount"] or 0) for b in meta.get("postTokenBalances") or [] if b.get("owner") == owner}
    changed = [m for m in set(pre) | set(post) if abs(post.get(m, 0) - pre.get(m, 0)) > 1e-9]
    ups = [m for m in changed if post.get(m, 0) > pre.get(m, 0)]
    downs = [m for m in changed if post.get(m, 0) < pre.get(m, 0)]
    return bool(ups and downs)


def sample(addr):
    sigs, before = [], None
    for _ in range(10):
        res = rpc("getSignaturesForAddress", [addr, {"limit": 1000, **({"before": before} if before else {})}])
        if not res:
            break
        sigs += res; before = res[-1]["signature"]
        if len(res) < 1000:
            break
        time.sleep(0.5)
    ok = [s for s in sigs if not s.get("err")]
    picked = ok[:SAMPLE]
    swaps = seen = 0
    for s in picked:
        tx = rpc("getTransaction", [s["signature"], {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}])
        if tx:
            seen += 1; swaps += is_swap(tx, addr)
        time.sleep(0.3)
    share = swaps / seen if seen else None
    return {"sigs": len(sigs), "sigs_ok": len(ok), "sigs_capped": len(sigs) >= 10000,
            "first_ts": sigs[-1].get("blockTime") if sigs and len(sigs) < 10000 else None,
            "sample_seen": seen, "sample_swaps": swaps,
            "swaps": round(share * len(ok)) if share is not None else None,
            "swaps_method": f"вибірка {seen} останніх транзакцій"}


if __name__ == "__main__":
    path = sys.argv[1]
    raw = json.load(open(path))
    for pid, r in raw.items():
        for a in list((r.get("sol") or {}).keys()):
            t = time.time()
            r["sol"][a] = {**sample(a), "tokens_held_10usd": None}
            print(pid, a[:6], r["sol"][a]["sigs"], "підписів,", r["sol"][a]["sample_swaps"], "/", r["sol"][a]["sample_seen"], "обміни у вибірці →", r["sol"][a]["swaps"], f"({time.time() - t:.0f} с)", flush=True)
            json.dump(raw, open(path, "w"), ensure_ascii=False, indent=1)
