-- ============================================================
-- Migration 001 – Système de tours (tontines + souscriptions)
-- À exécuter une seule fois sur ads_db
-- ============================================================

-- 1. Colonnes tour sur la table tontines
ALTER TABLE tontines
  ADD COLUMN IF NOT EXISTS tour_actuel      INT  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS date_debut_tour  DATE DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS nb_reunions_tour INT  NOT NULL DEFAULT 0
    COMMENT 'Nb de réunions validées dans le tour actuel';

-- 2. Colonnes tour + statut sur souscriptions
ALTER TABLE souscriptions
  ADD COLUMN IF NOT EXISTS tour     INT  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS date_fin DATE DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS statut   ENUM('ACTIVE','SUSPENDUE','TERMINEE') NOT NULL DEFAULT 'ACTIVE';

-- 3. Historique des bénéficiaires par tour
CREATE TABLE IF NOT EXISTS historique_beneficiaires (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tontine_id  INT NOT NULL,
  membre_id   INT NOT NULL,
  tour        INT NOT NULL,
  reunion_id  INT NOT NULL,
  montant_recu INT NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tontine_id) REFERENCES tontines(id),
  FOREIGN KEY (membre_id)  REFERENCES membres(id),
  FOREIGN KEY (reunion_id) REFERENCES reunions(id)
);

-- 4. Rattrapages (adhésion ou augmentation de parts en cours de tour)
CREATE TABLE IF NOT EXISTS rattrapages (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  membre_id       INT NOT NULL,
  tontine_id      INT NOT NULL,
  tour            INT NOT NULL,
  reunion_id      INT NULL COMMENT 'Réunion lors de laquelle le paiement est enregistré (optionnel)',
  nb_seances_dues INT NOT NULL,
  nb_parts        INT NOT NULL,
  montant_total   INT NOT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (membre_id)  REFERENCES membres(id),
  FOREIGN KEY (tontine_id) REFERENCES tontines(id),
  FOREIGN KEY (reunion_id) REFERENCES reunions(id)
);
