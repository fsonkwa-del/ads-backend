-- ══════════════════════════════════════════════════════════════
-- ADS Phase 4 — Multi-garants (multi-avals) + intérêt retenu à la source
-- À exécuter UNE seule fois sur ads_db, après migration_phase3_momo.sql
-- ══════════════════════════════════════════════════════════════

-- 1. Colonne « intérêt retenu à la source » sur les prêts
--    (procédure conditionnelle pour éviter l'erreur si la colonne existe déjà)
DROP PROCEDURE IF EXISTS _ads_add_interet_retenu;
DELIMITER //
CREATE PROCEDURE _ads_add_interet_retenu()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'prets'
      AND COLUMN_NAME  = 'interet_retenu_source'
  ) THEN
    ALTER TABLE prets ADD COLUMN interet_retenu_source TINYINT(1) NOT NULL DEFAULT 0
      COMMENT 'Intérêt déduit du montant remis au membre le jour de l''octroi';
  END IF;
END//
DELIMITER ;
CALL _ads_add_interet_retenu();
DROP PROCEDURE IF EXISTS _ads_add_interet_retenu;

-- 2. Table de jointure des garants (plusieurs garants par prêt)
CREATE TABLE IF NOT EXISTS prets_garants (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  pret_id    INT       NOT NULL,
  membre_id  INT       NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_pret_garant (pret_id, membre_id),
  FOREIGN KEY (pret_id)   REFERENCES prets(id)   ON DELETE CASCADE,
  FOREIGN KEY (membre_id) REFERENCES membres(id)
);

-- 3. Backfill : migre les garants uniques existants vers la table de jointure
INSERT IGNORE INTO prets_garants (pret_id, membre_id)
SELECT id, garant_id FROM prets WHERE garant_id IS NOT NULL;
