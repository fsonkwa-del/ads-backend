const pool = require('../config/db')

// GET /api/parametres
async function getAll(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT * FROM parametres ORDER BY cle')
    res.json({ success: true, data: rows })
  } catch (err) {
    next(err)
  }
}

// PUT /api/parametres/:cle  (upsert : crée la clé si elle n'existe pas encore)
async function update(req, res, next) {
  try {
    const { cle } = req.params
    const { valeur } = req.body

    if (valeur === undefined || valeur === '')
      return res.status(400).json({ success: false, message: 'valeur est obligatoire' })

    await pool.query(
      'INSERT INTO parametres (cle, valeur) VALUES (?, ?) ON DUPLICATE KEY UPDATE valeur = ?',
      [cle, String(valeur), String(valeur)]
    )
    res.json({ success: true, message: 'Paramètre mis à jour' })
  } catch (err) {
    next(err)
  }
}

module.exports = { getAll, update }
