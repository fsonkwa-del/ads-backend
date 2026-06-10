const app = require('./app')
const pool = require('./config/db')

const PORT = process.env.PORT || 3001

async function start() {
  try {
    // Test connexion base de données
    await pool.query('SELECT 1')
    console.log('✅ Connexion MySQL OK')

    app.listen(PORT, () => {
      console.log(`✅ Serveur ADS démarré sur http://localhost:${PORT}`)
      console.log(`   Health check : http://localhost:${PORT}/api/health`)
    })
  } catch (err) {
    console.error('❌ Impossible de démarrer :', err.message)
    process.exit(1)
  }
}

start()
