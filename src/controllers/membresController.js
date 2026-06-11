const pool = require('../config/db')
const { logAudit } = require('../utils/audit')

const KYC_FIELDS = [
  'nom','prenom','telephone','date_adhesion','statut','observations',
  'date_naissance','lieu_naissance','type_pid','numero_pid',
  'adresse','profession',
  'contact_urgence_nom','contact_urgence_tel','contact_urgence_relation',
]

function pickKyc(body) {
  const r = {}
  for (const f of KYC_FIELDS) r[f] = body[f] ?? null
  if (body.statut) r.statut = body.statut
  return r
}

// Détecte les doublons sur (nom+prénom), téléphone et numéro de pièce.
// Comparaison insensible à la casse et aux espaces de bordure.
// Les valeurs vides ne sont jamais considérées comme des doublons.
// `excludeId` permet d'ignorer le membre courant lors d'une modification.
async function findDoublons(db, { nom, prenom, telephone, numero_pid }, excludeId = null) {
  const conflicts = []
  // Les membres supprimés (logiquement) ne bloquent pas un nouvel enregistrement
  const exclude = ' AND deleted = 0' + (excludeId ? ' AND id <> ?' : '')
  const tail    = excludeId ? [excludeId] : []

  if (nom && prenom) {
    const [[r]] = await db.query(
      `SELECT id FROM membres
       WHERE LOWER(TRIM(nom)) = LOWER(TRIM(?)) AND LOWER(TRIM(prenom)) = LOWER(TRIM(?))${exclude} LIMIT 1`,
      [nom, prenom, ...tail]
    )
    if (r) conflicts.push('nom et prénom')
  }

  const tel = telephone != null ? String(telephone).trim() : ''
  if (tel) {
    const [[r]] = await db.query(
      `SELECT id FROM membres WHERE TRIM(telephone) = ?${exclude} LIMIT 1`,
      [tel, ...tail]
    )
    if (r) conflicts.push('numéro de téléphone')
  }

  const pid = numero_pid != null ? String(numero_pid).trim() : ''
  if (pid) {
    const [[r]] = await db.query(
      `SELECT id FROM membres WHERE TRIM(numero_pid) = ?${exclude} LIMIT 1`,
      [pid, ...tail]
    )
    if (r) conflicts.push('numéro de pièce')
  }

  return conflicts
}

// GET /api/membres
async function getAll(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT * FROM membres WHERE deleted = 0 ORDER BY nom, prenom')
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
}

