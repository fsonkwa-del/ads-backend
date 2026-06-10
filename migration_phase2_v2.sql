-- ══════════════════════════════════════════════════════════════
-- ADS Phase 2 v2 — Schéma corrigé des échéances + colonnes réunion
-- À exécuter UNE seule fois sur ads_db, après migration_phase2.sql
-- ══════════════════════════════════════════════════════════════

-- 1. Supprime l'ancienne table echeances_prets (schéma trop complexe)
DROP TABLE IF EXISTS echeances_prets;

-- 2. Nouvelle table echeances_pret (schéma simplifié, par réunion)
CREATE TABLE IF NOT EXISTS echeances_pret (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  pret_id      INT NOT NULL,
  numero       INT NOT NULL,          -- position dans le calendrier de remboursement (1, 2, 3, 4)
  reunion_id   INT NULL,              -- réunion à laquelle cette échéance est rattachée
  montant_du   INT NOT NULL,          -- montant attendu pour cette réunion
  montant_paye INT NOT NULL DEFAULT 0,
  statut       ENUM('EN_ATTENTE','PAYEE','ECHEC') NOT NULL DEFAULT 'EN_ATTENTE',
  FOREIGN KEY (pret_id)    REFERENCES prets(id),
  FOREIGN KEY (reunion_id) REFERENCES reunions(id)
);

-- 3. Colonnes supplémentaires sur la table reunions
--    (exécuter séparément si l'une des colonnes existe déjà)
ALTER TABLE reunions
  ADD COLUMN montant_rafraichissement   INT NOT NULL DEFAULT 0,
  ADD COLUMN montant_amende_reouverture INT NOT NULL DEFAULT 0;
