-- ══════════════════════════════════════════════════════════════
-- ADS Phase 4b — Ajout du poste TRESORIER au bureau exécutif
-- À exécuter sur les bases ayant déjà appliqué migration_phase4_bureau.sql.
-- (Idempotent : ré-exécuter ne change rien si TRESORIER est déjà présent.)
-- ══════════════════════════════════════════════════════════════

ALTER TABLE bureau_postes
  MODIFY poste ENUM(
    'PRESIDENT','SECRETAIRE','TRESORIER',
    'COMMISSAIRE_COMPTES','CENSEUR','CHARGE_CULTUREL','CONSEILLER'
  ) NOT NULL;
