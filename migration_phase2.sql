-- ══════════════════════════════════════════════════════════
-- ADS Phase 2 — Prêts, sanctions, réouverture, présence split
-- À exécuter UNE seule fois sur ads_db
-- ══════════════════════════════════════════════════════════

-- 1. Paramètres système
CREATE TABLE IF NOT EXISTS parametres (
  cle         VARCHAR(50)  NOT NULL PRIMARY KEY,
  valeur      VARCHAR(255) NOT NULL,
  description VARCHAR(255) NULL
);

INSERT IGNORE INTO parametres (cle, valeur, description) VALUES
  ('TAUX_INTERET_MENSUEL',   '2.5', 'Taux mensuel des prêts (%)'),
  ('PENALITE_ECHEC',         '5',   'Pénalité échec remboursement (% capital dû)'),
  ('NB_ECHEANCES_MAX',       '2',   'Nombre max d''échéances par prêt');

-- 2. Prêts
CREATE TABLE IF NOT EXISTS prets (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  membre_id            INT            NOT NULL,
  montant_capital      INT            NOT NULL,
  taux_mensuel         DECIMAL(5,2)   NOT NULL DEFAULT 2.5,
  nb_echeances         INT            NOT NULL DEFAULT 2,
  date_debut           DATE           NOT NULL,
  statut               ENUM('EN_COURS','REMBOURSE','EN_RETARD') NOT NULL DEFAULT 'EN_COURS',
  type_garantie        ENUM('TONTINE','GARANT','PRESIDENT')     NOT NULL,
  garant_id            INT            NULL,
  tontine_garantie_id  INT            NULL,
  reunion_octroi_id    INT            NULL,
  created_at           TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (membre_id)           REFERENCES membres(id),
  FOREIGN KEY (reunion_octroi_id)   REFERENCES reunions(id)
);

-- 3. Échéances de prêts
CREATE TABLE IF NOT EXISTS echeances_prets (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  pret_id           INT          NOT NULL,
  numero_echeance   INT          NOT NULL,
  date_prevue       DATE         NOT NULL,
  reunion_id        INT          NULL,
  montant_capital   INT          NOT NULL,
  montant_interets  INT          NOT NULL,
  montant_total     INT          NOT NULL,
  montant_paye      INT          NOT NULL DEFAULT 0,
  statut            ENUM('ATTENDU','PAYE','EN_RETARD','REECHELONNE') NOT NULL DEFAULT 'ATTENDU',
  penalite          INT          NOT NULL DEFAULT 0,
  FOREIGN KEY (pret_id)    REFERENCES prets(id),
  FOREIGN KEY (reunion_id) REFERENCES reunions(id)
);

-- 4. Sanctions
CREATE TABLE IF NOT EXISTS sanctions (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  reunion_id  INT  NOT NULL,
  membre_id   INT  NOT NULL,
  type        ENUM('ECHEC_TONTINE','DOUBLE_ABSENCE','AUTRE') NOT NULL,
  description VARCHAR(255) NULL,
  montant     INT  NOT NULL DEFAULT 0,
  statut      ENUM('NON_PAYEE','PAYEE') NOT NULL DEFAULT 'NON_PAYEE',
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reunion_id) REFERENCES reunions(id),
  FOREIGN KEY (membre_id)  REFERENCES membres(id)
);

-- 5. Ajout colonne présence split sur bénéficiaires
--    (procédure conditionnelle pour éviter l'erreur si déjà créée)
DROP PROCEDURE IF EXISTS _ads_add_montant_membre;
DELIMITER //
CREATE PROCEDURE _ads_add_montant_membre()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'beneficiaires'
      AND COLUMN_NAME  = 'montant_membre'
  ) THEN
    ALTER TABLE beneficiaires ADD COLUMN montant_membre INT NULL DEFAULT NULL;
  END IF;
END//
DELIMITER ;
CALL _ads_add_montant_membre();
DROP PROCEDURE IF EXISTS _ads_add_montant_membre;
