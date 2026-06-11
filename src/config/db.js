const mysql = require('mysql2/promise')
require('dotenv').config()

// TLS pour les MySQL managés (TiDB Cloud, Aiven, Cloud SQL…) : activer via DB_SSL=true.
// DB_SSL_REJECT_UNAUTHORIZED=false permet de se connecter sans fournir le certificat CA
// (pratique pour une démo ; à éviter en production réelle).
const ssl = process.env.DB_SSL === 'true'
  ? { minVersion: 'TLSv1.2', rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
  : undefined

const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl,
  waitForConnections: true,
  connectionLimit: 10,
})

module.exports = pool
