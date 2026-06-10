const pool   = require('../config/db')
const bcrypt = require('bcryptjs')

const ROLES = ['ADMIN', 'SECRETAIRE', 'TRESORIER', 'LECTEUR']

// GET /api/utilisateurs
async function list(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.login, u.role, u.actif, u.doit_changer_mdp, u.derniere_connexion,
             u.membre_id, m.nom, m.prenom
      FROM utilisateurs u
      LEFT JOIN membres m ON m.id = u.membre_id
      ORDER BY FIELD(u.role,'ADMIN','SECRETAIRE','TRESORIER','LECTEUR'), u.login
    `)
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
}

// GET /api/utilisateurs/membres-sans-compte  (pour créer un compte rattaché)
async function membresSansCompte(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT m.id, m.nom, m.prenom FROM membres m
      WHERE m.statut='ACTIF' AND m.id NOT IN (SELECT membre_id FROM utilisateurs WHERE membre_id IS NOT NULL)
      ORDER BY m.nom, m.prenom
    `)
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
}

// POST /api/utilisateurs
async function create(req, res, next) {
  try {
    const { login, mot_de_passe, role, membre_id } = req.body
    if (!login || !mot_de_passe || !role)
      return res.status(400).json({ success: false, message: 'login, mot_de_passe et role sont obligatoires.' })
    if (!ROLES.includes(role)) return res.status(400).json({ success: false, message: 'Rôle invalide.' })

    const [[exist]] = await pool.query('SELECT id FROM utilisateurs WHERE login = ?', [login])
    if (exist) return res.status(409).json({ success: false, message: 'Cet identifiant est déjà utilisé.' })
    if (membre_id) {
      const [[u]] = await pool.query('SELECT id FROM utilisateurs WHERE membre_id = ?', [membre_id])
      if (u) return res.status(409).json({ success: false, message: 'Ce membre a déjà un compte.' })
    }

    const hash = await bcrypt.hash(String(mot_de_passe), 10)
    const [r] = await pool.query(
      'INSERT INTO utilisateurs (membre_id, login, mot_de_passe, role, doit_changer_mdp) VALUES (?, ?, ?, ?, 1)',
      [membre_id || null, login, hash, role]
    )
    res.status(201).json({ success: true, data: { id: r.insertId } })
  } catch (err) { next(err) }
}

// PUT /api/utilisateurs/:id  (rôle / actif)
async function update(req, res, next) {
  try {
    const { id } = req.params
    const { role, actif } = req.body
    const [[u]] = await pool.query('SELECT id, role, actif FROM utilisateurs WHERE id = ?', [id])
    if (!u) return res.status(404).json({ success: false, message: 'Compte introuvable.' })

    // Ne pas retirer le dernier administrateur actif
    if ((role && role !== 'ADMIN' && u.role === 'ADMIN') || (actif === 0 && u.role === 'ADMIN')) {
      const [[{ nb }]] = await pool.query("SELECT COUNT(*) AS nb FROM utilisateurs WHERE role='ADMIN' AND actif=1 AND id <> ?", [id])
      if (nb === 0) return res.status(400).json({ success: false, message: 'Impossible : c\'est le dernier administrateur actif.' })
    }
    if (role && !ROLES.includes(role)) return res.status(400).json({ success: false, message: 'Rôle invalide.' })

    const fields = [], params = []
    if (role !== undefined)  { fields.push('role=?');  params.push(role) }
    if (actif !== undefined) { fields.push('actif=?'); params.push(actif ? 1 : 0) }
    if (!fields.length) return res.json({ success: true, message: 'Rien à modifier.' })
    params.push(id)
    await pool.query(`UPDATE utilisateurs SET ${fields.join(', ')} WHERE id = ?`, params)
    res.json({ success: true, message: 'Compte mis à jour.' })
  } catch (err) { next(err) }
}

// POST /api/utilisateurs/:id/reset-password
async function resetPassword(req, res, next) {
  try {
    const { id } = req.params
    const { mot_de_passe } = req.body
    if (!mot_de_passe || String(mot_de_passe).length < 4)
      return res.status(400).json({ success: false, message: 'Mot de passe trop court (min 4 caractères).' })
    const [[u]] = await pool.query('SELECT id FROM utilisateurs WHERE id = ?', [id])
    if (!u) return res.status(404).json({ success: false, message: 'Compte introuvable.' })
    const hash = await bcrypt.hash(String(mot_de_passe), 10)
    await pool.query('UPDATE utilisateurs SET mot_de_passe = ?, doit_changer_mdp = 1 WHERE id = ?', [hash, id])
    res.json({ success: true, message: 'Mot de passe réinitialisé.' })
  } catch (err) { next(err) }
}

// DELETE /api/utilisateurs/:id
async function remove(req, res, next) {
  try {
    const { id } = req.params
    if (Number(id) === Number(req.user.id))
      return res.status(400).json({ success: false, message: 'Vous ne pouvez pas supprimer votre propre compte.' })
    const [[u]] = await pool.query('SELECT role FROM utilisateurs WHERE id = ?', [id])
    if (!u) return res.status(404).json({ success: false, message: 'Compte introuvable.' })
    if (u.role === 'ADMIN') {
      const [[{ nb }]] = await pool.query("SELECT COUNT(*) AS nb FROM utilisateurs WHERE role='ADMIN' AND id <> ?", [id])
      if (nb === 0) return res.status(400).json({ success: false, message: 'Impossible : dernier administrateur.' })
    }
    await pool.query('DELETE FROM utilisateurs WHERE id = ?', [id])
    res.json({ success: true, message: 'Compte supprimé.' })
  } catch (err) { next(err) }
}

module.exports = { list, membresSansCompte, create, update, resetPassword, remove }
