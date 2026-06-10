const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/sanctionsController')

router.get('/non-payees',    ctrl.getNonPayees)
router.put('/:id/encaisser', ctrl.encaisser)

module.exports = router
