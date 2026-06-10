-- ══════════════════════════════════════════════════════════════
-- ADS Phase 3 — Référence Mobile Money (MTN MoMo / Orange Money)
-- À exécuter UNE seule fois sur ads_db, après migration_phase2_v2.sql
-- ══════════════════════════════════════════════════════════════

-- 1. Référence de transaction sur les mouvements de caisse manuels
--    (procédure conditionnelle pour éviter l'erreur si la colonne existe déjà)
DROP PROCEDURE IF EXISTS _ads_add_mvt_reference;
DELIMITER //
CREATE PROCEDURE _ads_add_mvt_reference()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'mouvements_caisse'
      AND COLUMN_NAME  = 'reference'
  ) THEN
    ALTER TABLE mouvements_caisse ADD COLUMN reference VARCHAR(255) NULL DEFAULT NULL
      COMMENT 'Référence de transaction Mobile Money (MoMo / Orange Money)';
  END IF;
END//
DELIMITER ;
CALL _ads_add_mvt_reference();
DROP PROCEDURE IF EXISTS _ads_add_mvt_reference;

-- 2. Référence de paiement Mobile Money par membre et par réunion
--    Une seule référence par (réunion, membre) : un membre règle en général
--    l'ensemble de son dû via un unique transfert MoMo/OM.
CREATE TABLE IF NOT EXISTS reunion_references_paiement (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  reunion_id  INT          NOT NULL,
  membre_id   INT          NOT NULL,
  reference   VARCHAR(255) NOT NULL,
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_reunion_membre (reunion_id, membre_id),
  FOREIGN KEY (reunion_id) REFERENCES reunions(id) ON DELETE CASCADE,
  FOREIGN KEY (membre_id)  REFERENCES membres(id)
);
