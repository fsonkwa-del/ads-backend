# Déploiement gratuit (sans carte) — ADS

Stack : **MySQL** (TiDB Cloud Serverless ou Aiven) · **Backend** Node (Render) · **Frontend** React (Firebase Hosting).
Objectif : 100 % gratuit pour une présentation et des tests sur > 1 mois.

> Le code est déjà adapté au cloud : `src/config/db.js` gère le TLS (`DB_SSL`), CORS est
> configurable (`CORS_ORIGIN`), le frontend lit l'URL d'API via `VITE_API_URL`.

---

## 1. Base de données MySQL — TiDB Cloud Serverless (recommandé, sans carte)

1. Va sur **https://tidbcloud.com** → inscription (connexion Google possible).
2. Crée un **cluster Serverless** (plan gratuit : 5 Go, aucune carte).
3. Bouton **Connect** → note : `Host`, `Port` (**4000**), `User` (ex. `xxxx.root`), et génère le **mot de passe**. Le TLS est **obligatoire**.
4. Crée la base et importe le dump (fichier **`ads_db_dump.sql`** fourni à la racine de `ads-backend`) :

   ```bash
   # Crée la base
   mysql -h <HOST> -P 4000 -u <USER> -p --ssl-mode=VERIFY_IDENTITY -e "CREATE DATABASE ads_db;"
   # Importe le schéma + les données
   mysql -h <HOST> -P 4000 -u <USER> -p --ssl-mode=VERIFY_IDENTITY ads_db < ads_db_dump.sql
   ```

> **Alternative Aiven** (vrai MySQL) : https://aiven.io → service **MySQL** plan gratuit →
> récupère l'URI de connexion → même import. Mettre alors `DB_SSL_REJECT_UNAUTHORIZED=false`
> si tu ne fournis pas le certificat CA.

> 💡 Tu peux aussi me **donner la chaîne de connexion** une fois le cluster créé : je lance l'import du dump à ta place.

---

## 2. Backend Node — Render (gratuit)

1. Va sur **https://render.com** → connexion avec GitHub.
2. **New → Web Service** → choisis le repo **`fsonkwa-del/ads-backend`**.
3. Réglages :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free
4. **Environment Variables** (Settings → Environment) :

   | Clé | Valeur |
   |-----|--------|
   | `DB_HOST` | hôte TiDB/Aiven |
   | `DB_PORT` | `4000` (TiDB) ou le port Aiven |
   | `DB_USER` | utilisateur |
   | `DB_PASSWORD` | mot de passe |
   | `DB_NAME` | `ads_db` |
   | `DB_SSL` | `true` |
   | `DB_SSL_REJECT_UNAUTHORIZED` | `false` |
   | `JWT_SECRET` | une longue chaîne aléatoire |
   | `JWT_EXPIRES` | `12h` |
   | `CORS_ORIGIN` | URL Firebase du frontend (étape 3, ex. `https://ads-xxxx.web.app`) |

   `PORT` est fourni automatiquement par Render (le code lit `process.env.PORT`).
5. Déploie. Note l'URL publique, ex. **`https://ads-backend.onrender.com`**.

> ⚠️ Render free **met le service en veille** après 15 min d'inactivité → le 1er appel
> après une pause prend ~30-50 s (cold start). Pour une démo, ouvre l'app 1 min avant.
> ⚠️ Les **photos de membres** (dossier `uploads/`) ne sont **pas persistées** sur Render
> free (système de fichiers éphémère). Acceptable pour une démo.

---

## 3. Frontend React — Firebase Hosting (gratuit)

```bash
cd ads-frontend
npm install -g firebase-tools
firebase login

# Lier au projet Firebase (à créer sur https://console.firebase.google.com, plan Spark gratuit)
firebase use --add        # choisis ton projet

# Pointer le frontend vers le backend Render :
echo "VITE_API_URL=https://ads-backend.onrender.com/api" > .env.production

npm run build             # génère dist/
firebase deploy --only hosting
```

Firebase affiche l'URL finale, ex. **`https://ton-projet.web.app`**.
→ Reporte cette URL dans `CORS_ORIGIN` du backend Render (étape 2.4) puis redéploie le backend.

---

## 4. Ordre conseillé
1. Créer la base (TiDB) + importer le dump.
2. Déployer le backend Render (avec les variables DB) → obtenir l'URL backend.
3. Builder + déployer le frontend Firebase (avec `VITE_API_URL` = URL backend) → obtenir l'URL frontend.
4. Renseigner `CORS_ORIGIN` (URL frontend) sur Render → redéployer le backend.
5. Se connecter avec le compte **admin** existant (présent dans le dump).

## Notes
- Les **migrations n'ont pas besoin d'être rejouées** : le dump contient déjà le schéma final.
- Régénère le `JWT_SECRET` pour la prod (différent du local).
- Sauvegarde : le dump `ads_db_dump.sql` est une copie complète à la date du jour.
