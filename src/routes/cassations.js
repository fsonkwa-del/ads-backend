const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/cassationsController')

router.get('/',              ctrl.getAll)
router.get('/:id',           ctrl.getOne)
router.post('/simuler',      ctrl.simuler)
router.post('/',             ctrl.create)
router.post('/:id/valider',  ctrl.valider)

module.exports = router
