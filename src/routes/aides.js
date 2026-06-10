const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/aidesController')

router.get('/',               ctrl.getAll)
router.get('/:id',            ctrl.getOne)
router.post('/',              ctrl.create)
router.put('/:id',            ctrl.update)
router.post('/:id/valider',   ctrl.valider)
router.post('/:id/annuler',   ctrl.annuler)

module.exports = router
