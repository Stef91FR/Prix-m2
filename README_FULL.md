# Générer `prices.json` pour **toutes** les communes (France)

Ce pack construit un `prices.json` compatible avec ta page statique et couvrant **toutes les communes**.
Les chiffres sont la **médiane €/m²** des **ventes** DVF sur **12 mois glissants**, séparées **Appartements / Maisons**.

## Fichiers
- `build_prices.py` — script Python (DuckDB) qui :
  - télécharge la **liste des communes** (code INSEE, nom, département),
  - lit le **CSV gz** DVF (*geo-dvf*), filtre 12 mois, nettoie les valeurs aberrantes,
  - calcule les **médianes €/m²** et écrit `prices.json`.
- `requirements.txt` — dépendances Python.
- `.github/workflows/build.yml` — action GitHub qui exécute le script **tous les mois** (ou à la demande) et pousse `prices.json` dans le repo.

## Utilisation (avec GitHub + Vercel)
1. Ajoute ces fichiers à ton dépôt GitHub (même repo que ta page Vercel).
2. Dans GitHub → **Actions** : active les workflows si demandé.
3. Clique **"Run workflow"** (onglet Actions) pour lancer une génération immédiate.
   - L'action télécharge DVF depuis : `https://files.data.gouv.fr/geo-dvf/latest/csv/transactions.csv.gz` (modifiable dans `build.yml` via `DVF_URL`).
4. Une fois `prices.json` poussé, Vercel va automatiquement redéployer ta page statique.
5. Ta page chargera maintenant **les données de toutes les communes**.

> Si l'URL DVF change, édite la variable `DVF_URL` dans le workflow et relance l'action.

## Détails techniques
- Filtre : `nature_mutation = 'Vente'`, `type_local ∈ {Maison, Appartement}`, `10 ≤ surface_reelle_bati ≤ 1000`, `300 ≤ prix/m² ≤ 20000`.
- Fenêtre : **12 derniers mois** via `date_mutation`.
- Résultat : `{ code_INSEE: { ville, dept, appart, maison, n_ventes } }`.
- Le fichier `prices.json` peut peser quelques Mo (OK pour un site statique).

## Lancer en local (optionnel)
```bash
pip install -r requirements.txt
python build_prices.py
```
- Par défaut, le script télécharge DVF depuis `DVF_URL`. Tu peux aussi placer un fichier `dvf.csv.gz` local à la racine du repo.

— Mis à jour le 2025-08-15
