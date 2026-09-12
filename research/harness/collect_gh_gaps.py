"""Дозбір GitHub для людей, у кого в основному зборі GitHub дав прогалину (_error).
Використання: python3 collect_gh_gaps.py people.json raw_all.json raw_extra.json
Пише `gh` у raw_extra.json; raw_all.json не змінює. score_v5 бере цей `gh` лише замість прогалини."""
import json, os, sys
import collect_v3 as v3

people = {p["id"]: p for p in json.load(open(sys.argv[1]))}
raw = json.load(open(sys.argv[2]))
path = sys.argv[3]
extra = json.load(open(path)) if os.path.exists(path) else {}
for pid, r in raw.items():
    g = r.get("gh")
    login = people.get(pid, {}).get("github")
    if login and (not g or g.get("_error")):
        new = v3.collect_github(login)
        extra.setdefault(pid, {})["gh"] = new
        print(pid, login, json.dumps(new, ensure_ascii=False))
        json.dump(extra, open(path, "w"), ensure_ascii=False, indent=1)
