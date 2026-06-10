const pool = require('../config/db')
const { repartirEgal } = require('../utils/money')

// GET /api/souscriptions[?tontine_id=X&membre_id=Y&statut=ACTIVE]
async function getAll(req, res, next) {
  try {
    const { tontine_id, membre_id, statut } = req.query
    const conditions = []
    const params = []
    if (tontine_id) { conditions.push('s.tontine_id = ?');  params.push(tontine_id) }
    if (membre_id)  { conditions.push('s.membre_id = ?');   params.push(membre_id) }
    // Par défaut on exclut les TERMINEE (tours clôturés) sauf demande explicite
    if (statut)     { conditions.push('s.statut = ?');      params.push(statut) }
    else            { conditions.push("s.statut != 'TERMINEE'") }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

    const [rows] = await pool.query(`
      SELECT
        s.*,
        m.nom, m.prenom, m.telephone,
        t.nom AS nom_tontine, t.montant_par_part, t.type AS type_tontine,
        t.actif AS tontine_active,
        t.tour_actuel, t.date_debut_tour, t.nb_reunions_tour,
        COALESCE(SUM(ct.montant_paye), 0) AS total_cotise
      FROM souscriptions s
      JOIN membres m  ON m.id = s.membre_id
      JOIN tontines t ON t.id = s.tontine_id
      LEFT JOIN cotisations_tontine ct
        ON ct.membre_id  = s.membre_id
        AND ct.tontine_id = s.tontine_id
        AND ct.reunion_id IN (
          SELECT r.id FROM reunions r
          WHERE r.statut = 'VALIDEE'
            AND r.date_reunion >= s.date_souscription
        )
      ${where}
      GROUP BY s.id
      ORDER BY t.nom, m.nom, m.prenom
    `, params)

    res.json({ success: true, data: rows })
  } catch (err) {
    next(err)
  }
}

// GET /api/souscriptions/:id
async function getOne(req, res, next) {
  try {
    const { id } = req.params

    const [[souscription]] = await pool.query(`
      SELECT
        s.*,
        m.nom, m.prenom, m.telephone,
        t.nom AS nom_tontine, t.montant_par_part, t.type AS type_tontine,
        t.tour_actuel, t.date_debut_tour, t.nb_reunions_tour
      FROM souscriptions s
      JOIN membres m  ON m.id = s.membre_id
      JOIN tontines t ON t.id = s.tontine_id
      WHERE s.id = ?
    `, [id])

    if (!souscription)
      return res.status(404).json({ success: false, message: 'Souscription introuvable' })

    // Cotisations depuis la date de souscription (= tour courant de cette souscription)
    const [cotisations] = await pool.query(`
      SELECT ct.*, r.date_reunion
      FROM cotisations_tontine ct
      JOIN reunions r ON r.id = ct.reunion_id
      WHERE ct.membre_id  = ?
        AND ct.tontine_id = ?
        AND r.date_reunion >= ?
      ORDER BY r.date_reunion
    `, [souscription.membre_id, souscription.tontine_id, souscription.date_souscription])

    res.json({ success: true, data: { ...souscription, cotisations } })
  } catch (err) {
    next(err)
  }
}

