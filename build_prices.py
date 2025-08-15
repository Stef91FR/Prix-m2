#!/usr/bin/env python3
"""
Build prices.json (médian €/m² Maisons & Appartements) pour TOUTES les communes de France
à partir des DVF (12 derniers mois).

Fonctionne localement ou sur GitHub Actions.
- Lit un CSV gzippé DVF (geo-dvf) depuis DVF_URL (env) ou depuis ./dvf.csv.gz si présent.
- Télécharge la liste des communes (code INSEE, nom, département) depuis geo.api.gouv.fr si communes.json absent.
- Produit un fichier prices.json compatible avec index.html du site statique.

Prérequis : duckdb, pandas, requests
"""
import os, sys, io, json, gzip, datetime, tempfile, pathlib
from datetime import date, timedelta
today = date.today()

def years_to_fetch(max_back_months=24):
    # on récupère jusqu’à 3 années pour couvrir 24 mois glissants (cas janvier/février)
    y = today.year
    return [y, y-1, y-2]

def path_or_download_dvf_multi():
    # télécharge 1 à 3 fichiers annuels si nécessaires, renvoie la liste de chemins
    import os, pathlib
    HERE = pathlib.Path(__file__).parent.resolve()
    paths = []
    for y in years_to_fetch():
        url = f"https://files.data.gouv.fr/geo-dvf/latest/csv/{y}/full.csv.gz"
        dest = HERE / f"dvf_{y}.csv.gz"
        if not dest.exists():
            try:
                download(url, dest)
            except Exception:
                # année pas (encore) dispo → on ignore
                continue
        paths.append(str(dest))
    if not paths:
        raise RuntimeError("Aucun fichier DVF n'a pu être téléchargé.")
    print("✓ Fichiers DVF utilisés :", paths)
    return paths

