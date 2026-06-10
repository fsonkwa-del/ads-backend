const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/utilisateursController')

// Toutes ces routes sont déjà protégées par le middleware global + authorize (ADMIN).
router.get('/',                    ctrl.list)
router.get('/membres-sans-compte', ctrl.membresSansCompte)
router.post('/',                   ctrl.create)
router.put('/:id',                 ctrl.update)
router.post('/:id/reset-password', ctrl.resetPassword)
router.delete('/:id',              ctrl.remove)

module.exports = router
