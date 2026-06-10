const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/souscriptionsController')

router.get('/',                     ctrl.getAll)
router.get('/:id',                  ctrl.getOne)
router.post('/',                    ctrl.create)
router.post('/batch',               ctrl.createBatch)
router.post('/:id/augmenter-parts', ctrl.augmenterParts)
router.delete('/:id',               ctrl.remove)

module.exports = router
