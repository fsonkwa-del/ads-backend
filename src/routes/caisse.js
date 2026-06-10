const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/caisseController')

router.get('/soldes',              ctrl.getSoldes)
router.get('/tresorerie',          ctrl.getTresorerie)
router.get('/mouvements',          ctrl.getMouvements)
router.post('/mouvements',         ctrl.addMouvement)
router.put('/mouvements/:id',      ctrl.updateMouvement)
router.delete('/mouvements/:id',   ctrl.deleteMouvement)
router.get('/reconstitutions',     ctrl.getReconstitutions)
router.post('/cassation/simuler',  ctrl.simulerCassation)
router.post('/cassation/valider',  ctrl.validerCassation)

module.exports = router
