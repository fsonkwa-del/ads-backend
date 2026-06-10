const pool   = require('../config/db')
const bcrypt = require('bcryptjs')
const jwt    = require('jsonwebtoken')

const SECRET  = process.env.JWT_SECRET
const EXPIRES = process.env.JWT_EXPIRES || '12h'

// POST /api/auth/login
async function login(req, res, next) {
  try {
    const { login, mot_de_passe } = req.body
    if (!login || !mot_de_passe)
      return res.status(400).json({ success: false, message: 'Identifiant et mot de passe requis.' })

    const [[u]] = await pool.query('SELECT * FROM utilisateurs WHERE login = ?', [login])
    if (!u || !u.actif || !(await bcrypt.compare(mot_de_passe, u.mot_de_passe)))
      return res.status(401).json({ success: false, message: 'Identifiants invalides.' })

    await pool.query('UPDATE utilisateurs SET derniere_connexion = NOW() WHERE id = ?', [u.id])
    const payload = { id: u.id, membre_id: u.membre_id, role: u.role, login: u.login }
    const token = jwt.sign(payload, SECRET, { expiresIn: EXPIRES })
    res.json({ success: true, data: { token, user: { ...payload, doit_changer_mdp: !!u.doit_changer_mdp } } })
  } catch (err) { next(err) }
}

// GET /api/auth/me
async function me(req, res, next) {
  try {
    const [[u]] = await pool.query(
      'SELECT id, membre_id, login, role, doit_changer_mdp FROM utilisateurs WHERE id = ?',
      [req.user.id]
    )
    if (!u) return res.status(404).json({ success: false, message: 'Compte introuvable.' })
    res.json({ success: true, data: { ...u, doit_changer_mdp: !!u.doit_changer_mdp } })
  } catch (err) { next(err) }
}

// POST /api/auth/change-password
async function changePassword(req, res, next) {
  try {
    const { ancien, nouveau } = req.body
    if (!nouveau || String(nouveau).length < 4)
      return res.status(400).json({ success: false, message: 'Le nouveau mot de passe doit faire au moins 4 caractères.' })

    const [[u]] = await pool.query('SELECT mot_de_passe FROM utilisateurs WHERE id = ?', [req.user.id])
    if (!u || !(await bcrypt.compare(ancien || '', u.mot_de_passe)))
      return res.status(400).json({ success: false, message: 'Ancien mot de passe incorrect.' })

    const hash = await bcrypt.hash(String(nouveau), 10)
    await pool.query('UPDATE utilisateurs SET mot_de_passe = ?, doit_changer_mdp = 0 WHERE id = ?', [hash, req.user.id])
    res.json({ success: true, message: 'Mot de passe modifié.' })
  } catch (err) { next(err) }
}

module.exports = { login, me, changePassword }
