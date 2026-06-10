const pool = require('../config/db')

// GET /api/soldes
async function getAll(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT m.id, m.nom, m.prenom, m.statut,
        COALESCE(s.fond_caisse, 0) AS fond_caisse,
        COALESCE(s.fond_banque,  0) AS fond_banque,
        s.updated_at
      FROM membres m
      LEFT JOIN soldes_membres s ON s.membre_id = m.id
      WHERE m.statut = 'ACTIF'
      ORDER BY m.nom, m.prenom
    `)
    const [[totaux]] = await pool.query(`
      SELECT COALESCE(SUM(fond_caisse),0) AS total_caisse,
             COALESCE(SUM(fond_banque), 0) AS total_banque
      FROM soldes_membres
    `)
    res.json({ success: true, data: rows, totaux })
  } catch (err) { next(err) }
}

module.exports = { getAll }
