// Seed des comptes : 1 administrateur + 1 compte LECTEUR par membre actif.
// Idempotent : ne recrée pas les comptes déjà existants.
//   node src/seed/seed_utilisateurs.js
require('dotenv').config()
const pool   = require('../config/db')
const bcrypt = require('bcryptjs')

const ADMIN_LOGIN = 'admin'
const ADMIN_PWD   = 'admin2026'
const MEMBRE_PWD  = 'tontine2026'

const slug = s => String(s).normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 40)

async function run() {
  const adminHash  = await bcrypt.hash(ADMIN_PWD, 10)
  const membreHash = await bcrypt.hash(MEMBRE_PWD, 10)

  // Administrateur
  await pool.query(
    `INSERT INTO utilisateurs (membre_id, login, mot_de_passe, role, doit_changer_mdp)
     VALUES (NULL, ?, ?, 'ADMIN', 1)
     ON DUPLICATE KEY UPDATE login = login`,
    [ADMIN_LOGIN, adminHash]
  )

  // Un compte LECTEUR par membre actif sans compte
  const [membres]  = await pool.query("SELECT id, nom, prenom FROM membres WHERE statut='ACTIF'")
  const [existing] = await pool.query('SELECT login FROM utilisateurs')
  const used = new Set(existing.map(u => u.login))
  let created = 0
  for (const m of membres) {
    const [[has]] = await pool.query('SELECT id FROM utilisateurs WHERE membre_id = ?', [m.id])
    if (has) continue
    const base = slug(`${m.prenom}.${m.nom}`) || `membre${m.id}`
    let login = base, n = 1
    while (used.has(login)) login = `${base}${++n}`
    used.add(login)
    await pool.query(
      `INSERT INTO utilisateurs (membre_id, login, mot_de_passe, role, doit_changer_mdp)
       VALUES (?, ?, ?, 'LECTEUR', 1)`,
      [m.id, login, membreHash]
    )
    created++
  }

  console.log(`✅ Seed terminé.`)
  console.log(`   Admin : login "${ADMIN_LOGIN}" / mot de passe "${ADMIN_PWD}"`)
  console.log(`   ${created} compte(s) membre créé(s) (rôle LECTEUR) / mot de passe "${MEMBRE_PWD}"`)
  console.log(`   ⚠ Changement de mot de passe forcé à la 1re connexion.`)
  process.exit(0)
}
run().catch(err => { console.error('❌ Seed échoué :', err.message); process.exit(1) })
