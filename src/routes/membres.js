const express = require('express')
const multer  = require('multer')
const path    = require('path')
const router  = express.Router()
const ctrl    = require('../controllers/membresController')

const storage = multer.diskStorage({
  destination: 'uploads/membres/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, `membre_${req.params.id}_${Date.now()}${ext}`)
  },
})
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /image\/(jpeg|png|webp)/.test(file.mimetype))
  },
})

router.get('/',              ctrl.getAll)
router.get('/:id',           ctrl.getOne)
router.post('/',             ctrl.create)
router.put('/:id',           ctrl.update)
router.post('/:id/photo',    upload.single('photo'), ctrl.uploadPhoto)
router.delete('/:id',        ctrl.remove)

module.exports = router
