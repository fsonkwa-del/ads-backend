-- ══════════════════════════════════════════════════════════════
-- ADS Phase 6 — Multi-bénéficiaires par tontine et par réunion
-- Remplace la contrainte d'unicité (reunion_id, tontine_id) par
-- (reunion_id, tontine_id, membre_id) pour autoriser plusieurs
-- bénéficiaires d'une même tontine sur une séance.
-- On AJOUTE d'abord la nouvelle clé (elle couvre la FK sur reunion_id),
-- puis on supprime l'ancienne. À exécuter UNE seule fois (ré-exécutable).
-- ══════════════════════════════════════════════════════════════

DROP PROCEDURE IF EXISTS _ads_fix_benef_unique;
DELIMITER //
CREATE PROCEDURE _ads_fix_benef_unique()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'beneficiaires' AND INDEX_NAME = 'uq_reunion_tontine_membre'
  ) THEN
    ALTER TABLE beneficiaires ADD CONSTRAINT uq_reunion_tontine_membre UNIQUE (reunion_id, tontine_id, membre_id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'beneficiaires' AND INDEX_NAME = 'uq_beneficiaire'
  ) THEN
    ALTER TABLE beneficiaires DROP KEY uq_beneficiaire;
  END IF;
END//
DELIMITER ;
CALL _ads_fix_benef_unique();
DROP PROCEDURE IF EXISTS _ads_fix_benef_unique;
