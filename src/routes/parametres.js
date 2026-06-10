const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/parametresController')

router.get('/',       ctrl.getAll)
router.put('/:cle',   ctrl.update)

module.exports = router