// Souscrit un membre à une tontine pour le tour courant + rattrapage des séances
// déjà tenues (cotisations, ENTREE caisse, redistribution SORTIE au bénéficiaire d'origine,
// enregistrement dans rattrapages). Doit être appelé À L'INTÉRIEUR d'une transaction (conn).
// `membre` = { id, nom, prenom } · `tontine` = ligne complète de la table tontines.
async function souscrireInterne(conn, { tontine, membre, nb_parts, date_souscription }) {
  const tontine_id = tontine.id
  const tourActuel = tontine.tour_actuel || 1

  const [sResult] = await conn.query(
    `INSERT INTO souscriptions
       (membre_id, tontine_id, nb_parts, date_souscription, tour, statut)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
    [membre.id, tontine_id, nb_parts, date_souscription, tourActuel]
  )
  const souscription_id = sResult.insertId

  // Séances du tour actuel uniquement (depuis date_debut_tour ou depuis la création de la tontine)
  const dateRefTour = tontine.date_debut_tour
    || new Date(tontine.created_at).toISOString().split('T')[0]

  // Séances validées du tour (réunions DISTINCTES — pas de jointure bénéficiaires
  // qui dupliquerait les lignes en cas de multi-bénéficiaires).
  const [seancesTenues] = await conn.query(`
    SELECT r.id AS reunion_id, r.date_reunion
    FROM reunions r
    WHERE r.statut = 'VALIDEE' AND r.date_reunion >= ?
    ORDER BY r.date_reunion
  `, [dateRefTour])

  let montantTotal = 0
  const rattrapageDetail = []

  for (const seance of seancesTenues) {
    const montant = nb_parts * tontine.montant_par_part
    montantTotal += montant

    await conn.query(`
      INSERT INTO cotisations_tontine
        (reunion_id, membre_id, tontine_id, parts_attendues, parts_payees, montant_paye, est_echec)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `, [seance.reunion_id, membre.id, tontine_id, nb_parts, nb_parts, montant])

    rattrapageDetail.push({ reunion_id: seance.reunion_id, date_reunion: seance.date_reunion, montant })
  }

  if (montantTotal > 0) {
    // ENTREE globale pour le rattrapage
    await conn.query(`
      INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description)
      VALUES (?, 'ENTREE', 'COTISATION_TONTINE', ?, ?)
    `, [
      date_souscription,
      montantTotal,
      `Rattrapage adhésion – ${membre.prenom} ${membre.nom} – ${tontine.nom} (tour ${tourActuel})`
    ])

    // SORTIE par séance, répartie équitablement entre les bénéficiaires d'origine de la séance
    for (const seance of rattrapageDetail) {
      const [benefsSeance] = await conn.query(
        `SELECT mb.prenom, mb.nom FROM beneficiaires b JOIN membres mb ON mb.id = b.membre_id
         WHERE b.reunion_id = ? AND b.tontine_id = ? AND b.membre_id IS NOT NULL`,
        [seance.reunion_id, tontine_id]
      )
      if (!benefsSeance.length) continue
      const parts = repartirEgal(seance.montant, benefsSeance.length)
      for (let i = 0; i < benefsSeance.length; i++) {
        await conn.query(`
          INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description)
          VALUES (?, 'SORTIE', 'COTISATION_TONTINE', ?, ?)
        `, [date_souscription, parts[i], `Redistribution rattrapage – ${benefsSeance[i].prenom} ${benefsSeance[i].nom} – ${tontine.nom} (réunion #${seance.reunion_id})`])
      }
    }

    // Enregistrement dans rattrapages
    try {
      await conn.query(`
        INSERT INTO rattrapages
          (membre_id, tontine_id, tour, reunion_id, nb_seances_dues, nb_parts, montant_total)
        VALUES (?, ?, ?, NULL, ?, ?, ?)
      `, [membre.id, tontine_id, tourActuel, seancesTenues.length, nb_parts, montantTotal])
    } catch (_) { /* table rattrapages absente – migration non encore appliquée */ }
  }

  return {
    souscription_id,
    seances_rattrapees: seancesTenues.length,
    montant_total:      montantTotal,
    detail:             rattrapageDetail,
  }
}

