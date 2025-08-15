# Prix au m² — Page statique (Option A)

Ce kit fournit **une page web statique** où un utilisateur entre une **ville de France** et obtient les **prix médians au m² (appartements & maisons)**.
La ville est choisie via l’**API Adresse** (officielle) et les prix proviennent d’un **fichier `prices.json`** (exemple inclus).

## Structure
- `index.html` — la page web (HTML + JS + CSS inline).
- `prices.json` — **exemple** de données (quelques grandes villes). Remplacez-le par vos agrégats DVF.
- (optionnel) vous pouvez ajouter un `favicon.ico` si besoin.

## Déploiement en 2 minutes (Vercel)
1. Créez un compte gratuit sur **vercel.com**.
2. Créez un nouveau projet **"Other" / "Static"** et **uploadez** ces 2 fichiers (drag & drop) OU mettez-les sur un dépôt GitHub et importez-le.
3. Cliquez **Deploy**. Vous obtenez une **URL publique**.

> Alternative : GitHub Pages, Netlify, Cloudflare Pages… ça marche pareil (site statique).

## Utilisation
- Tapez une ville. Choisissez la **commune** dans les suggestions (API Adresse).
- Cliquez **Rechercher**.
- La page charge `prices.json` et affiche la médiane €/m² pour **appartements** et **maisons** (si disponibles).

## Comment remplacer `prices.json` par vos vrais chiffres DVF ?
Le format attendu est :
```json
{
  "periode": "2024-08 à 2025-07 (12 mois)",
  "devise": "EUR/m²",
  "source": "DVF",
  "data": {
    "CODE_INSEE": {
      "ville": "Nom de la commune",
      "dept": "Numéro de département",
      "appart": 4280,
      "maison": 4000,
      "n_ventes": { "appart": 1240, "maison": 860 }
    },
    "...": { "...": "..." }
  }
}
```

- **CODE_INSEE** = citycode de l’API Adresse (ex : Paris `75056`, Lyon `69385`, Bordeaux `33063`…).
- Les prix sont des **médianes** en **€/m²** sur 12 mois glissants.
- `n_ventes` est facultatif mais recommandé pour l’indice de confiance.

### Générer `prices.json` (piste simple hors-ligne)
Si vous avez un fichier DVF (CSV/Parquet), vous pouvez calculer les médianes par **code commune** et **type local** (Maison/Appartement) avec **pandas**/**DuckDB** et exporter au format ci-dessus.
Si vous le souhaitez, je peux vous fournir un script Python prêt à l’emploi.

## Personnalisation
- Modifiez les couleurs/typo dans le `<style>`.
- Remplacez le texte “exemple de données” dans `index.html`.
- Hébergez `prices.json` sur un CDN et changez le chemin (ex : `https://cdn.votresite/prices.json`).

## Limites & Notes
- `prices.json` est **statique** : mettez-le à jour (manuellement ou via une action GitHub/crob) quand vous le souhaitez.
- Ne pas scraper des sites privés : privilégiez **DVF** (open data) et mentionnez vos sources.
- Cette page n’envoie **aucune donnée personnelle** ; elle appelle uniquement l’API Adresse (publique) pour l’autocomplétion.

— Généré le 2025-08-15
