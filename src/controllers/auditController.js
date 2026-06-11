const pool = require('../config/db')

// GET /api/audit  (ADMIN) — journal d'audit, filtres ?action= &table_cible= &limit=
async function getAuditLogs(req, res, next) {
  try {
    const { action, table_cible, limit } = req.query
    const conds = []; const params = []
    if (action)      { conds.push('j.action = ?');      params.push(action) }
    if (table_cible) { conds.push('j.table_cible = ?'); params.push(table_cible) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    const lim = Math.min(Math.max(parseInt(limit) || 300, 1), 2000)

    const [rows] = await pool.query(`
      SELECT j.id, j.action, j.table_cible, j.id_cible, j.details, j.ip_adresse, j.created_at,
             j.utilisateur_id, u.login AS acteur_login, u.role AS acteur_role
      FROM journaux_audit j
      LEFT JOIN utilisateurs u ON u.id = j.utilisateur_id
      ${where}
      ORDER BY j.id DESC
      LIMIT ${lim}
    `, params)

    const [actions] = await pool.query('SELECT DISTINCT action FROM journaux_audit ORDER BY action')
    res.json({ success: true, data: rows, actions: actions.map(a => a.action) })
  } catch (err) { next(err) }
}

module.exports = { getAuditLogs }
