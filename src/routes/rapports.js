const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/rapportsController')

router.get('/reunion/:id',        ctrl.rapportReunion)
router.get('/reunion/:id/pdf',    ctrl.pdfReunion)
router.get('/reunion/:id/excel',  ctrl.excelReunion)

router.get('/membres',            ctrl.rapportMembres)
router.get('/membres/pdf',        ctrl.pdfMembres)
router.get('/membres/excel',      ctrl.excelMembres)

router.get('/bilan',              ctrl.rapportBilan)
router.get('/bilan/pdf',          ctrl.pdfBilan)
router.get('/bilan/excel',        ctrl.excelBilan)

router.get('/prets',              ctrl.rapportPrets)
router.get('/prets/pdf',          ctrl.pdfPrets)
router.get('/prets/excel',        ctrl.excelPrets)

router.get('/bureau/pdf',         ctrl.pdfBureau)

module.exports = router
