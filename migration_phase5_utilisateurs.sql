-- ══════════════════════════════════════════════════════════════
-- ADS Phase 5 — Authentification & rôles (comptes utilisateurs)
-- À exécuter UNE seule fois, puis lancer le seed : node src/seed/seed_utilisateurs.js
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS utilisateurs (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  membre_id          INT NULL UNIQUE,                       -- compte rattaché à un membre (optionnel)
  login              VARCHAR(60)  NOT NULL UNIQUE,
  mot_de_passe       VARCHAR(255) NOT NULL,                 -- hash bcrypt
  role               ENUM('ADMIN','SECRETAIRE','TRESORIER','LECTEUR') NOT NULL DEFAULT 'LECTEUR',
  actif              TINYINT      NOT NULL DEFAULT 1,
  doit_changer_mdp   TINYINT      NOT NULL DEFAULT 0,        -- forcer le changement à la 1re connexion
  derniere_connexion DATETIME     NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (membre_id) REFERENCES membres(id) ON DELETE SET NULL
);
