const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/bureauController')

router.get('/',                          ctrl.getCurrent)
router.get('/historique',                ctrl.getHistorique)
router.post('/mandats',                  ctrl.createMandat)
router.put('/mandats/:id',               ctrl.updateMandat)
router.post('/mandats/:id/renouveler',   ctrl.renouveler)
router.post('/mandats/:id/cloturer',     ctrl.cloturer)
router.delete('/mandats/:id',            ctrl.remove)

module.exports = router
