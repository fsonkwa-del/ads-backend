const pool = require('../config/db')

// GET /api/sanctions/non-payees
// Retourne toutes les sanctions NON_PAYEE, toutes réunions confondues
async function getNonPayees(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT s.*, m.nom, m.prenom, r.date_reunion
      FROM sanctions s
      JOIN membres m ON m.id = s.membre_id
      JOIN reunions r ON r.id = s.reunion_id
      WHERE s.statut = 'NON_PAYEE'
      ORDER BY r.date_reunion ASC
    `)
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
}

// PUT /api/sanctions/:id/encaisser
// Marque la sanction comme PAYEE et crée le mouvement caisse correspondant
async function encaisser(req, res, next) {
  let conn
  try {
    const { id } = req.params
    const [[s]] = await pool.query('SELECT * FROM sanctions WHERE id = ?', [id])
    if (!s) return res.status(404).json({ success: false, message: 'Sanction introuvable' })
    if (s.statut === 'PAYEE') return res.status(400).json({ success: false, message: 'Sanction déjà encaissée' })

    conn = await pool.getConnection()
    await conn.beginTransaction()

    await conn.query('UPDATE sanctions SET statut = "PAYEE" WHERE id = ?', [id])

    if (Number(s.montant) > 0) {
      const [[m]] = await conn.query('SELECT nom, prenom FROM membres WHERE id = ?', [s.membre_id])
      await conn.query(`
        INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description)
        VALUES (CURDATE(), 'ENTREE', 'AUTRE', ?, ?)
      `, [s.montant, `Sanction encaissée – ${m.prenom} ${m.nom} (${s.type})`])
    }

    await conn.commit()
    res.json({ success: true, message: 'Sanction encaissée' })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

module.exports = { getNonPayees, encaisser }
