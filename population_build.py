#!/usr/bin/env python3
# Génère population.json = { "<code INSEE>": <population> } pour toutes les communes
import json, pathlib, sys
import requests

OUT = pathlib.Path(__file__).parent / "population.json"

def main():
    url = "https://geo.api.gouv.fr/communes?fields=nom,code,population&format=json&geometry=centre"
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    communes = r.json()
    mp = {}
    for c in communes:
        code = c.get("code")
        pop = c.get("population")
        if code and isinstance(pop, int):
            mp[code] = pop
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(mp, f, ensure_ascii=False)
    print(f"✓ population.json écrit ({len(mp)} communes) → {OUT}")

if __name__ == "__main__":
    main()
