#!/usr/bin/env python3
"""
Build prices_12.json et prices_24.json (médian €/m² Maisons & Appartements) pour TOUTES les communes
à partir des DVF (12 et 24 mois glissants). Compatible avec la page statique.

Prérequis : duckdb, pandas, requests
"""

import os, sys, io, json, gzip, datetime, tempfile, pathlib
from datetime import date, timedelta
import pandas as pd
import duckdb
import requests

# ---------- Helpers ----------
def safe_float(x):
    try:
        return float(x) if pd.notna(x) else None
    except Exception:
        return None

def safe_int(x):
    try:
        return int(x) if pd.notna(x) else None
    except Exception:
        return None

HERE = pathlib.Path(__file__).parent.resolve()
TODAY = date.today()

# ---------- Download helpers ----------
def download(url: str, dest: pathlib.Path):
    print(f"→ Téléchargement : {url}")
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1024 * 1024):
                if chunk:
                    f.write(chunk)
    print(f"  ✓ Fichier enregistré : {dest} ({dest.stat().st_size/1_048_576:.1f} MiB)")

def ensure_communes():
    """Télécharge la liste des communes (code INSEE, nom, dept) si absente."""
    path = HERE / "communes.json"
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    url = "https://geo.api.gouv.fr/communes?fields=nom,code,codeDepartement&format=json&geometry=centre"
    print("Téléchargement de la liste des communes…")
    with requests.get(url, timeout=60) as r:
        r.raise_for_status()
        communes = r.json()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(communes, f, ensure_ascii=False, indent=2)
    print(f"✓ communes.json écrit ({len(communes)} communes)")
    return communes

# ---------- DVF multi-années ----------
def years_to_fetch(max_back_months=24):
    """Retourne jusque 3 années pour couvrir 24 mois glissants (cas changement d'année)."""
    y = TODAY.year
    return [y, y - 1, y - 2]

def path_or_download_dvf_multi():
    """Télécharge 1..3 fichiers DVF annuels (full.csv.gz) si besoin, et renvoie leurs chemins."""
    paths = []
    for y in years_to_fetch():
        url = f"https://files.data.gouv.fr/geo-dvf/latest/csv/{y}/full.csv.gz"
        dest = HERE / f"dvf_{y}.csv.gz"
        if not dest.exists():
            try:
                download(url, dest)
            except Exception as e:
                print(f"  ⚠ {y}: {e} (ignoré)")
                continue
        paths.append(str(dest))
    if not paths:
        raise RuntimeError("Aucun fichier DVF n'a pu être téléchargé.")
    print("✓ Fichiers DVF utilisés :", paths)
    return paths

# ---------- Agrégation ----------
def build_prices_for_window(dvf_paths, window_days):
    start_date = TODAY - timedelta(days=window_days)
    print(f"Lecture & agrégation DVF ({window_days} jours, depuis {start_date})…")

    files_sql = ",".join([f"'{p}'" for p in dvf_paths])  # ['a','b'] en SQL DuckDB
    q = f"""
    WITH src AS (
      SELECT
        try_cast(date_mutation AS DATE) AS dte,
        nature_mutation,
        type_local,
        try_cast(surface_reelle_bati AS DOUBLE) AS surf,
        try_cast(valeur_fonciere AS DOUBLE) AS vf,
        code_commune
      FROM read_csv_auto([{files_sql}], header=TRUE, sep=',', sample_size=-1, union_by_name=TRUE)
    ),
    base AS (
      SELECT
        code_commune,
        type_local,
        vf / NULLIF(surf,0) AS prix_m2
      FROM src
      WHERE dte >= DATE '{start_date.isoformat()}'
        AND nature_mutation = 'Vente'
        AND type_local IN ('Maison','Appartement')
        AND surf IS NOT NULL AND vf IS NOT NULL
        AND surf BETWEEN 10 AND 1000
        AND vf > 1000
    ),
    clean AS (
      SELECT * FROM base
      WHERE prix_m2 BETWEEN 300 AND 20000
    ),
    agg AS (
      SELECT
        code_commune,
        type_local,
        median(prix_m2) AS med_eur_m2,
        count(*) AS n
      FROM clean
      GROUP BY 1,2
    )
    SELECT * FROM agg
    """
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    df = con.execute(q).fetch_df()

    pivot = df.pivot_table(
        index="code_commune",
        columns="type_local",
        values=["med_eur_m2", "n"],
        aggfunc="first"
    )
    pivot.columns = [f"{a}_{b}".lower() for a, b in pivot.columns]
    pivot = pivot.reset_index().rename(columns={"code_commune": "code"})
    pivot = pivot.where(pd.notnull(pivot), None)
    return pivot, start_date

def write_prices_json(filename, pivot, start_date, communes_json):
    communes_map = {c["code"]: c for c in communes_json}
    by_code = {}
    for _, row in pivot.iterrows():
        code = str(row["code"])
        c = communes_map.get(code)
        if not c:
            continue
        by_code[code] = {
            "ville": c["nom"],
            "dept": c.get("codeDepartement"),
            "appart": safe_float(row.get("med_eur_m2_appartement")),
            "maison": safe_float(row.get("med_eur_m2_maison")),
            "n_ventes": {
                "appart": safe_int(row.get("n_appartement")),
                "maison": safe_int(row.get("n_maison"))
            }
        }
    out = {
        "periode": f"{start_date.isoformat()} à {TODAY.isoformat()} ({(TODAY - start_date).days // 30} mois)",
        "devise": "EUR/m²",
        "source": "DVF (geo-dvf) — ventes logements, médiane €/m², filtres anti-outliers",
        "data": by_code
    }
    out_path = HERE / filename
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, allow_nan=False)
    print(f"✓ Écrit {out_path} ({len(by_code)} communes)")

# ---------- Main ----------
def main():
    communes = ensure_communes()
    dvf_paths = path_or_download_dvf_multi()
    # 12 mois glissants
    pivot12, start12 = build_prices_for_window(dvf_paths, 365)
    write_prices_json("prices_12.json", pivot12, start12, communes)
    # 24 mois glissants
    pivot24, start24 = build_prices_for_window(dvf_paths, 730)
    write_prices_json("prices_24.json", pivot24, start24, communes)

if __name__ == "__main__":
    main()
