"""Збір результатів аудит-конкурсів для NextCryptoJob (джерело `audits`). Лише публічні дані, лише читання.

Використання:
  python3 collect_audits.py people.json handles.json raw_extra.json [id,id,...] [--cantina]
handles.json (у теці даних, не в git): {"<id>": {"sherlock": "...", "cantina": "..."}}.
Окрім явних ніків, пробуємо логін GitHub і нік X людини, але ПРИЙМАЄМО профіль лише після перевірки:
профіль платформи вказує той самий GitHub або X, що й людина. Неперевірене не беремо.

Звідки дані (перевірено 12.09.2026, подробиці у звіті до договору):
- Sherlock (типово, єдине джерело): JSON, яким користується сам сайт audits.sherlock.xyz:
  https://mainnet-contest.sherlock.xyz/watson/<h>, /stats/stats/<h>, /stats/resume/<h>. Без ключа.
  Публічних умов, що забороняли б автоматичний доступ, немає; robots.txt нічого не закриває.
  Резюме зводить конкурси й з інших платформ (Code4rena, Cantina, Immunefi, CodeHawks), які
  людина сама привʼязала до профілю Sherlock. GitHub у профілі Sherlock підтверджено входом через GitHub.
- Cantina (лише з --cantina, «сіра зона»): сторінка https://cantina.xyz/u/<handle>; /api/ закрито
  robots.txt, його не чіпаємо. Умови (§9) прямо не забороняють, але й не дозволяють.
- Code4rena НЕ беремо напряму: умови §8(g) забороняють будь-який автоматичний доступ; платформа
  згортається з травня 2026. Її результати доходять лише через резюме Sherlock.
- Immunefi НЕ беремо напряму: умови забороняють роботів, профілі за перевіркою Cloudflare.
- Hats: застосунок вимкнено 31.12.2025.

Правило: платформа, що не відповіла, дає прогалину з причиною, а не 0. Людина без перевіреного
профілю або з профілем без жодного конкурсу дає `audits = null` (нема доказу, а не слабкий аудитор)."""
import json, os, re, sys, time, urllib.error, urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) ncj-test/0.5"}
PAUSE = 2.5  # секунд між запитами до одного хоста
_last = {}


def _wait(host):
    dt = _last.get(host, 0) + PAUSE - time.time()
    if dt > 0:
        time.sleep(dt)
    _last[host] = time.time()


def fetch(url, tries=3):
    """Повертає (status, text). 403/404 не повторюємо."""
    host = url.split("/")[2]
    err = None
    for i in range(tries):
        _wait(host)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (403, 404, 410):
                return e.code, None
            err = e.code
            time.sleep(PAUSE * (i + 2) * (3 if e.code == 429 else 1))
        except Exception as e:
            err = str(e)[:60]
            time.sleep(PAUSE * (i + 2))
    return err, None


def norm(s):
    return (s or "").strip().lower().lstrip("@").rstrip("/").split("/")[-1]


# ---------- Sherlock ----------
SH = "https://mainnet-contest.sherlock.xyz"


def sherlock_profile(handle):
    st, txt = fetch(f"{SH}/watson/{handle}")
    if st == 404:
        return {"exists": False}
    if txt is None:
        return {"_error": f"sherlock: {st}"}
    p = json.loads(txt)
    st2, stats = fetch(f"{SH}/stats/stats/{p['handle']}")
    st3, resume = fetch(f"{SH}/stats/resume/{p['handle']}")
    if stats is None or resume is None:
        return {"_error": f"sherlock stats/resume: {st2}/{st3}"}
    return {"exists": True, "handle": p["handle"], "github": norm(p.get("github_handle")), "x": norm(p.get("twitter_handle")),
            "senior": p.get("senior"), "stats": json.loads(stats), "resume": json.loads(resume)}


# ---------- Cantina (лише з --cantina) ----------
CN_KEYS = ["username", "github", "twitter", "verifiedProfile", "rank", "fellowshipLevel", "leaderboardPosition",
           "totalReward", "criticalFindings", "highFindings", "mediumFindings", "lowFindings", "rejectedFindings", "reputation"]


def rsc(html):
    """Склеює потік React Server Components (self.__next_f.push) у суцільний текст."""
    chunks = re.findall(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)</script>', html, re.S)
    return "".join(json.loads('"' + c + '"') for c in chunks)


