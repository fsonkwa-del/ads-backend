const express = require('express')
const cors = require('cors')
require('dotenv').config()

const errorHandler = require('./middleware/errorHandler')
const membresRoutes       = require('./routes/membres')
const tontinesRoutes      = require('./routes/tontines')
const souscriptionsRoutes = require('./routes/souscriptions')
const reunionsRoutes      = require('./routes/reunions')
const pretsRoutes         = require('./routes/prets')
const parametresRoutes    = require('./routes/parametres')
const soldesRoutes        = require('./routes/soldesMembres')
const aidesRoutes         = require('./routes/aides')
const cassationsRoutes    = require('./routes/cassations')
const caisseRoutes        = require('./routes/caisse')
const rapportsRoutes      = require('./routes/rapports')
const sanctionsRoutes     = require('./routes/sanctions')
const bureauRoutes        = require('./routes/bureau')
const authRoutes          = require('./routes/auth')
const utilisateursRoutes  = require('./routes/utilisateurs')
const auditRoutes         = require('./routes/audit')
const { auth, authorize } = require('./middleware/auth')

const app = express()

// CORS : restreint au frontend si CORS_ORIGIN est défini, sinon ouvert (démo).
app.use(cors({ origin: process.env.CORS_ORIGIN || true }))
app.use(express.json())
app.use('/uploads', express.static('uploads'))

// ── Routes publiques ──────────────────────────────────────────
app.use('/api/auth', authRoutes)
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'ADS API opérationnelle' })
})

// ── À partir d'ici : authentification + autorisation par rôle ──
app.use(auth)
app.use(authorize)

// Routes
app.use('/api/membres',       membresRoutes)
app.use('/api/tontines',      tontinesRoutes)
app.use('/api/souscriptions', souscriptionsRoutes)
app.use('/api/reunions',      reunionsRoutes)
app.use('/api/prets',        pretsRoutes)
app.use('/api/parametres',   parametresRoutes)
app.use('/api/soldes',       soldesRoutes)
app.use('/api/aides',        aidesRoutes)
app.use('/api/cassations',   cassationsRoutes)
app.use('/api/caisse',       caisseRoutes)
app.use('/api/rapports',    rapportsRoutes)
app.use('/api/sanctions',   sanctionsRoutes)
app.use('/api/bureau',      bureauRoutes)
app.use('/api/utilisateurs', utilisateursRoutes)
app.use('/api/audit',        auditRoutes)

app.use(errorHandler)

module.exports = app