// GET /api/membres/:id
async function getOne(req, res, next) {
  try {
    const [[row]] = await pool.query('SELECT * FROM membres WHERE id = ? AND deleted = 0', [req.params.id])
    if (!row) return res.status(404).json({ success: false, message: 'Membre introuvable' })
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
}

// POST /api/membres
async function create(req, res, next) {
  try {
    const { nom, prenom, date_adhesion } = req.body
    if (!nom || !prenom || !date_adhesion)
      return res.status(400).json({ success: false, message: 'nom, prenom et date_adhesion sont obligatoires' })

    const d = pickKyc(req.body)

    const doublons = await findDoublons(pool, d)
    if (doublons.length)
      return res.status(409).json({ success: false, message: `Un membre existe déjà avec le même ${doublons.join(', ')}.` })

    const [result] = await pool.query(`
      INSERT INTO membres
        (nom,prenom,telephone,date_adhesion,statut,observations,
         date_naissance,lieu_naissance,type_pid,numero_pid,
         adresse,profession,
         contact_urgence_nom,contact_urgence_tel,contact_urgence_relation)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      d.nom, d.prenom, d.telephone, d.date_adhesion, d.statut || 'ACTIF', d.observations,
      d.date_naissance, d.lieu_naissance, d.type_pid, d.numero_pid,
      d.adresse, d.profession,
      d.contact_urgence_nom, d.contact_urgence_tel, d.contact_urgence_relation,
    ])
    const membre_id = result.insertId

    // Souscription automatique à la tontine PRESENCE
    const [tontinePresence] = await pool.query(
      'SELECT id FROM tontines WHERE type = ? AND actif = 1 LIMIT 1',
      ['PRESENCE']
    )
    if (tontinePresence.length) {
      await pool.query(
        `INSERT INTO souscriptions
         (membre_id, tontine_id, nb_parts, date_souscription, tour, statut)
         VALUES (?, ?, 1, CURDATE(), 1, 'ACTIVE')`,
        [membre_id, tontinePresence[0].id]
      )
    }

    res.status(201).json({ success: true, data: { id: membre_id } })
  } catch (err) { next(err) }
}

// PUT /api/membres/:id
async function update(req, res, next) {
  let conn
  try {
    const { id } = req.params
    const d = pickKyc(req.body)
    const nouveauStatut = d.statut

    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [[current]] = await conn.query(
      'SELECT statut, nom, prenom, telephone, numero_pid FROM membres WHERE id = ?', [id]
    )
    if (!current) {
      await conn.rollback()
      return res.status(404).json({ success: false, message: 'Membre introuvable' })
    }

    // Anti-doublon en modification : on ne contrôle que les champs réellement modifiés,
    // pour ne pas bloquer l'édition d'un membre dont une valeur duplique déjà un autre.
    const norm        = v => (v == null ? '' : String(v).trim().toLowerCase())
    const nomChanged  = norm(d.nom) !== norm(current.nom) || norm(d.prenom) !== norm(current.prenom)
    const telChanged  = norm(d.telephone) !== norm(current.telephone)
    const pidChanged  = norm(d.numero_pid) !== norm(current.numero_pid)
    const doublons = await findDoublons(conn, {
      nom:        nomChanged ? d.nom : null,
      prenom:     nomChanged ? d.prenom : null,
      telephone:  telChanged ? d.telephone : null,
      numero_pid: pidChanged ? d.numero_pid : null,
    }, id)
    if (doublons.length) {
      await conn.rollback()
      return res.status(409).json({ success: false, message: `Un autre membre possède déjà le même ${doublons.join(', ')}.` })
    }

    // Transition ACTIF → SUSPENDU ou SORTI : vérifications + effets de bord
    if (current.statut === 'ACTIF' && (nouveauStatut === 'SUSPENDU' || nouveauStatut === 'SORTI')) {
      if (nouveauStatut === 'SORTI') {
        const [[{ nb }]] = await conn.query(
          "SELECT COUNT(*) AS nb FROM prets WHERE membre_id = ? AND statut IN ('EN_COURS','EN_RETARD')",
          [id]
        )
        if (nb > 0) {
          await conn.rollback()
          return res.status(400).json({
            success: false,
            message: 'Ce membre a un prêt en cours non soldé. Soldez le prêt avant de le marquer comme sorti.'
          })
        }
      }
      // Suspendre toutes les souscriptions actives
      await conn.query(
        "UPDATE souscriptions SET statut = 'SUSPENDUE' WHERE membre_id = ? AND statut = 'ACTIVE'",
        [id]
      )
    }

    const [result] = await conn.query(`
      UPDATE membres SET
        nom=?,prenom=?,telephone=?,date_adhesion=?,statut=?,observations=?,
        date_naissance=?,lieu_naissance=?,type_pid=?,numero_pid=?,
        adresse=?,profession=?,
        contact_urgence_nom=?,contact_urgence_tel=?,contact_urgence_relation=?
      WHERE id=?
    `, [
      d.nom, d.prenom, d.telephone, d.date_adhesion, d.statut, d.observations,
      d.date_naissance, d.lieu_naissance, d.type_pid, d.numero_pid,
      d.adresse, d.profession,
      d.contact_urgence_nom, d.contact_urgence_tel, d.contact_urgence_relation,
      id,
    ])
    if (!result.affectedRows) {
      await conn.rollback()
      return res.status(404).json({ success: false, message: 'Membre introuvable' })
    }

    await conn.commit()
    res.json({ success: true, message: 'Membre mis à jour' })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// POST /api/membres/:id/photo
async function uploadPhoto(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Aucun fichier reçu' })
    const photo_url = `/uploads/membres/${req.file.filename}`
    await pool.query('UPDATE membres SET photo_url=? WHERE id=?', [photo_url, req.params.id])
    res.json({ success: true, photo_url })
  } catch (err) { next(err) }
}

// DELETE /api/membres/:id
// DELETE /api/membres/:id  — suppression logique (soft delete), historique préservé
async function remove(req, res, next) {
  try {
    const { id } = req.params
    const motif = req.body?.motif || req.body?.details || null
    const [[m]] = await pool.query('SELECT id, nom, prenom FROM membres WHERE id = ? AND deleted = 0', [id])
    if (!m) return res.status(404).json({ success: false, message: 'Membre introuvable' })

    await pool.query('UPDATE membres SET deleted = id WHERE id = ?', [id])
    await logAudit(pool, {
      utilisateur_id: req.user?.id, action: 'SUPPRESSION_MEMBRE', table_cible: 'membres',
      id_cible: Number(id), details: { nom: m.nom, prenom: m.prenom, motif }, ip_adresse: req.ip,
    })
    res.json({ success: true, message: 'Membre supprimé' })
  } catch (err) { next(err) }
}

module.exports = { getAll, getOne, create, update, remove, uploadPhoto }
