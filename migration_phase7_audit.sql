-- ══════════════════════════════════════════════════════════════
-- ADS Phase 7 — Journal d'audit centralisé (traçabilité des actions critiques)
-- À exécuter UNE seule fois.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS journaux_audit (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  utilisateur_id INT NULL,
  action         VARCHAR(100) NOT NULL,
  table_cible    VARCHAR(50) NOT NULL,
  id_cible       INT NOT NULL,
  details        TEXT NULL,
  ip_adresse     VARCHAR(45) NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL
);
