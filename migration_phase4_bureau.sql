-- ══════════════════════════════════════════════════════════════
-- ADS Phase 4 — Bureau exécutif (mandats + composition des postes)
-- À exécuter UNE seule fois sur ads_db
-- ══════════════════════════════════════════════════════════════

-- 1. Mandats du bureau
--    Un mandat dure 2 ans, renouvelable 1 fois (est_renouvellement = 1).
--    Un mandat de renouvellement ne peut plus être renouvelé (cap à 4 ans).
CREATE TABLE IF NOT EXISTS bureau_mandats (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  numero              INT NOT NULL,                         -- 1, 2, 3... (ordre chronologique)
  date_debut          DATE NOT NULL,
  date_fin            DATE NOT NULL,                        -- ≈ date_debut + 2 ans
  est_renouvellement  TINYINT NOT NULL DEFAULT 0,           -- 0 = mandat initial, 1 = reconduction
  mandat_precedent_id INT NULL,                             -- mandat reconduit (le cas échéant)
  statut              ENUM('EN_COURS','TERMINE') NOT NULL DEFAULT 'EN_COURS',
  observations        VARCHAR(255) NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mandat_precedent_id) REFERENCES bureau_mandats(id)
);

-- 2. Composition : un membre occupe un poste (titulaire ou adjoint) sur un mandat.
--    Postes nominatifs (titulaire + adjoint) : PRESIDENT, SECRETAIRE, TRESORIER,
--    COMMISSAIRE_COMPTES, CENSEUR, CHARGE_CULTUREL. CONSEILLER : multiples.
CREATE TABLE IF NOT EXISTS bureau_postes (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  mandat_id  INT NOT NULL,
  membre_id  INT NOT NULL,
  poste      ENUM('PRESIDENT','SECRETAIRE','TRESORIER','COMMISSAIRE_COMPTES','CENSEUR','CHARGE_CULTUREL','CONSEILLER') NOT NULL,
  role       ENUM('TITULAIRE','ADJOINT') NOT NULL DEFAULT 'TITULAIRE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mandat_id) REFERENCES bureau_mandats(id) ON DELETE CASCADE,
  FOREIGN KEY (membre_id) REFERENCES membres(id)
);

CREATE INDEX idx_bureau_postes_mandat ON bureau_postes (mandat_id);
CREATE INDEX idx_bureau_mandats_statut ON bureau_mandats (statut);
