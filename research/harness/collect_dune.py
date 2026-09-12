"""Збір для джерела `dune` (NextCryptoJob). Лише публічні дані, лише читання.

Використання: python3 collect_dune.py people.json raw_extra.json [id,id,...]

Що можна взяти законно (перевірено 12.09.2026):
- Профіль dune.com (дашборди, запити, зірки): офіційного API для чужого профілю немає
  (api.dune.com віддає лише запити власника ключа), сторінки dune.com закриті перевіркою Cloudflare,
  внутрішній GraphQL віддає 403. Обходити захист не будемо, тому ці поля = null з причиною.
- Spellbook (github.com/duneanalytics/spellbook): відкрите сховище Dune, куди аналітики
  здають SQL-моделі («спели»), з яких будуються таблиці Dune. Злиті PR людини туди = перевірена
  інженерна праця з даними. Беремо через GitHub API (gh CLI), як і решту GitHub.
"""
import json, os, subprocess, sys, time

NOW = time.time()
REPO = "duneanalytics/spellbook"


def gh_count(q):
    for i in range(3):
        r = subprocess.run(["gh", "api", "-X", "GET", "search/issues", "-f", f"q={q}", "-f", "per_page=1"],
                           capture_output=True, text=True)
        time.sleep(2.5)  # пошук GitHub: 30 запитів на хвилину
        if r.returncode == 0:
            return json.loads(r.stdout).get("total_count")
        time.sleep(20 * (i + 1))
    return None


def collect(login):
    year_ago = time.strftime("%Y-%m-%d", time.gmtime(NOW - 365 * 86400))
    prs = gh_count(f"repo:{REPO} is:pr is:merged author:{login}")
    prs12 = gh_count(f"repo:{REPO} is:pr is:merged author:{login} merged:>={year_ago}") if prs else (0 if prs == 0 else None)
    return {"spellbook_prs": prs, "spellbook_prs_12m": prs12,
            "dashboards": None, "queries": None, "stars": None,
            "profile_gap": "dune.com: немає офіційного API профілю, сайт за перевіркою Cloudflare",
            "_error": None if prs is not None else "GitHub search не відповів", "fetched_at": int(NOW)}


if __name__ == "__main__":
    people = json.load(open(sys.argv[1]))
    path = sys.argv[2]
    extra = json.load(open(path)) if os.path.exists(path) else {}
    only = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else None
    for p in people:
        if not p.get("github") or (only and p["id"] not in only):
            continue
        d = collect(p["github"])
        extra.setdefault(p["id"], {})["dune"] = d
        print(p["id"], p["github"], d["spellbook_prs"], d["spellbook_prs_12m"], d["_error"] or "")
        json.dump(extra, open(path, "w"), ensure_ascii=False, indent=1)
