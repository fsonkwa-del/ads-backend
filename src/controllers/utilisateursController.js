const pool   = require('../config/db')
const bcrypt = require('bcryptjs')
const { logAudit } = require('../utils/audit')

const ROLES = ['ADMIN', 'SECRETAIRE', 'TRESORIER', 'LECTEUR']

// GET /api/utilisateurs
async function list(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.login, u.role, u.actif, u.doit_changer_mdp, u.derniere_connexion,
             u.membre_id, m.nom, m.prenom
      FROM utilisateurs u
      LEFT JOIN membres m ON m.id = u.membre_id
      WHERE u.deleted = 0
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
      WHERE m.statut='ACTIF' AND m.deleted = 0
        AND m.id NOT IN (SELECT membre_id FROM utilisateurs WHERE membre_id IS NOT NULL AND deleted = 0)
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

    const [[exist]] = await pool.query('SELECT id FROM utilisateurs WHERE login = ? AND deleted = 0', [login])
    if (exist) return res.status(409).json({ success: false, message: 'Cet identifiant est déjà utilisé.' })
    if (membre_id) {
      const [[u]] = await pool.query('SELECT id FROM utilisateurs WHERE membre_id = ? AND deleted = 0', [membre_id])
      if (u) return res.status(409).json({ success: false, message: 'Ce membre a déjà un compte.' })
    }

    const hash = await bcrypt.hash(String(mot_de_passe), 10)
    const [r] = await pool.query(
      'INSERT INTO utilisateurs (membre_id, login, mot_de_passe, role, doit_changer_mdp) VALUES (?, ?, ?, ?, 1)',
      [membre_id || null, login, hash, role]
    )
    await logAudit(pool, {
      utilisateur_id: req.user?.id, action: 'CREATION_COMPTE', table_cible: 'utilisateurs',
      id_cible: r.insertId, details: { login, role, membre_id: membre_id || null }, ip_adresse: req.ip,
    })
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
    await logAudit(pool, {
      utilisateur_id: req.user?.id, action: 'MODIFICATION_COMPTE', table_cible: 'utilisateurs',
      id_cible: Number(id), details: { role, actif }, ip_adresse: req.ip,
    })
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
    await logAudit(pool, {
      utilisateur_id: req.user?.id, action: 'RESET_MDP', table_cible: 'utilisateurs',
      id_cible: Number(id), details: 'Mot de passe réinitialisé par un administrateur', ip_adresse: req.ip,
    })
    res.json({ success: true, message: 'Mot de passe réinitialisé.' })
  } catch (err) { next(err) }
}

// DELETE /api/utilisateurs/:id  — suppression logique (soft delete)
async function remove(req, res, next) {
  try {
    const { id } = req.params
    const motif = req.body?.motif || req.body?.details || null
    if (Number(id) === Number(req.user.id))
      return res.status(400).json({ success: false, message: 'Vous ne pouvez pas supprimer votre propre compte.' })
    const [[u]] = await pool.query('SELECT role, login FROM utilisateurs WHERE id = ? AND deleted = 0', [id])
    if (!u) return res.status(404).json({ success: false, message: 'Compte introuvable.' })
    if (u.role === 'ADMIN') {
      const [[{ nb }]] = await pool.query("SELECT COUNT(*) AS nb FROM utilisateurs WHERE role='ADMIN' AND deleted = 0 AND id <> ?", [id])
      if (nb === 0) return res.status(400).json({ success: false, message: 'Impossible : dernier administrateur.' })
    }
    // Soft delete : deleted = id (libère login/membre via l'unicité composite), compte désactivé
    await pool.query('UPDATE utilisateurs SET deleted = id, actif = 0 WHERE id = ?', [id])
    await logAudit(pool, {
      utilisateur_id: req.user?.id, action: 'SUPPRESSION_COMPTE', table_cible: 'utilisateurs',
      id_cible: Number(id), details: { login: u.login, role: u.role, motif }, ip_adresse: req.ip,
    })
    res.json({ success: true, message: 'Compte supprimé.' })
  } catch (err) { next(err) }
}

module.exports = { list, membresSansCompte, create, update, resetPassword, remove }
