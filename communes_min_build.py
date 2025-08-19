#!/usr/bin/env python3
# Génère communes_min.json : [{code, nom, dept, lat, lon, population}, ...]
import json, pathlib, requests

OUT = pathlib.Path(__file__).parent / "communes_min.json"

def main():
    url = "https://geo.api.gouv.fr/communes?fields=nom,code,codeDepartement,population,centre&format=json&geometry=centre"
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    data = r.json()
    out = []
    for c in data:
        code = c.get("code")
        nom  = c.get("nom")
        dept = c.get("codeDepartement")
        pop  = c.get("population")
        ctr  = c.get("centre", {})
        coords = ctr.get("coordinates") if isinstance(ctr, dict) else None
        if not (code and nom and dept and coords and isinstance(coords, list) and len(coords) == 2):
            continue
        lon, lat = coords  # GeoJSON: [lon, lat]
        out.append({
            "code": code,
            "nom": nom,
            "dept": dept,
            "lat": lat,
            "lon": lon,
            "population": pop if isinstance(pop, int) else None
        })
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"✓ communes_min.json écrit ({len(out)} communes) → {OUT}")

if __name__ == "__main__":
    main()
