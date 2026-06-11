-- ══════════════════════════════════════════════════════════════
-- ADS Phase 5 — Authentification & rôles (comptes utilisateurs)
-- À exécuter UNE seule fois, puis lancer le seed : node src/seed/seed_utilisateurs.js
-- Soft delete : la colonne `deleted` vaut 0 (actif) ou l'id de la ligne (supprimé).
-- Les unicités sont composites (login, deleted) / (membre_id, deleted) afin de
-- permettre la ré-utilisation d'un login/membre après suppression logique.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS utilisateurs (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  membre_id          INT NULL,                              -- compte rattaché à un membre (optionnel)
  login              VARCHAR(60)  NOT NULL,
  mot_de_passe       VARCHAR(255) NOT NULL,                 -- hash bcrypt
  role               ENUM('ADMIN','SECRETAIRE','TRESORIER','LECTEUR') NOT NULL DEFAULT 'LECTEUR',
  actif              TINYINT      NOT NULL DEFAULT 1,
  doit_changer_mdp   TINYINT      NOT NULL DEFAULT 0,        -- forcer le changement à la 1re connexion
  deleted            INT UNSIGNED NOT NULL DEFAULT 0,        -- 0 = actif, sinon = id (suppression logique)
  derniere_connexion DATETIME     NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY login_deleted      (login, deleted),
  UNIQUE KEY membre_id_deleted  (membre_id, deleted),
  FOREIGN KEY (membre_id) REFERENCES membres(id) ON DELETE SET NULL
);
