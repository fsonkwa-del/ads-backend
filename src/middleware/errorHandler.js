function errorHandler(err, req, res, next) {
  console.error(err.stack)
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Erreur interne du serveur',
  })
}

module.exports = errorHandler
