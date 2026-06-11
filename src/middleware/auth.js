const jwt = require('jsonwebtoken')
const pool = require('../config/db')
const SECRET = process.env.JWT_SECRET

// Vérifie le jeton (en-tête Authorization: Bearer, ou ?token= pour les téléchargements)
// PUIS interroge la base à chaque requête : le compte doit exister, être actif et
// non supprimé (deleted = 0). Cela invalide immédiatement un compte désactivé/supprimé.
async function auth(req, res, next) {
  const h = req.headers.authorization || ''
  const token = (h.startsWith('Bearer ') ? h.slice(7) : null) || req.query.token || null
  if (!token) return res.status(401).json({ success: false, message: 'Authentification requise.' })

  let payload
  try {
    payload = jwt.verify(token, SECRET)   // { id, membre_id, role, login }
  } catch (_) {
    return res.status(401).json({ success: false, message: 'Session expirée ou invalide.' })
  }

  try {
    const [[dbUser]] = await pool.query('SELECT actif, deleted, role FROM utilisateurs WHERE id = ?', [payload.id])
    if (!dbUser || !dbUser.actif || dbUser.deleted > 0) {
      return res.status(401).json({ success: false, message: 'Compte désactivé, supprimé ou inexistant.' })
    }
    // Le rôle de référence est celui en base (pas celui — potentiellement périmé — du token)
    req.user = { ...payload, role: dbUser.role }
    next()
  } catch (err) { next(err) }
}

// Autorisation par domaine : lecture (GET) ouverte à tout compte authentifié,
// écritures (POST/PUT/DELETE) réservées selon le rôle. ADMIN a tous les droits.
// Séparation des tâches (RBAC statique). ADMIN a tous les droits (court-circuit ci-dessous).
//  · SECRETAIRE : membres, tontines, souscriptions, réunions/présences, bureau (pas de finances)
//  · TRESORIER  : caisse, prêts, sanctions, aides, cassations, soldes (pas d'admin ni membres)
//  · ADMIN      : utilisateurs, paramètres (+ tout le reste)
const WRITE_ROLES = {
  '/api/membres':       ['ADMIN', 'SECRETAIRE'],
  '/api/tontines':      ['ADMIN', 'SECRETAIRE'],
  '/api/souscriptions': ['ADMIN', 'SECRETAIRE'],
  '/api/reunions':      ['ADMIN', 'SECRETAIRE'],
  '/api/bureau':        ['ADMIN', 'SECRETAIRE'],
  '/api/caisse':        ['ADMIN', 'TRESORIER'],
  '/api/aides':         ['ADMIN', 'TRESORIER'],
  '/api/cassations':    ['ADMIN', 'TRESORIER'],
  '/api/prets':         ['ADMIN', 'TRESORIER'],
  '/api/sanctions':     ['ADMIN', 'TRESORIER'],
  '/api/soldes':        ['ADMIN', 'TRESORIER'],
  '/api/parametres':    ['ADMIN'],
  '/api/utilisateurs':  ['ADMIN'],
}

function authorize(req, res, next) {
  if (req.method === 'GET' || req.method === 'OPTIONS') return next()
  if (req.user.role === 'ADMIN') return next()
  const entry = Object.entries(WRITE_ROLES).find(([p]) => req.path.startsWith(p))
  const allowed = entry ? entry[1] : ['ADMIN']
  if (!allowed.includes(req.user.role))
    return res.status(403).json({ success: false, message: 'Droits insuffisants pour cette action.' })
  next()
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Droits insuffisants.' })
    next()
  }
}

module.exports = { auth, authorize, requireRole }
