const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/auditController')
const { requireRole } = require('../middleware/auth')

// Consultation réservée aux administrateurs
router.get('/', requireRole('ADMIN'), ctrl.getAuditLogs)

module.exports = router
