const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/authController')
const { auth } = require('../middleware/auth')

router.post('/login',            ctrl.login)            // public
router.get('/me',                auth, ctrl.me)
router.post('/change-password',  auth, ctrl.changePassword)

module.exports = router
