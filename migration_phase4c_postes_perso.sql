-- ══════════════════════════════════════════════════════════════
-- ADS Phase 4c — Postes du bureau personnalisables (définitions dynamiques)
-- À exécuter après migration_phase4_bureau.sql (+ 4b). Idempotent.
-- ══════════════════════════════════════════════════════════════

-- 1. Le poste devient un code libre (VARCHAR) au lieu d'un ENUM figé
ALTER TABLE bureau_postes MODIFY poste VARCHAR(50) NOT NULL;

-- 2. Table des définitions de postes (statutaires + personnalisés)
CREATE TABLE IF NOT EXISTS bureau_postes_def (
  code      VARCHAR(50)  NOT NULL PRIMARY KEY,
  label     VARCHAR(100) NOT NULL,
  ordre     INT          NOT NULL DEFAULT 100,
  a_adjoint TINYINT      NOT NULL DEFAULT 1,   -- le poste possède un adjoint
  multiple  TINYINT      NOT NULL DEFAULT 0,   -- plusieurs titulaires (ex. conseillers)
  systeme   TINYINT      NOT NULL DEFAULT 0,   -- poste statutaire (non supprimable)
  actif     TINYINT      NOT NULL DEFAULT 1
);

-- 3. Postes statutaires standard d'une association camerounaise
INSERT IGNORE INTO bureau_postes_def (code, label, ordre, a_adjoint, multiple, systeme) VALUES
  ('PRESIDENT',           'Président',                 1, 1, 0, 1),
  ('SECRETAIRE',          'Secrétaire',                2, 1, 0, 1),
  ('TRESORIER',           'Trésorier',                 3, 1, 0, 1),
  ('COMMISSAIRE_COMPTES', 'Commissaire aux comptes',   4, 1, 0, 1),
  ('CENSEUR',             'Censeur',                   5, 1, 0, 1),
  ('CHARGE_CULTUREL',     'Chargé culturel',           6, 1, 0, 1),
  ('CONSEILLER',          'Conseiller',              100, 0, 1, 1);