// POST /api/souscriptions
// - Vérifie qu'il n'y a pas de souscription ACTIVE pour ce membre/tontine
// - Calcule le rattrapage sur le tour actuel seulement (depuis date_debut_tour)
// - Crée les cotisations de rattrapage + mouvement caisse ENTREE
// - Redistribue chaque séance rattrapée au bénéficiaire d'origine (SORTIE caisse)
// - Enregistre le récapitulatif dans la table rattrapages
async function create(req, res, next) {
  let conn
  try {
    const { membre_id, tontine_id, nb_parts, date_souscription } = req.body

    if (!membre_id || !tontine_id || !nb_parts || !date_souscription)
      return res.status(400).json({
        success: false,
        message: 'membre_id, tontine_id, nb_parts et date_souscription sont obligatoires'
      })
    if (nb_parts <= 0)
      return res.status(400).json({ success: false, message: 'nb_parts doit être > 0' })

    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [[membre]] = await conn.query(
      'SELECT id, nom, prenom FROM membres WHERE id = ? AND statut = "ACTIF"',
      [membre_id]
    )
    if (!membre) {
      await conn.rollback()
      return res.status(400).json({ success: false, message: 'Membre introuvable ou non actif' })
    }

    const [[tontine]] = await conn.query(
      'SELECT * FROM tontines WHERE id = ? AND actif = 1',
      [tontine_id]
    )
    if (!tontine) {
      await conn.rollback()
      return res.status(400).json({ success: false, message: 'Tontine introuvable ou inactive' })
    }

    // Vérifie l'absence de souscription ACTIVE (les TERMINEE d'anciens tours sont OK)
    const [[existing]] = await conn.query(
      "SELECT id FROM souscriptions WHERE membre_id = ? AND tontine_id = ? AND statut = 'ACTIVE'",
      [membre_id, tontine_id]
    )
    if (existing) {
      await conn.rollback()
      return res.status(400).json({ success: false, message: 'Ce membre a déjà une souscription active pour cette tontine' })
    }

    const r = await souscrireInterne(conn, { tontine, membre, nb_parts, date_souscription })

    await conn.commit()

    const [[created]] = await pool.query(`
      SELECT s.*, m.nom, m.prenom, t.nom AS nom_tontine
      FROM souscriptions s
      JOIN membres m ON m.id = s.membre_id
      JOIN tontines t ON t.id = s.tontine_id
      WHERE s.id = ?
    `, [r.souscription_id])

    res.status(201).json({
      success: true,
      data: {
        souscription: created,
        rattrapage: {
          seances_rattrapees: r.seances_rattrapees,
          montant_total:      r.montant_total,
          detail:             r.detail
        }
      }
    })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// POST /api/souscriptions/batch
// Inscrit plusieurs membres d'un coup à une même tontine, en une seule transaction.
// Body: { tontine_id, date_souscription, items: [{ membre_id, nb_parts }] }
// Les membres non actifs ou déjà souscrits sont ignorés (renvoyés dans `ignores`).
async function createBatch(req, res, next) {
  let conn
  try {
    const { tontine_id, date_souscription, items } = req.body

    if (!tontine_id || !date_souscription || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({
        success: false,
        message: 'tontine_id, date_souscription et items[] sont obligatoires'
      })

    const cleanItems = items
      .map(it => ({ membre_id: Number(it.membre_id), nb_parts: Number(it.nb_parts) }))
      .filter(it => it.membre_id && it.nb_parts > 0)
    if (cleanItems.length === 0)
      return res.status(400).json({ success: false, message: 'Aucun membre valide sélectionné (parts > 0 requis).' })

    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [[tontine]] = await conn.query('SELECT * FROM tontines WHERE id = ? AND actif = 1', [tontine_id])
    if (!tontine) {
      await conn.rollback()
      return res.status(400).json({ success: false, message: 'Tontine introuvable ou inactive' })
    }

    const inscrits = []
    const ignores  = []

    for (const it of cleanItems) {
      const [[membre]] = await conn.query(
        'SELECT id, nom, prenom FROM membres WHERE id = ? AND statut = "ACTIF"', [it.membre_id]
      )
      if (!membre) { ignores.push({ membre_id: it.membre_id, raison: 'introuvable ou non actif' }); continue }

      const [[existing]] = await conn.query(
        "SELECT id FROM souscriptions WHERE membre_id = ? AND tontine_id = ? AND statut = 'ACTIVE'",
        [it.membre_id, tontine_id]
      )
      if (existing) {
        ignores.push({ membre_id: it.membre_id, nom: membre.nom, prenom: membre.prenom, raison: 'déjà souscrit' })
        continue
      }

      const r = await souscrireInterne(conn, { tontine, membre, nb_parts: it.nb_parts, date_souscription })
      inscrits.push({
        membre_id: it.membre_id, nom: membre.nom, prenom: membre.prenom,
        nb_parts: it.nb_parts, souscription_id: r.souscription_id,
        seances_rattrapees: r.seances_rattrapees, montant_total: r.montant_total,
      })
    }

    if (inscrits.length === 0) {
      await conn.rollback()
      return res.status(400).json({
        success: false,
        message: 'Aucune inscription effectuée — membres déjà souscrits ou invalides.'
      })
    }

    await conn.commit()
    res.status(201).json({
      success: true,
      data: {
        inscrits: inscrits.length,
        ignores,
        montant_total_rattrapage: inscrits.reduce((s, x) => s + x.montant_total, 0),
        details: inscrits,
      }
    })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// POST /api/souscriptions/:id/augmenter-parts
// Augmente les parts en rattrapant les séances écoulées depuis la date de souscription.
// Redistribue chaque séance au bénéficiaire d'origine.
async function augmenterParts(req, res, next) {
  let conn
  try {
    const { id } = req.params
    const { parts_supplementaires, date_paiement } = req.body

    const partsAdd = parseInt(parts_supplementaires)
    if (!partsAdd || partsAdd <= 0 || !date_paiement)
      return res.status(400).json({
        success: false,
        message: 'parts_supplementaires (entier > 0) et date_paiement sont obligatoires'
      })

    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [[souscription]] = await conn.query(`
      SELECT s.*, t.montant_par_part, t.nom AS nom_tontine, t.actif,
        t.tour_actuel, t.date_debut_tour,
        m.nom AS membre_nom, m.prenom AS membre_prenom
      FROM souscriptions s
      JOIN tontines t ON t.id = s.tontine_id
      JOIN membres m  ON m.id = s.membre_id
      WHERE s.id = ?
    `, [id])

    if (!souscription) {
      await conn.rollback()
      return res.status(404).json({ success: false, message: 'Souscription introuvable' })
    }
    if (!souscription.actif) {
      await conn.rollback()
      return res.status(400).json({ success: false, message: 'La tontine est inactive' })
    }
    if (souscription.statut === 'TERMINEE') {
      await conn.rollback()
      return res.status(400).json({ success: false, message: 'Cette souscription appartient à un tour clôturé' })
    }

    await conn.query(
      'UPDATE souscriptions SET nb_parts = nb_parts + ? WHERE id = ?',
      [partsAdd, id]
    )

    // Séances depuis la date de souscription (réunions DISTINCTES — pas de jointure
    // bénéficiaires qui dupliquerait les lignes en cas de multi-bénéficiaires).
    const [seancesTenues] = await conn.query(`
      SELECT r.id AS reunion_id, r.date_reunion
      FROM reunions r
      WHERE r.statut = 'VALIDEE' AND r.date_reunion >= ?
      ORDER BY r.date_reunion
    `, [souscription.date_souscription])

    let montantTotal = 0
    const rattrapageDetail = []

    for (const seance of seancesTenues) {
      const montant = partsAdd * souscription.montant_par_part
      montantTotal += montant

      // Mise à jour ou création de la cotisation existante
      const [[cotis]] = await conn.query(
        'SELECT id FROM cotisations_tontine WHERE reunion_id = ? AND membre_id = ? AND tontine_id = ?',
        [seance.reunion_id, souscription.membre_id, souscription.tontine_id]
      )

      if (cotis) {
        await conn.query(`
          UPDATE cotisations_tontine
          SET parts_attendues = parts_attendues + ?,
              parts_payees    = parts_payees + ?,
              montant_paye    = montant_paye + ?
          WHERE id = ?
        `, [partsAdd, partsAdd, montant, cotis.id])
      } else {
        await conn.query(`
          INSERT INTO cotisations_tontine
            (reunion_id, membre_id, tontine_id, parts_attendues, parts_payees, montant_paye, est_echec)
          VALUES (?, ?, ?, ?, ?, ?, 0)
        `, [seance.reunion_id, souscription.membre_id, souscription.tontine_id, partsAdd, partsAdd, montant])
      }

      rattrapageDetail.push({ reunion_id: seance.reunion_id, date_reunion: seance.date_reunion, montant })
    }

    if (montantTotal > 0) {
      // ENTREE globale
      await conn.query(`
        INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description)
        VALUES (?, 'ENTREE', 'COTISATION_TONTINE', ?, ?)
      `, [
        date_paiement,
        montantTotal,
        `Rattrapage augmentation parts (+${partsAdd}) – ${souscription.membre_prenom} ${souscription.membre_nom} – ${souscription.nom_tontine}`
      ])

      // SORTIE par séance, répartie équitablement entre les bénéficiaires de la séance
      for (const seance of rattrapageDetail) {
        const [benefsSeance] = await conn.query(
          `SELECT mb.prenom, mb.nom FROM beneficiaires b JOIN membres mb ON mb.id = b.membre_id
           WHERE b.reunion_id = ? AND b.tontine_id = ? AND b.membre_id IS NOT NULL`,
          [seance.reunion_id, souscription.tontine_id]
        )
        if (!benefsSeance.length) continue
        const parts = repartirEgal(seance.montant, benefsSeance.length)
        for (let i = 0; i < benefsSeance.length; i++) {
          await conn.query(`
            INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description)
            VALUES (?, 'SORTIE', 'COTISATION_TONTINE', ?, ?)
          `, [date_paiement, parts[i], `Redistribution augmentation – ${benefsSeance[i].prenom} ${benefsSeance[i].nom} – ${souscription.nom_tontine} (réunion #${seance.reunion_id})`])
        }
      }

      // Enregistrement dans rattrapages
      try {
        await conn.query(`
          INSERT INTO rattrapages
            (membre_id, tontine_id, tour, reunion_id, nb_seances_dues, nb_parts, montant_total)
          VALUES (?, ?, ?, NULL, ?, ?, ?)
        `, [
          souscription.membre_id, souscription.tontine_id,
          souscription.tour_actuel || 1,
          seancesTenues.length, partsAdd, montantTotal
        ])
      } catch (_) { /* table rattrapages absente */ }
    }

    await conn.commit()

    const [[updated]] = await pool.query(
      'SELECT nb_parts FROM souscriptions WHERE id = ?', [id]
    )

    res.json({
      success: true,
      data: {
        souscription_id: parseInt(id),
        nouvelles_parts: updated.nb_parts,
        parts_ajoutees:  partsAdd,
        rattrapage: {
          seances_rattrapees: seancesTenues.length,
          montant_total:      montantTotal,
          detail:             rattrapageDetail
        }
      }
    })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// DELETE /api/souscriptions/:id
async function remove(req, res, next) {
  try {
    const { id } = req.params

    const [[souscription]] = await pool.query(
      'SELECT membre_id, tontine_id, date_souscription FROM souscriptions WHERE id = ?', [id]
    )
    if (!souscription)
      return res.status(404).json({ success: false, message: 'Souscription introuvable' })

    // Vérifie si des cotisations existent pour cette souscription (depuis date_souscription)
    const [[{ nb }]] = await pool.query(`
      SELECT COUNT(*) AS nb
      FROM cotisations_tontine ct
      JOIN reunions r ON r.id = ct.reunion_id
      WHERE ct.membre_id  = ?
        AND ct.tontine_id = ?
        AND r.date_reunion >= ?
    `, [souscription.membre_id, souscription.tontine_id, souscription.date_souscription])

    if (nb > 0)
      return res.status(400).json({
        success: false,
        message: 'Impossible de supprimer : des cotisations existent pour cette souscription'
      })

    // Supprime aussi les cotisations de rattrapage antérieures à date_souscription (orphelines)
    await pool.query(`
      DELETE ct FROM cotisations_tontine ct
      JOIN reunions r ON r.id = ct.reunion_id
      WHERE ct.membre_id  = ?
        AND ct.tontine_id = ?
        AND r.date_reunion < ?
    `, [souscription.membre_id, souscription.tontine_id, souscription.date_souscription])

    await pool.query('DELETE FROM souscriptions WHERE id = ?', [id])
    res.json({ success: true, message: 'Souscription supprimée' })
  } catch (err) {
    next(err)
  }
}

module.exports = { getAll, getOne, create, createBatch, augmenterParts, remove }
