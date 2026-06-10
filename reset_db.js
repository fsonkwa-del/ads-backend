const mysql = require('mysql2/promise')
require('dotenv').config()

async function reset() {
  let conn
  try {
    conn = await mysql.createConnection({
      host:     process.env.DB_HOST,
      port:     process.env.DB_PORT,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    })

    console.log('🔌 Connexion MySQL réussie.')

    // Désactiver les clés étrangères pour permettre le TRUNCATE
    await conn.query('SET FOREIGN_KEY_CHECKS = 0')
    console.log('🔒 Désactivation des clés étrangères.')

    // Récupérer la liste de toutes les tables/vues
    const [tables] = await conn.query('SHOW FULL TABLES')
    const key = `Tables_in_${process.env.DB_NAME}`
    const typeKey = 'Table_type'

    for (const row of tables) {
      const tableName = row[key]
      const tableType = row[typeKey] || 'BASE TABLE'

      if (tableType === 'VIEW') {
        console.log(`ℹ️  Saut de la vue : ${tableName}`)
        continue
      }

      try {
        await conn.query(`TRUNCATE TABLE \`${tableName}\``)
        console.log(`🧹 Table réinitialisée : ${tableName}`)
      } catch (err) {
        console.log(`⚠️  Impossible de vider ${tableName} (erreur ignorée) :`, err.message)
      }
    }

    // Réactiver les clés étrangères
    await conn.query('SET FOREIGN_KEY_CHECKS = 1')
    console.log('🔓 Réactivation des clés étrangères.')

    // Insérer les paramètres par défaut
    await conn.query(`
      INSERT INTO parametres (cle, valeur, description) VALUES
      ('TAUX_INTERET_MENSUEL', '2.5', 'Taux mensuel des prêts (%)'),
      ('PENALITE_ECHEC', '5', 'Pénalité échec remboursement (% capital dû)'),
      ('NB_ECHEANCES_MAX', '2', 'Nombre max d\\'échéances par prêt'),
      ('FONDS_CIBLE_TOTAL', '60000', 'Fonds cible par membre'),
      ('FONDS_DEVELOPPEMENT', '20000', 'Part fonds développement'),
      ('FONDS_SOCIAL', '40000', 'Part fonds social'),
      ('DELAI_RECONSTITUTION', '6', 'Délai reconstitution fond (séances)'),
      ('RAFRAICHISSEMENT_FORFAIT', '0', 'Rafraîchissement (forfait)')
      ON DUPLICATE KEY UPDATE valeur=VALUES(valeur)
    `)
    console.log('⚙️ Paramètres système par défaut insérés.')

    // Insérer la tontine "PRESENCE" par défaut
    await conn.query(`
      INSERT INTO tontines (nom, montant_par_part, type, actif, tour_actuel, nb_reunions_tour)
      VALUES ('Épargne Présence', 5000, 'PRESENCE', 1, 1, 0)
    `)
    console.log('💰 Tontine de présence par défaut créée (Épargne Présence - 5000 FCFA/part).')

    console.log('\n✨ Base de données réinitialisée avec succès et prête pour le test !')
  } catch (err) {
    console.error('❌ Erreur de réinitialisation :', err.message)
  } finally {
    if (conn) await conn.end()
  }
}

reset()
