require('dotenv').config()
const mysql = require('mysql2/promise')

;(async () => {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  })

  const run = async (label, sql) => {
    try   { await conn.query(sql); console.log('✅', label) }
    catch (e) { console.error('❌', label, '—', e.message) }
  }

  const colExists = async (table, col) => {
    const [[{ n }]] = await conn.query(
      'SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
      [table, col]
    )
    return n > 0
  }

  // ── Membres KYC — colonnes supplémentaires ────────────────────
  const kyc = [
    ['date_naissance',          'DATE NULL'],
    ['lieu_naissance',          'VARCHAR(100) NULL'],
    ['type_pid',                "ENUM('CNI','PASSEPORT','PERMIS','AUTRE') NULL"],
    ['numero_pid',              'VARCHAR(50) NULL'],
    ['photo_url',               'VARCHAR(255) NULL'],
    ['adresse',                 'VARCHAR(255) NULL'],
    ['profession',              'VARCHAR(100) NULL'],
    ['contact_urgence_nom',     'VARCHAR(100) NULL'],
    ['contact_urgence_tel',     'VARCHAR(20) NULL'],
    ['contact_urgence_relation','VARCHAR(50) NULL'],
  ]
  for (const [col, def] of kyc) {
    if (!(await colExists('membres', col)))
      await run(`ALTER membres ADD ${col}`, `ALTER TABLE membres ADD COLUMN ${col} ${def}`)
    else console.log(`ℹ️  membres.${col} déjà présent`)
  }

  // ── Tour system (001_tour_system.sql) — colonnes manquantes ──
  if (!(await colExists('tontines', 'tour_actuel')))
    await run('ALTER tontines ADD tour_actuel',
      'ALTER TABLE tontines ADD COLUMN tour_actuel INT NOT NULL DEFAULT 1')
  else console.log('ℹ️  tontines.tour_actuel déjà présent')

  if (!(await colExists('tontines', 'date_debut_tour')))
    await run('ALTER tontines ADD date_debut_tour',
      'ALTER TABLE tontines ADD COLUMN date_debut_tour DATE DEFAULT NULL')
  else console.log('ℹ️  tontines.date_debut_tour déjà présent')

  if (!(await colExists('tontines', 'nb_reunions_tour')))
    await run('ALTER tontines ADD nb_reunions_tour',
      "ALTER TABLE tontines ADD COLUMN nb_reunions_tour INT NOT NULL DEFAULT 0 COMMENT 'Nb de réunions validées dans le tour actuel'")
  else console.log('ℹ️  tontines.nb_reunions_tour déjà présent')

  if (!(await colExists('souscriptions', 'tour')))
    await run('ALTER souscriptions ADD tour',
      'ALTER TABLE souscriptions ADD COLUMN tour INT NOT NULL DEFAULT 1')
  else console.log('ℹ️  souscriptions.tour déjà présent')

  if (!(await colExists('souscriptions', 'date_fin')))
    await run('ALTER souscriptions ADD date_fin',
      'ALTER TABLE souscriptions ADD COLUMN date_fin DATE DEFAULT NULL')
  else console.log('ℹ️  souscriptions.date_fin déjà présent')

  if (!(await colExists('souscriptions', 'statut')))
    await run('ALTER souscriptions ADD statut',
      "ALTER TABLE souscriptions ADD COLUMN statut ENUM('ACTIVE','SUSPENDUE','TERMINEE') NOT NULL DEFAULT 'ACTIVE'")
  else console.log('ℹ️  souscriptions.statut déjà présent')

  // ── Phase 2 (tables de base) ──────────────────────────────
  await run('CREATE parametres', `CREATE TABLE IF NOT EXISTS parametres (cle VARCHAR(50) NOT NULL PRIMARY KEY, valeur VARCHAR(255) NOT NULL, description VARCHAR(255) NULL)`)
  await run('INSERT parametres defaults', `INSERT IGNORE INTO parametres (cle,valeur,description) VALUES ('TAUX_INTERET_MENSUEL','2.5','Taux mensuel des prets (%)'),('PENALITE_ECHEC','5','Penalite echec remboursement (% capital)'),('NB_ECHEANCES_MAX','2','Nombre max echeances par pret')`)
  await run('CREATE prets', `CREATE TABLE IF NOT EXISTS prets (id INT AUTO_INCREMENT PRIMARY KEY, membre_id INT NOT NULL, montant_capital INT NOT NULL, taux_mensuel DECIMAL(5,2) NOT NULL DEFAULT 2.5, nb_echeances INT NOT NULL DEFAULT 2, date_debut DATE NOT NULL, statut ENUM('EN_COURS','REMBOURSE','EN_RETARD') NOT NULL DEFAULT 'EN_COURS', type_garantie ENUM('TONTINE','GARANT','PRESIDENT') NOT NULL, garant_id INT NULL, tontine_garantie_id INT NULL, reunion_octroi_id INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (membre_id) REFERENCES membres(id), FOREIGN KEY (reunion_octroi_id) REFERENCES reunions(id))`)
  await run('CREATE sanctions', `CREATE TABLE IF NOT EXISTS sanctions (id INT AUTO_INCREMENT PRIMARY KEY, reunion_id INT NOT NULL, membre_id INT NOT NULL, type ENUM('ECHEC_TONTINE','DOUBLE_ABSENCE','AUTRE') NOT NULL, description VARCHAR(255) NULL, montant INT NOT NULL DEFAULT 0, statut ENUM('NON_PAYEE','PAYEE') NOT NULL DEFAULT 'NON_PAYEE', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (reunion_id) REFERENCES reunions(id), FOREIGN KEY (membre_id) REFERENCES membres(id))`)

  if (!(await colExists('beneficiaires','montant_membre')))
    await run('ALTER beneficiaires ADD montant_membre', 'ALTER TABLE beneficiaires ADD COLUMN montant_membre INT NULL DEFAULT NULL')
  else console.log('ℹ️  beneficiaires.montant_membre déjà présent')

  // ── Phase 2 v2 ─────────────────────────────────────────────
  await run('DROP echeances_prets (old)', 'DROP TABLE IF EXISTS echeances_prets')
  await run('CREATE echeances_pret (new)', `CREATE TABLE IF NOT EXISTS echeances_pret (id INT AUTO_INCREMENT PRIMARY KEY, pret_id INT NOT NULL, numero INT NOT NULL, reunion_id INT NULL, montant_du INT NOT NULL, montant_paye INT NOT NULL DEFAULT 0, statut ENUM('EN_ATTENTE','PAYEE','ECHEC') NOT NULL DEFAULT 'EN_ATTENTE', FOREIGN KEY (pret_id) REFERENCES prets(id), FOREIGN KEY (reunion_id) REFERENCES reunions(id))`)

  // ── aides : statut + colonnes nullable ────────────────────────
  await run(
    'ALTER mouvements_caisse ADD BON_SORTIE',
    `ALTER TABLE mouvements_caisse MODIFY COLUMN categorie
       ENUM('COTISATION_TONTINE','COTISATION_RUBRIQUE','DEPOT_BANQUE','AIDE_SOCIALE','BON_SORTIE','DEPENSE','AUTRE')
       NOT NULL`
  )
  if (!(await colExists('aides', 'statut')))
    await run('ALTER aides ADD statut',
      `ALTER TABLE aides ADD COLUMN statut ENUM('ENREGISTREE','VALIDEE') NOT NULL DEFAULT 'ENREGISTREE'`)
  else console.log('ℹ️  aides.statut déjà présent')

  await run('ALTER aides montant_par_membre nullable',
    'ALTER TABLE aides MODIFY COLUMN montant_par_membre INT NULL DEFAULT NULL')
  await run('ALTER aides nb_membres_actifs nullable',
    'ALTER TABLE aides MODIFY COLUMN nb_membres_actifs INT NULL DEFAULT NULL')

  // ── echeances_pret : corrections ENUM + montant_interets ──────
  await run(
    'ALTER echeances_pret statut ENUM',
    `ALTER TABLE echeances_pret MODIFY COLUMN statut
       ENUM('EN_ATTENTE','PAYE','EN_RETARD','REECHELONNE','ECHEC')
       NOT NULL DEFAULT 'EN_ATTENTE'`
  )
  if (!(await colExists('echeances_pret', 'montant_interets')))
    await run('ALTER echeances_pret ADD montant_interets',
      'ALTER TABLE echeances_pret ADD COLUMN montant_interets INT NOT NULL DEFAULT 0')
  else console.log('ℹ️  echeances_pret.montant_interets déjà présent')

  if (!(await colExists('reunions','montant_rafraichissement')))
    await run('ALTER reunions ADD montant_rafraichissement', 'ALTER TABLE reunions ADD COLUMN montant_rafraichissement INT NOT NULL DEFAULT 0')
  else console.log('ℹ️  reunions.montant_rafraichissement déjà présent')

  if (!(await colExists('reunions','montant_amende_reouverture')))
    await run('ALTER reunions ADD montant_amende_reouverture', 'ALTER TABLE reunions ADD COLUMN montant_amende_reouverture INT NOT NULL DEFAULT 0')
  else console.log('ℹ️  reunions.montant_amende_reouverture déjà présent')

  await conn.end()
  console.log('\nMigration complète.')
  process.exit(0)
})().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