def cantina_profile(handle):
    st, html = fetch(f"https://cantina.xyz/u/{handle}")
    if html is None:
        return {"exists": False} if st == 404 else {"_error": f"cantina: {st}"}
    s = rsc(html)
    for mm in re.finditer(r'\{"data":\{"id":"[0-9a-f-]{36}","name"', s):
        d = json.JSONDecoder().raw_decode(s, mm.start())[0]["data"]
        if "totalReward" in d:
            out = {k: d.get(k) for k in CN_KEYS}
            out.update(exists=True, handle=d["username"], github=norm(d.get("github")), x=norm(d.get("twitter")),
                       competitions=len(d.get("publicCompetitions") or []))
            return out
    return {"exists": False} if "Profile not found" in html else {"_error": "cantina: не знайшов JSON профілю"}


# ---------- зведення ----------
def first_verified(fn, cands, gh, x):
    """Перший кандидат, чий профіль вказує той самий GitHub або X, що й людина."""
    seen, notes = set(), []
    for h in cands:
        if not h or h.lower() in seen:
            continue
        seen.add(h.lower())
        p = fn(h)
        if p.get("_error"):
            notes.append(f"{h}: {p['_error']}")
            continue
        if not p.get("exists"):
            continue
        if (gh and p.get("github") == gh) or (x and p.get("x") == x):
            return {**p, "verified_by": "profile links same github/x"}, notes
        notes.append(f"{h}: профіль є, але не вказує github/x людини")
    return None, notes


def collect(p, explicit, use_cantina=False):
    gh, x = norm(p.get("github")), norm(p.get("x"))
    out = {"platforms": {}, "notes": []}
    sh, n = first_verified(sherlock_profile, [explicit.get("sherlock"), gh, x], gh, x)
    out["notes"] += n
    cn = None
    if use_cantina:
        cn, n = first_verified(cantina_profile, [explicit.get("cantina"), gh, x], gh, x)
        out["notes"] += n

    # постачальник → {earnings_usd, high, medium, contests, via}
    prov = {}
    if sh:
        for e in sh["resume"]:
            if e.get("type") != "CONTEST":
                continue
            d = prov.setdefault(e["provider"], {"earnings_usd": 0.0, "high": 0, "medium": 0, "contests": 0, "via": "sherlock_resume"})
            d["earnings_usd"] += e.get("payout") or 0
            d["contests"] += 1
            for i in e.get("issues") or []:
                sev = (i.get("severity") or "").upper()
                if sev in ("HIGH", "CRITICAL"):
                    d["high"] += 1
                elif sev == "MEDIUM":
                    d["medium"] += 1
        out["platforms"]["sherlock"] = {k: sh[k] for k in ("handle", "github", "x", "senior", "stats", "verified_by")}
    if cn:  # прямий профіль Cantina точніший за рядок Cantina в резюме Sherlock
        old = prov.get("CANTINA", {})
        prov["CANTINA"] = {"earnings_usd": float(cn["totalReward"] or 0), "high": (cn["criticalFindings"] or 0) + (cn["highFindings"] or 0),
                           "medium": cn["mediumFindings"], "contests": max(cn["competitions"], old.get("contests") or 0),
                           "via": "cantina_profile"}
        out["platforms"]["cantina"] = {k: cn[k] for k in cn if k != "exists"}
    for d in prov.values():
        d["earnings_usd"] = round(d["earnings_usd"], 2)
    out["providers"] = prov
    if not (sh or cn):
        out.update(earnings_usd=None, high=None, contests=None, gap="немає перевіреного профілю Sherlock" + ("/Cantina" if use_cantina else ""))
        return out
    out["earnings_usd"] = round(sum(d["earnings_usd"] or 0 for d in prov.values()), 2)
    out["high"] = sum(d["high"] or 0 for d in prov.values())
    out["contests"] = sum(d.get("contests") or 0 for d in prov.values())
    if not (out["earnings_usd"] > 0 or out["high"] > 0 or out["contests"] > 0):
        out["gap"] = "профіль є, але жодного конкурсу: це не доказ слабкості"
    return out


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    use_cantina = "--cantina" in sys.argv
    people = json.load(open(args[0]))
    handles = json.load(open(args[1])) if os.path.exists(args[1]) else {}
    path = args[2]
    extra = json.load(open(path)) if os.path.exists(path) else {}
    only = set(args[3].split(",")) if len(args) > 3 else None
    for p in people:
        if only and p["id"] not in only:
            continue
        if not only and p["expected_role"] != "security_auditor" and p["id"] not in handles:
            continue
        a = collect(p, handles.get(p["id"], {}), use_cantina)
        a["fetched_at"] = int(time.time())
        extra.setdefault(p["id"], {})["audits"] = a
        print(p["id"], json.dumps({k: a.get(k) for k in ("earnings_usd", "high", "contests", "gap")}, ensure_ascii=False),
              {k: v.get("verified_by") for k, v in a["platforms"].items()}, a["notes"] or "")
        json.dump(extra, open(path, "w"), ensure_ascii=False, indent=1)
