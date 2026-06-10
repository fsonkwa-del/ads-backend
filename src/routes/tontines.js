const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/tontinesController')

router.get('/',                              ctrl.getAll)
router.get('/:id',                           ctrl.getOne)
router.post('/',                             ctrl.create)
router.put('/:id',                           ctrl.update)
router.delete('/:id',                        ctrl.remove)
router.get('/:id/souscriptions',             ctrl.getSouscriptions)
router.get('/:id/apercu-rattrapage',         ctrl.apercuRattrapage)
router.get('/:id/historique-beneficiaires',  ctrl.historiqueBeneficiaires)
router.post('/:id/nouveau-tour',             ctrl.nouveauTour)

module.exports = router
