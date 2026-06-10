const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/reunionsController')

router.get('/',                            ctrl.getAll)
router.get('/:id',                         ctrl.getOne)
router.post('/',                           ctrl.create)
router.put('/:id/sauvegarder',             ctrl.sauvegarder)
router.post('/:id/beneficiaire',           ctrl.setBeneficiaire)
router.post('/:id/valider',                ctrl.valider)
router.post('/:id/rouvrir',                ctrl.rouvrir)
router.post('/:id/sanctions',              ctrl.addSanction)
router.put('/:id/sanctions/:sid',          ctrl.updateSanction)
router.delete('/:id/sanctions/:sid',       ctrl.removeSanction)
router.delete('/:id',                      ctrl.remove)

module.exports = router
