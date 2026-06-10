const pool = require('../config/db')

// GET /api/tontines
async function getAll(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT
        t.*,
        COUNT(DISTINCT CASE WHEN COALESCE(s.statut,'ACTIVE') != 'TERMINEE' THEN s.id END) AS nb_souscriptions,
        COALESCE(SUM(CASE WHEN COALESCE(s.statut,'ACTIVE') != 'TERMINEE' THEN s.nb_parts END), 0) AS total_parts,
        (SELECT COUNT(*)
         FROM reunions r
         JOIN beneficiaires b ON b.reunion_id = r.id AND b.tontine_id = t.id
         WHERE r.statut = 'VALIDEE')     AS nb_seances_tenues
      FROM tontines t
      LEFT JOIN souscriptions s ON s.tontine_id = t.id
      GROUP BY t.id
      ORDER BY t.nom
    `)
    res.json({ success: true, data: rows })
  } catch (err) {
    next(err)
  }
}

// GET /api/tontines/:id
async function getOne(req, res, next) {
  try {
    const { id } = req.params
    const [[tontine]] = await pool.query(`
      SELECT
        t.*,
        COUNT(DISTINCT CASE WHEN COALESCE(s.statut,'ACTIVE') != 'TERMINEE' THEN s.id END) AS nb_souscriptions,
        COALESCE(SUM(CASE WHEN COALESCE(s.statut,'ACTIVE') != 'TERMINEE' THEN s.nb_parts END), 0) AS total_parts,
        (SELECT COUNT(*)
         FROM reunions r
         JOIN beneficiaires b ON b.reunion_id = r.id AND b.tontine_id = t.id
         WHERE r.statut = 'VALIDEE')     AS nb_seances_tenues
      FROM tontines t
      LEFT JOIN souscriptions s ON s.tontine_id = t.id
      WHERE t.id = ?
      GROUP BY t.id
    `, [id])

    if (!tontine)
      return res.status(404).json({ success: false, message: 'Tontine introuvable' })

    res.json({ success: true, data: tontine })
  } catch (err) {
    next(err)
  }
}

// POST /api/tontines
async function create(req, res, next) {
  try {
    const { nom, montant_par_part, type } = req.body

    if (!nom || !montant_par_part || !type)
      return res.status(400).json({
        success: false,
        message: 'nom, montant_par_part et type sont obligatoires'
      })

    if (!['DYNAMIQUE', 'PRESENCE'].includes(type))
      return res.status(400).json({
        success: false,
        message: 'type doit être DYNAMIQUE ou PRESENCE'
      })

    const [result] = await pool.query(
      'INSERT INTO tontines (nom, montant_par_part, type) VALUES (?, ?, ?)',
      [nom, montant_par_part, type]
    )

    const [[created]] = await pool.query('SELECT * FROM tontines WHERE id = ?', [result.insertId])
    res.status(201).json({ success: true, data: created })
  } catch (err) {
    next(err)
  }
}

// PUT /api/tontines/:id
async function update(req, res, next) {
  try {
    const { id } = req.params
    const { nom, montant_par_part, type, actif } = req.body

    const [[current]] = await pool.query('SELECT * FROM tontines WHERE id = ?', [id])
    if (!current)
      return res.status(404).json({ success: false, message: 'Tontine introuvable' })

    // Protège montant_par_part si des séances ont déjà été validées
    if (montant_par_part !== undefined && Number(montant_par_part) !== current.montant_par_part) {
      const [[{ nb_tenues }]] = await pool.query(`
        SELECT COUNT(*) AS nb_tenues
        FROM reunions r
        JOIN beneficiaires b ON b.reunion_id = r.id AND b.tontine_id = ?
        WHERE r.statut = 'VALIDEE'
      `, [id])
      if (nb_tenues > 0)
        return res.status(400).json({
          success: false,
          message: 'Impossible de modifier le montant par part : des séances ont déjà été validées'
        })
    }

    await pool.query(
      'UPDATE tontines SET nom=?, montant_par_part=?, type=?, actif=? WHERE id=?',
      [
        nom            ?? current.nom,
        montant_par_part ?? current.montant_par_part,
        type           ?? current.type,
        actif          !== undefined ? actif : current.actif,
        id
      ]
    )

    res.json({ success: true, message: 'Tontine mise à jour' })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/tontines/:id
async function remove(req, res, next) {
  try {
    const { id } = req.params

    const [[{ nb }]] = await pool.query(
      'SELECT COUNT(*) AS nb FROM souscriptions WHERE tontine_id = ?', [id]
    )
    if (nb > 0)
      return res.status(400).json({
        success: false,
        message: 'Impossible de supprimer : des souscriptions existent pour cette tontine'
      })

    const [result] = await pool.query('DELETE FROM tontines WHERE id = ?', [id])
    if (!result.affectedRows)
      return res.status(404).json({ success: false, message: 'Tontine introuvable' })

    res.json({ success: true, message: 'Tontine supprimée' })
  } catch (err) {
    next(err)
  }
}

// GET /api/tontines/:id/souscriptions
// Retourne uniquement les souscriptions du tour actuel (statut != TERMINEE)
async function getSouscriptions(req, res, next) {
  try {
    const { id } = req.params

    const [[tontine]] = await pool.query('SELECT id FROM tontines WHERE id = ?', [id])
    if (!tontine)
      return res.status(404).json({ success: false, message: 'Tontine introuvable' })

    const [rows] = await pool.query(`
      SELECT
        s.*,
        m.nom, m.prenom, m.telephone,
        COALESCE(SUM(ct.montant_paye), 0) AS total_cotise
      FROM souscriptions s
      JOIN membres m ON m.id = s.membre_id
      LEFT JOIN cotisations_tontine ct
        ON ct.membre_id = s.membre_id
        AND ct.tontine_id = s.tontine_id
        AND ct.reunion_id IN (
          SELECT r.id FROM reunions r
          WHERE r.statut = 'VALIDEE'
            AND r.date_reunion >= s.date_souscription
        )
      WHERE s.tontine_id = ?
        AND s.statut != 'TERMINEE'
      GROUP BY s.id
      ORDER BY m.nom, m.prenom
    `, [id])

    res.json({ success: true, data: rows })
  } catch (err) {
    next(err)
  }
}

// GET /api/tontines/:id/apercu-rattrapage?nb_parts=1
// Calcule le rattrapage uniquement sur le tour actuel (depuis date_debut_tour)
async function apercuRattrapage(req, res, next) {
  try {
    const { id } = req.params
    const nb_parts = parseInt(req.query.nb_parts) || 1

    if (nb_parts <= 0)
      return res.status(400).json({ success: false, message: 'nb_parts doit être > 0' })

    const [[tontine]] = await pool.query(
      'SELECT * FROM tontines WHERE id = ? AND actif = 1', [id]
    )
    if (!tontine)
      return res.status(404).json({ success: false, message: 'Tontine introuvable ou inactive' })

    // Séances du tour actuel : depuis date_debut_tour, ou depuis la création de la tontine
    const dateRef = tontine.date_debut_tour
      || new Date(tontine.created_at).toISOString().split('T')[0]

    const [seances] = await pool.query(`
      SELECT
        r.id AS reunion_id, r.date_reunion,
        b.membre_id AS beneficiaire_id,
        CONCAT(m.prenom, ' ', m.nom) AS beneficiaire
      FROM reunions r
      LEFT JOIN beneficiaires b ON b.reunion_id = r.id AND b.tontine_id = ?
      LEFT JOIN membres m       ON m.id = b.membre_id
      WHERE r.statut = 'VALIDEE'
        AND r.date_reunion >= ?
      ORDER BY r.date_reunion
    `, [id, dateRef])

    const montant_par_seance = nb_parts * tontine.montant_par_part
    const detail = seances.map(s => ({
      reunion_id:      s.reunion_id,
      date_reunion:    s.date_reunion,
      montant:         montant_par_seance,
      beneficiaire:    s.beneficiaire || null,
      beneficiaire_id: s.beneficiaire_id || null
    }))

    res.json({
      success: true,
      data: {
        tontine: {
          id:               tontine.id,
          nom:              tontine.nom,
          montant_par_part: tontine.montant_par_part,
          tour_actuel:      tontine.tour_actuel || 1,
          date_debut_tour:  tontine.date_debut_tour,
          nb_reunions_tour: tontine.nb_reunions_tour || 0
        },
        nb_parts,
        seances_a_rattraper: seances.length,
        montant_total:       seances.length * montant_par_seance,
        detail
      }
    })
  } catch (err) {
    next(err)
  }
}

// GET /api/tontines/:id/historique-beneficiaires?tour=X
async function historiqueBeneficiaires(req, res, next) {
  try {
    const { id } = req.params
    const { tour } = req.query

    const [[tontine]] = await pool.query('SELECT id, nom, tour_actuel FROM tontines WHERE id = ?', [id])
    if (!tontine)
      return res.status(404).json({ success: false, message: 'Tontine introuvable' })

    const conditions = ['hb.tontine_id = ?']
    const params = [id]
    if (tour) { conditions.push('hb.tour = ?'); params.push(tour) }

    const [rows] = await pool.query(`
      SELECT
        hb.*,
        m.nom, m.prenom,
        r.date_reunion
      FROM historique_beneficiaires hb
      JOIN membres  m ON m.id = hb.membre_id
      JOIN reunions r ON r.id = hb.reunion_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY hb.tour, r.date_reunion
    `, params)

    res.json({ success: true, data: rows })
  } catch (err) {
    next(err)
  }
}

// POST /api/tontines/:id/nouveau-tour
// Clôture le tour actuel et démarre le suivant.
// Reconduit automatiquement toutes les souscriptions ACTIVE.
async function nouveauTour(req, res, next) {
  let conn
  try {
    const { id } = req.params
    const { date_debut } = req.body
    const dateDebut = date_debut || new Date().toISOString().split('T')[0]

    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [[tontine]] = await conn.query('SELECT * FROM tontines WHERE id = ? AND actif = 1', [id])
    if (!tontine) {
      await conn.rollback()
      return res.status(404).json({ success: false, message: 'Tontine introuvable ou inactive' })
    }

    const newTour = (tontine.tour_actuel || 1) + 1

    // Récupère les souscriptions actives avant de les clôturer
    const [actives] = await conn.query(
      'SELECT membre_id, nb_parts FROM souscriptions WHERE tontine_id = ? AND statut = "ACTIVE"',
      [id]
    )

    // Clôture les souscriptions du tour terminé
    await conn.query(
      'UPDATE souscriptions SET statut = "TERMINEE", date_fin = ? WHERE tontine_id = ? AND statut = "ACTIVE"',
      [dateDebut, id]
    )

    // Recrée une souscription pour le nouveau tour pour chaque ancien souscripteur
    for (const s of actives) {
      await conn.query(
        `INSERT INTO souscriptions
           (membre_id, tontine_id, nb_parts, date_souscription, tour, statut)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
        [s.membre_id, id, s.nb_parts, dateDebut, newTour]
      )
    }

    // Met à jour la tontine
    await conn.query(
      'UPDATE tontines SET tour_actuel = ?, date_debut_tour = ?, nb_reunions_tour = 0 WHERE id = ?',
      [newTour, dateDebut, id]
    )

    await conn.commit()

    res.json({
      success: true,
      message: `Tour ${newTour} démarré. ${actives.length} souscription(s) reconduite(s).`,
      data: {
        tour_actuel:     newTour,
        date_debut_tour: dateDebut,
        nb_reconduites:  actives.length
      }
    })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

module.exports = {
  getAll, getOne, create, update, remove,
  getSouscriptions, apercuRattrapage, historiqueBeneficiaires, nouveauTour
}
