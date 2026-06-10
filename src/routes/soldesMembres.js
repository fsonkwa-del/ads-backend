const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/soldesMembresController')

router.get('/', ctrl.getAll)

module.exports = router
