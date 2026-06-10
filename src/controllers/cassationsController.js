const pool = require('../config/db')
const { arrondirFCFA } = require('../utils/money')

// GET /api/cassations
async function getAll(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT c.*, COUNT(cd.id) AS nb_membres
      FROM cassations c
      LEFT JOIN cassation_details cd ON cd.cassation_id = c.id
      GROUP BY c.id
      ORDER BY c.annee DESC
    `)
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
}

// GET /api/cassations/:id
async function getOne(req, res, next) {
  try {
    const { id } = req.params
    const [[cassation]] = await pool.query('SELECT * FROM cassations WHERE id=?', [id])
    if (!cassation) return res.status(404).json({ success: false, message: 'Cassation introuvable' })

    const [details] = await pool.query(`
      SELECT cd.*, m.nom, m.prenom
      FROM cassation_details cd JOIN membres m ON m.id = cd.membre_id
      WHERE cd.cassation_id = ?
      ORDER BY m.nom, m.prenom
    `, [id])
    res.json({ success: true, data: { ...cassation, details } })
  } catch (err) { next(err) }
}

// POST /api/cassations/simuler
async function simuler(req, res, next) {
  try {
    const { annee, total_interets_annee } = req.body
    if (!annee) return res.status(400).json({ success: false, message: 'annee est obligatoire' })

    // Soldes banque de tous les membres actifs
    const [soldes] = await pool.query(`
      SELECT m.id AS membre_id, m.nom, m.prenom,
        COALESCE(s.fond_banque, 0) AS fond_banque
      FROM membres m
      LEFT JOIN soldes_membres s ON s.membre_id = m.id
      WHERE m.statut = 'ACTIF'
      ORDER BY m.nom, m.prenom
    `)

    const total_cotisations_banque = soldes.reduce((s, r) => s + Number(r.fond_banque), 0)

    // Auto-calcul des intérêts si non fourni
    let interets = Number(total_interets_annee) || 0
    if (!interets) {
      const [[row]] = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN type_mvt='ENTREE' AND description LIKE 'Remboursements prêts%' THEN montant ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN type_mvt='SORTIE' AND description LIKE 'Prêt octroyé%' THEN montant ELSE 0 END), 0)
        AS calc_interets
        FROM mouvements_caisse
        WHERE YEAR(date_mvt) = ?
      `, [annee])
      interets = Math.max(0, Number(row.calc_interets) || 0)
    }

    const details = soldes.map(s => {
      const fond_banque = Number(s.fond_banque)
      const part_interets = total_cotisations_banque > 0
        ? arrondirFCFA(fond_banque / total_cotisations_banque * interets)
        : 0
      return {
        membre_id:         s.membre_id,
        nom:               s.nom,
        prenom:            s.prenom,
        solde_banque:      fond_banque,
        cotisations_banque: fond_banque,
        part_interets,
        montant_restitue:  fond_banque + part_interets,
      }
    })

    res.json({
      success: true,
      data: {
        annee: Number(annee),
        total_cotisations_banque,
        total_interets_annee: interets,
        total_restitue: details.reduce((s, d) => s + d.montant_restitue, 0),
        details,
      }
    })
  } catch (err) { next(err) }
}

// POST /api/cassations
async function create(req, res, next) {
  let conn
  try {
    const { annee, total_interets_annee, date_cassation, details } = req.body

    if (!annee || !date_cassation || !details?.length)
      return res.status(400).json({ success: false, message: 'annee, date_cassation et details sont obligatoires' })

    conn = await pool.getConnection()
    await conn.beginTransaction()

    const total_cotisations_banque = details.reduce((s, d) => s + d.cotisations_banque, 0)
    const total_restitue           = details.reduce((s, d) => s + d.montant_restitue, 0)

    const [result] = await conn.query(`
      INSERT INTO cassations (annee, total_interets_annee, total_cotisations_banque, date_cassation, statut)
      VALUES (?, ?, ?, ?, 'SIMULEE')
    `, [annee, total_interets_annee, total_cotisations_banque, date_cassation])
    const cassation_id = result.insertId

    for (const d of details) {
      await conn.query(`
        INSERT INTO cassation_details (cassation_id, membre_id, solde_banque, cotisations_banque, part_interets, montant_restitue)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [cassation_id, d.membre_id, d.solde_banque, d.cotisations_banque, d.part_interets, d.montant_restitue])
    }

    await conn.commit()
    res.status(201).json({ success: true, data: { id: cassation_id } })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// POST /api/cassations/:id/valider
async function valider(req, res, next) {
  let conn
  try {
    const { id } = req.params

    const [[cassation]] = await pool.query('SELECT * FROM cassations WHERE id=?', [id])
    if (!cassation) return res.status(404).json({ success: false, message: 'Cassation introuvable' })
    if (cassation.statut === 'VALIDEE')
      return res.status(400).json({ success: false, message: 'Cassation déjà validée' })

    const [details] = await pool.query('SELECT * FROM cassation_details WHERE cassation_id=?', [id])

    conn = await pool.getConnection()
    await conn.beginTransaction()

    // Remet fond_banque à 0 pour tous les membres concernés
    for (const d of details) {
      await conn.query(
        'UPDATE soldes_membres SET fond_banque = 0 WHERE membre_id=?', [d.membre_id]
      )
    }

    const total_restitue = details.reduce((s, d) => s + Number(d.montant_restitue), 0)

    // Mouvement SORTIE global
    await conn.query(`
      INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description)
      VALUES (?, 'SORTIE', 'AUTRE', ?, ?)
    `, [cassation.date_cassation, total_restitue,
        `Cassation ${cassation.annee} – restitution banque + intérêts (${details.length} membres)`])

    await conn.query('UPDATE cassations SET statut="VALIDEE" WHERE id=?', [id])
    await conn.commit()

    res.json({ success: true, message: 'Cassation validée', data: { total_restitue } })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

module.exports = { getAll, getOne, simuler, create, valider }