def build_prices_for_window(dvf_paths, window_days):
    start_date = today - timedelta(days=window_days)
    import duckdb, pandas as pd
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    print(f"Lecture & agrégation DVF ({window_days} jours)…")

    # DuckDB lit la liste de fichiers d’un coup
    files = ",".join([f"'{p}'" for p in dvf_paths])
    q = f"""
    WITH src AS (
      SELECT
        try_cast(date_mutation AS DATE) AS dte,
        nature_mutation,
        type_local,
        try_cast(surface_reelle_bati AS DOUBLE) AS surf,
        try_cast(valeur_fonciere AS DOUBLE) AS vf,
        code_commune
      FROM read_csv_auto([{files}], header=TRUE, sep=',', sample_size=-1, union_by_name=TRUE)
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
    df = con.execute(q).fetch_df()

    # pivot et map communes
    pivot = df.pivot_table(index="code_commune", columns="type_local", values=["med_eur_m2","n"], aggfunc="first")
    pivot.columns = [f"{a}_{b}".lower() for a,b in pivot.columns]
    pivot = pivot.reset_index().rename(columns={"code_commune":"code"})
    pivot = pivot.where(pd.notnull(pivot), None)

    return pivot, start_date

def write_prices_json(filename, pivot, start_date, communes_json):
    import pandas as pd, json, pathlib
    OUT_PATH = pathlib.Path(__file__).parent.resolve() / filename
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
        "periode": f"{start_date.isoformat()} à {today.isoformat()} ({(today-start_date).days//30} mois)",
        "devise": "EUR/m²",
        "source": "DVF (geo-dvf) — ventes logements, médiane €/m², filtres anti-outliers",
        "data": by_code
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, allow_nan=False)
    print(f"✓ Écrit {OUT_PATH} ({len(by_code)} communes)")

def main():
    communes = ensure_communes()
    dvf_paths = path_or_download_dvf_multi()
    # 12 mois
    pivot12, start12 = build_prices_for_window(dvf_paths, 365)
    write_prices_json("prices_12.json", pivot12, start12, communes)
    # 24 mois
    pivot24, start24 = build_prices_for_window(dvf_paths, 730)
    write_prices_json("prices_24.json", pivot24, start24, communes)

if __name__ == "__main__":
    main()

import pandas as pd
import duckdb
import requests

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
OUT_PATH = HERE / "prices.json"
COMMUNES_PATH = HERE / "communes.json"
# DVF: vous pouvez changer cette URL pour pointer vers une version spécifique si besoin.
DEFAULT_DVF_URL = os.environ.get("DVF_URL", "https://files.data.gouv.fr/geo-dvf/latest/csv/transactions.csv.gz")

# Fenêtre d'analyse (12 mois glissants)
today = date.today()
start_date = today - timedelta(days=365)

def download(url: str, dest: pathlib.Path):
    print(f"→ Téléchargement : {url}")
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024*1024):
                if chunk:
                    f.write(chunk)
    print(f"  ✓ Fichier enregistré : {dest} ({dest.stat().st_size/1_048_576:.1f} MiB)")

def ensure_communes():
    if COMMUNES_PATH.exists():
        print("✓ communes.json présent")
        with open(COMMUNES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    url = "https://geo.api.gouv.fr/communes?fields=nom,code,codeDepartement&format=json&geometry=centre"
    print("Téléchargement de la liste des communes…")
    with requests.get(url, timeout=60) as r:
        r.raise_for_status()
        communes = r.json()
    with open(COMMUNES_PATH, "w", encoding="utf-8") as f:
        json.dump(communes, f, ensure_ascii=False, indent=2)
    print(f"✓ communes.json écrit ({len(communes)} communes)")
    return communes

def path_or_download_dvf():
    local = HERE / "dvf.csv.gz"
    if local.exists():
        print("✓ dvf.csv.gz présent (utilisation locale)")
        return str(local)
    # sinon, on télécharge depuis DEFAULT_DVF_URL
    tmp = HERE / "dvf.csv.gz"
    download(DEFAULT_DVF_URL, tmp)
    return str(tmp)

def build_prices(dvf_path: str, communes_json):
    # DuckDB peut lire le .gz directement
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    print("Lecture & agrégation DVF avec DuckDB…")

    # On filtre : 12 derniers mois, ventes, logements, médiane €/m², garde les valeurs plausibles.
    # Les colonnes utilisées (geo-dvf) : date_mutation, nature_mutation, type_local, surface_reelle_bati, valeur_fonciere, code_commune
    q = f"""
    WITH src AS (
      SELECT
        try_cast(date_mutation AS DATE) AS dte,
        nature_mutation,
        type_local,
        try_cast(surface_reelle_bati AS DOUBLE) AS surf,
        try_cast(valeur_fonciere AS DOUBLE) AS vf,
        code_commune
      FROM read_csv_auto('{dvf_path}', header=TRUE, sep=',', sample_size=-1, union_by_name=TRUE)
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
        AND surf BETWEEN 10 AND 1000             -- filtre surfaces extrêmes
        AND vf > 1000
    ),
    clean AS (
      SELECT *
      FROM base
      WHERE prix_m2 BETWEEN 300 AND 20000        -- filtre prix/m² aberrants
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
    df = con.execute(q).fetch_df()

    # Pivot: colonnes "Maison" et "Appartement"
    pivot = df.pivot_table(index="code_commune", columns="type_local", values=["med_eur_m2","n"], aggfunc="first")
    # normaliser colonnes
    pivot.columns = [f"{a}_{b}".lower() for a,b in pivot.columns]
    pivot = pivot.reset_index().rename(columns={"code_commune":"code"})
    # Remplacement NaN par None
    pivot = pivot.where(pd.notnull(pivot), None)

    # Construire dictionnaire final {code_insee: {...}}
    by_code = {}
    communes_map = {c["code"]: c for c in communes_json}
    for _, row in pivot.iterrows():
        code = str(row["code"])
        c = communes_map.get(code)
        if not c:
            # Commune disparue ou code non listé
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
        "periode": f"{start_date.isoformat()} à {today.isoformat()} (12 mois)",
        "devise": "EUR/m²",
        "source": "DVF (geo-dvf) — ventes logements, médiane €/m², filtres anti-outliers",
        "data": by_code
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, allow_nan=False)
    print(f"✓ Écrit {OUT_PATH} ({OUT_PATH.stat().st_size/1_048_576:.1f} MiB, {len(by_code)} communes)")

def main():
    communes = ensure_communes()
    dvf_path = path_or_download_dvf()
    build_prices(dvf_path, communes)

if __name__ == "__main__":
    main()
