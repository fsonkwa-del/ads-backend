const pool = require('../config/db')
const { arrondirFCFA } = require('../utils/money')

// GET /api/aides
async function getAll(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT a.*, m.nom, m.prenom,
        COUNT(ca.id)                                       AS nb_contributions,
        SUM(CASE WHEN ca.reconstitue=1 THEN 1 ELSE 0 END) AS nb_reconstitues
      FROM aides a
      LEFT JOIN membres m ON m.id = a.beneficiaire_id
      LEFT JOIN contributions_aide ca ON ca.aide_id = a.id
      GROUP BY a.id
      ORDER BY a.date_aide DESC
    `)
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
}

// GET /api/aides/:id
async function getOne(req, res, next) {
  try {
    const { id } = req.params
    const [[aide]] = await pool.query(`
      SELECT a.*, m.nom, m.prenom
      FROM aides a LEFT JOIN membres m ON m.id = a.beneficiaire_id
      WHERE a.id = ?
    `, [id])
    if (!aide) return res.status(404).json({ success: false, message: 'Aide introuvable' })

    const [contributions] = await pool.query(`
      SELECT ca.*, m.nom, m.prenom
      FROM contributions_aide ca JOIN membres m ON m.id = ca.membre_id
      WHERE ca.aide_id = ?
      ORDER BY ca.reconstitue ASC, m.nom, m.prenom
    `, [id])

    res.json({ success: true, data: { ...aide, contributions } })
  } catch (err) { next(err) }
}

// ── Helpers internes ─────────────────────────────────────────────

// Calcule montant_par_membre depuis une liste d'IDs ou tous les membres actifs
async function resolveMembres(membres_ids) {
  if (membres_ids && membres_ids.length > 0) {
    const ph = membres_ids.map(() => '?').join(',')
    const [rows] = await pool.query(
      `SELECT id FROM membres WHERE id IN (${ph}) AND statut = 'ACTIF'`,
      membres_ids
    )
    return rows
  }
  const [rows] = await pool.query("SELECT id FROM membres WHERE statut = 'ACTIF'")
  return rows
}

// POST /api/aides
// Body : { beneficiaire_id?, type_aide, montant_total, date_aide, membres_ids?: number[] }
// membres_ids : liste des membres contributeurs (tous les ACTIF par défaut)
async function create(req, res, next) {
  try {
    const { beneficiaire_id, type_aide, montant_total, date_aide, membres_ids } = req.body
    const isDev = type_aide === 'DEVELOPPEMENT'
    if ((!isDev && !beneficiaire_id) || !type_aide || !montant_total || !date_aide)
      return res.status(400).json({ success: false, message: isDev
        ? 'type_aide, montant_total et date_aide sont obligatoires'
        : 'beneficiaire_id, type_aide, montant_total et date_aide sont obligatoires' })

    const membres = await resolveMembres(membres_ids)
    const nb = membres.length
    if (!nb) return res.status(400).json({ success: false, message: 'Aucun membre actif sélectionné' })

    const montant_par_membre    = arrondirFCFA(Number(montant_total) / nb)
    const membres_contributeurs = JSON.stringify(membres.map(m => m.id))

    // INSERT sans membres_contributeurs d'abord (colonne peut ne pas exister encore)
    const [result] = await pool.query(`
      INSERT INTO aides
        (beneficiaire_id, type_aide, montant_total, montant_par_membre, nb_membres_actifs, date_aide, statut)
      VALUES (?, ?, ?, ?, ?, ?, 'ENREGISTREE')
    `, [beneficiaire_id || null, type_aide, montant_total, montant_par_membre, nb, date_aide])

    // Tentative de stockage de la liste membres (colonne JSON optionnelle)
    try {
      await pool.query('UPDATE aides SET membres_contributeurs=? WHERE id=?', [membres_contributeurs, result.insertId])
    } catch (_) { /* membres_contributeurs pas encore ajoutée en base — à exécuter : ALTER TABLE aides ADD COLUMN membres_contributeurs JSON NULL */ }

    res.status(201).json({ success: true, data: { id: result.insertId, montant_par_membre, nb_membres_actifs: nb } })
  } catch (err) { next(err) }
}

// PUT /api/aides/:id — modifier une aide ENREGISTREE
// Body : mêmes champs que create, dont membres_ids optionnel
async function update(req, res, next) {
  try {
    const { id } = req.params
    const { beneficiaire_id, type_aide, montant_total, date_aide, membres_ids } = req.body

    const [[aide]] = await pool.query('SELECT statut FROM aides WHERE id=?', [id])
    if (!aide)                    return res.status(404).json({ success: false, message: 'Aide introuvable' })
    if (aide.statut === 'VALIDEE') return res.status(400).json({ success: false, message: 'Impossible de modifier une aide validée' })

    const membres = await resolveMembres(membres_ids)
    const nb = membres.length
    if (!nb) return res.status(400).json({ success: false, message: 'Aucun membre actif sélectionné' })

    const montant_par_membre    = arrondirFCFA(Number(montant_total) / nb)
    const membres_contributeurs = JSON.stringify(membres.map(m => m.id))

    // UPDATE de base sans membres_contributeurs (résilient si colonne absente)
    await pool.query(`
      UPDATE aides SET
        beneficiaire_id=?, type_aide=?, montant_total=?,
        montant_par_membre=?, nb_membres_actifs=?, date_aide=?
      WHERE id=?
    `, [beneficiaire_id || null, type_aide, montant_total, montant_par_membre, nb, date_aide, id])

    // Tentative de mise à jour de la liste membres (colonne JSON optionnelle)
    try {
      await pool.query('UPDATE aides SET membres_contributeurs=? WHERE id=?', [membres_contributeurs, id])
    } catch (_) { /* membres_contributeurs pas encore ajoutée — voir ALTER TABLE */ }

    res.json({ success: true, message: 'Aide modifiée', data: { montant_par_membre, nb_membres_actifs: nb } })
  } catch (err) { next(err) }
}

// POST /api/aides/:id/valider — déductions + mouvement caisse
// Utilise la liste membres_contributeurs stockée à la création/modification.
// Fallback sur tous les membres ACTIF si colonne absente ou NULL.
async function valider(req, res, next) {
  let conn
  try {
    const { id } = req.params
    const date_validation = new Date().toISOString().split('T')[0]

    const [[aide]] = await pool.query(`
      SELECT a.*, m.nom, m.prenom
      FROM aides a LEFT JOIN membres m ON m.id = a.beneficiaire_id
      WHERE a.id = ?
    `, [id])
    if (!aide)                    return res.status(404).json({ success: false, message: 'Aide introuvable' })
    if (aide.statut === 'VALIDEE') return res.status(400).json({ success: false, message: 'Aide déjà validée' })

    // Résolution de la liste : JSON stocké > fallback tous ACTIF
    let ids = null
    if (aide.membres_contributeurs) {
      try {
        ids = typeof aide.membres_contributeurs === 'string'
          ? JSON.parse(aide.membres_contributeurs)
          : aide.membres_contributeurs
      } catch (_) { ids = null }
    }
    const membresActifs = await resolveMembres(ids)
    const nb = membresActifs.length
    if (!nb) return res.status(400).json({ success: false, message: 'Aucun membre contributeur trouvé' })

    const montant_par_membre = aide.montant_par_membre
      ? Number(aide.montant_par_membre)
      : arrondirFCFA(Number(aide.montant_total) / nb)

    const limitDate = new Date(date_validation)
    limitDate.setMonth(limitDate.getMonth() + 3)
    const date_limite = limitDate.toISOString().split('T')[0]

    conn = await pool.getConnection()
    await conn.beginTransaction()

    await conn.query(
      `UPDATE aides SET statut='VALIDEE', montant_par_membre=?, nb_membres_actifs=? WHERE id=?`,
      [montant_par_membre, nb, id]
    )

    for (const m of membresActifs) {
      await conn.query(
        `INSERT INTO contributions_aide (aide_id, membre_id, montant_deduit, date_limite_reconstitution)
         VALUES (?, ?, ?, ?)`,
        [id, m.id, montant_par_membre, date_limite]
      )
      await conn.query(
        `INSERT INTO soldes_membres (membre_id, fond_caisse, fond_banque) VALUES (?, ?, 0)
         ON DUPLICATE KEY UPDATE fond_caisse = fond_caisse - ?`,
        [m.id, -montant_par_membre, montant_par_membre]
      )
    }

    await conn.query(
      `INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description)
       VALUES (?, 'SORTIE', 'BON_SORTIE', ?, ?)`,
      [date_validation, aide.montant_total,
        aide.prenom
          ? `Aide ${aide.type_aide.replace(/_/g, ' ')} – ${aide.prenom} ${aide.nom}`
          : `Contribution ${aide.type_aide.replace(/_/g, ' ')} – collectif`]
    )

    await conn.commit()
    res.json({
      success: true,
      message: `Aide validée — ${nb} membres débités de ${montant_par_membre} FCFA`,
      data: { montant_par_membre, nb_membres_actifs: nb }
    })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// POST /api/aides/:id/annuler — remet une aide VALIDEE en ENREGISTREE
// Restitue le fond_caisse de chaque membre et supprime les contributions_aide
async function annuler(req, res, next) {
  let conn
  try {
    const { id } = req.params
    const [[aide]] = await pool.query('SELECT * FROM aides WHERE id = ?', [id])
    if (!aide)                        return res.status(404).json({ success: false, message: 'Aide introuvable' })
    if (aide.statut !== 'VALIDEE')    return res.status(400).json({ success: false, message: 'Seule une aide validée peut être annulée' })

    const [contributions] = await pool.query(
      'SELECT membre_id, montant_deduit FROM contributions_aide WHERE aide_id = ?', [id]
    )

    conn = await pool.getConnection()
    await conn.beginTransaction()

    // Restituer le fond_caisse de chaque membre
    for (const c of contributions) {
      await conn.query(
        'UPDATE soldes_membres SET fond_caisse = fond_caisse + ? WHERE membre_id = ?',
        [Number(c.montant_deduit), c.membre_id]
      )
    }

    // Supprimer les contributions et le mouvement caisse associé
    await conn.query('DELETE FROM contributions_aide WHERE aide_id = ?', [id])
    await conn.query(
      `DELETE FROM mouvements_caisse WHERE categorie = 'BON_SORTIE' AND montant = ? AND description LIKE ?`,
      [aide.montant_total, `%${aide.type_aide.replace(/_/g, ' ')}%`]
    )

    // Remettre l'aide en ENREGISTREE
    await conn.query(
      "UPDATE aides SET statut = 'ENREGISTREE', montant_par_membre = NULL, nb_membres_actifs = NULL WHERE id = ?",
      [id]
    )

    await conn.commit()
    res.json({ success: true, message: `Aide annulée — ${contributions.length} membres recrédités` })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

module.exports = { getAll, getOne, create, update, valider, annuler }
