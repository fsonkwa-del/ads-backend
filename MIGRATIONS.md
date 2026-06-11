# Migrations base de données — ADS

Exécuter **dans cet ordre**, une seule fois chacune, sur la base (`ads_db`).
Toutes sont idempotentes (procédures conditionnelles / `CREATE TABLE IF NOT EXISTS`),
sauf indication contraire — on peut les rejouer sans danger.

Commande type :

```bash
mysql -u <user> -p ads_db < <fichier>.sql
```

| Ordre | Fichier | Contenu |
|-------|---------|---------|
| 0 | _(schéma de base)_ | `membres`, `tontines`, `souscriptions`, `reunions`, `cotisations_tontine`, `cotisations_rubrique`, `beneficiaires`, `mouvements_caisse`, `soldes_membres`, `aides`, `contributions_aide`, `cassations`… (déjà en place) |
| 1 | `migration_phase2.sql` | Paramètres, prêts, échéances, sanctions, colonne `montant_membre` (présence split) |
| 2 | `migration_phase2_v2.sql` | Refonte `echeances_pret` + colonnes `reunions` (rafraîchissement, amende réouverture) |
| 3 | `src/migrations/001_tour_system.sql` | Système de tours (tontines, souscriptions) + `historique_beneficiaires` + `rattrapages` |
| 4 | `migration_phase3_momo.sql` | Référence Mobile Money : `mouvements_caisse.reference` + `reunion_references_paiement` |
| 5 | `migration_phase4_prets.sql` | Multi-garants (`prets_garants`) + `prets.interet_retenu_source` (avec backfill des garants uniques) |
| 6 | `migration_phase4_bureau.sql` | Bureau exécutif : `bureau_mandats` + `bureau_postes` (inclut déjà le poste **TRESORIER**) |
| 7 | `migration_phase4b_tresorier.sql` | Ajoute `TRESORIER` à l'ENUM `bureau_postes.poste`. **Inutile si** la phase 6 a été passée avec la version à jour ; à exécuter uniquement si un bureau avait été créé avec l'ancienne liste de postes. Idempotent. |
| 8 | `migration_phase4c_postes_perso.sql` | Postes du bureau **personnalisables** : `bureau_postes.poste` ENUM→VARCHAR + table `bureau_postes_def` (définitions + postes statutaires standard). Idempotent. |
| 9 | `migration_phase5_utilisateurs.sql` | **Authentification & rôles** : table `utilisateurs` (login, mot de passe bcrypt, rôle, lien membre, **soft delete** `deleted` + index uniques composites `(login, deleted)`/`(membre_id, deleted)`). **Puis** lancer le seed : `node src/seed/seed_utilisateurs.js`. |
| 10 | `migration_phase6_multi_beneficiaires.sql` | **Multi-bénéficiaires** : remplace la clé unique `beneficiaires(reunion_id, tontine_id)` par `(reunion_id, tontine_id, membre_id)`. Idempotent. |
| 11 | `migration_phase7_audit.sql` | **Journal d'audit** centralisé : table `journaux_audit` (traçabilité des actions critiques). |
| — | `node run_migration.js` | **Catch-all idempotent** : ajoute `deleted` sur `membres`/`utilisateurs`, migre les index `utilisateurs` vers les composites, crée `journaux_audit`. À lancer après une mise à jour pour aligner une base existante. |

## État connu (10/06/2026)
- **Base de développement `ads_db`** : migrations 1→11 appliquées (soft delete + RBAC + audit inclus).
- **Production** : à vérifier / appliquer. Pour une base déjà en service : `node run_migration.js` réalise la mise à niveau soft-delete/audit sans toucher aux données.
- ⚠️ **Ne jamais exécuter `node reset_db.js` en production** — il vide toutes les tables (outil de remise à zéro pour tests uniquement).

## Notes
- Les phases 6 et 7 portent toutes deux le préfixe « phase 4 » pour des raisons historiques
  (prêts vs bureau) — l'ordre ci-dessus fait foi.
- Sauvegarder la base avant toute migration en production : `mysqldump -u <user> -p ads_db > backup_$(date +%F).sql`.
