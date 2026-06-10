const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/pretsController')

router.get('/',                           ctrl.getAll)
router.get('/membre/:membre_id',          ctrl.getByMembre)
router.get('/:id',                        ctrl.getOne)
router.post('/',                           ctrl.create)
router.delete('/:id',                      ctrl.remove)
router.post('/echeances/:id/reechelonner', ctrl.reechelonner)

module.exports = router
