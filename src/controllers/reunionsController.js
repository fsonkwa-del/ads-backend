const pool = require('../config/db')
const { getParam } = require('./pretsController')
const { arrondirFCFA } = require('../utils/money')

// ── GET /api/reunions ─────────────────────────────────────────
async function getAll(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT
        r.*,
        COUNT(DISTINCT ct.id)                                                       AS nb_cotisations,
        COUNT(DISTINCT CASE WHEN b.membre_id IS NOT NULL THEN b.id END)             AS nb_beneficiaires,
        COUNT(DISTINCT ct.tontine_id)                                               AS nb_tontines,
        COALESCE(SUM(CASE WHEN ct.est_echec=0 THEN ct.montant_paye ELSE 0 END), 0) AS total_collecte_reel
      FROM reunions r
      LEFT JOIN cotisations_tontine ct ON ct.reunion_id = r.id
      LEFT JOIN beneficiaires b         ON b.reunion_id  = r.id
      GROUP BY r.id
      ORDER BY r.date_reunion DESC
    `)
    res.json({ success: true, data: rows })
  } catch (err) {
    next(err)
  }
}

// ── GET /api/reunions/:id ─────────────────────────────────────
async function getOne(req, res, next) {
  try {
    const { id } = req.params
    const [[reunion]] = await pool.query('SELECT * FROM reunions WHERE id = ?', [id])
    if (!reunion) return res.status(404).json({ success: false, message: 'Réunion introuvable' })

    const [tontines] = await pool.query(`
      SELECT id, nom, montant_par_part, type FROM tontines WHERE actif = 1
      ORDER BY CASE WHEN type='PRESENCE' THEN 0 ELSE 1 END, montant_par_part ASC
    `)
    const [cotisationsTontine] = await pool.query(`
      SELECT ct.*, m.nom, m.prenom
      FROM cotisations_tontine ct JOIN membres m ON m.id = ct.membre_id
      WHERE ct.reunion_id = ? ORDER BY m.nom, m.prenom
    `, [id])
    const [cotisationsRubrique] = await pool.query(
      'SELECT * FROM cotisations_rubrique WHERE reunion_id = ?', [id]
    )
    const [beneficiaires] = await pool.query(`
      SELECT b.*, m.nom, m.prenom, t.nom AS nom_tontine, t.montant_par_part, t.type AS type_tontine
      FROM beneficiaires b
      JOIN tontines t ON t.id = b.tontine_id
      LEFT JOIN membres m ON m.id = b.membre_id
      WHERE b.reunion_id = ?
    `, [id])

    // Échéances dues à cette réunion (tables créées après la mise en place des prêts)
    let echeances = []
    try {
      const [rows] = await pool.query(`
        SELECT ep.*, p.membre_id, p.montant_capital AS capital_total,
          m.nom, m.prenom
        FROM echeances_pret ep
        JOIN prets p ON p.id = ep.pret_id
        JOIN membres m ON m.id = p.membre_id
        WHERE ep.reunion_id = ?
      `, [id])
      echeances = rows
    } catch (_) { /* table absente ou schéma incomplet, on renvoie [] */ }

    // Sanctions : cette réunion + non-payées d'avant
    let sanctions = []
    try {
      const [rows] = await pool.query(`
        SELECT s.*, m.nom, m.prenom
        FROM sanctions s JOIN membres m ON m.id = s.membre_id
        WHERE s.reunion_id = ?
          OR (s.statut = 'NON_PAYEE' AND s.reunion_id != ?)
        ORDER BY s.created_at
      `, [id, id])
      sanctions = rows
    } catch (_) { /* table absente */ }

    // Références de paiement Mobile Money par membre (table créée en phase 3)
    let referencesPaiement = []
    try {
      const [rows] = await pool.query(
        'SELECT membre_id, reference FROM reunion_references_paiement WHERE reunion_id = ?', [id]
      )
      referencesPaiement = rows
    } catch (_) { /* table absente si migration phase 3 non appliquée */ }

    // Souscriptions éligibles en garantie (tontines DYNAMIQUE) + indicateur deja_beneficiaire
    // Une tontine ne peut servir de caution que si le membre n'a pas encore perçu son pot ce tour.
    let souscriptionsGarantie = []
    try {
      const [rows] = await pool.query(`
        SELECT s.membre_id, s.tontine_id, t.nom AS tontine_nom, t.tour_actuel,
          EXISTS(
            SELECT 1 FROM historique_beneficiaires hb
            WHERE hb.membre_id = s.membre_id
              AND hb.tontine_id = s.tontine_id
              AND hb.tour = t.tour_actuel
          ) AS deja_beneficiaire
        FROM souscriptions s
        JOIN tontines t ON t.id = s.tontine_id
        WHERE s.statut = 'ACTIVE' AND t.actif = 1 AND t.type = 'DYNAMIQUE'
      `)
      // EXISTS renvoie 0/1 → on convertit en booléen
      souscriptionsGarantie = rows.map(r => ({ ...r, deja_beneficiaire: !!r.deja_beneficiaire }))
    } catch (_) { /* tables tour absentes si migration 001 non appliquée */ }

    // Prêts octroyés lors de cette réunion
    let pretsSession = []
    try {
      const [rows] = await pool.query(`
        SELECT p.*, m.nom, m.prenom,
          COALESCE(SUM(ep.montant_du), 0) AS total_a_rembourser,
          (SELECT GROUP_CONCAT(CONCAT(mg.prenom, ' ', mg.nom) ORDER BY mg.nom SEPARATOR '||')
             FROM prets_garants pg JOIN membres mg ON mg.id = pg.membre_id
             WHERE pg.pret_id = p.id) AS garants_noms
        FROM prets p JOIN membres m ON m.id = p.membre_id
        LEFT JOIN echeances_pret ep ON ep.pret_id = p.id
        WHERE p.reunion_octroi_id = ?
        GROUP BY p.id
      `, [id])
      pretsSession = rows
    } catch (_) {
      // Fallback sans JOIN echeances si la table est absente ou colonnes incorrectes
      try {
        const [rows] = await pool.query(`
          SELECT p.*, m.nom, m.prenom, 0 AS total_a_rembourser
          FROM prets p JOIN membres m ON m.id = p.membre_id
          WHERE p.reunion_octroi_id = ?
        `, [id])
        pretsSession = rows
      } catch (__) {}
    }

    res.json({
      success: true,
      data: {
        ...reunion, tontines,
        cotisations_tontine:  cotisationsTontine,
        cotisations_rubrique: cotisationsRubrique,
        references_paiement:  referencesPaiement,
        souscriptions_garantie: souscriptionsGarantie,
        beneficiaires, echeances, sanctions, prets_session: pretsSession
      }
    })
  } catch (err) {
    next(err)
  }
}

// ── POST /api/reunions ────────────────────────────────────────
async function create(req, res, next) {
  let conn
  try {
    const { date_reunion, observations } = req.body
    if (!date_reunion) return res.status(400).json({ success: false, message: 'date_reunion est obligatoire' })

    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [rResult] = await conn.query(
      'INSERT INTO reunions (date_reunion, statut, total_collecte, observations) VALUES (?, "BROUILLON", 0, ?)',
      [date_reunion, observations || null]
    )
    const reunion_id = rResult.insertId

    // Cotisations DYNAMIQUE (souscriptions actives uniquement)
    const [dynSouscriptions] = await conn.query(`
      SELECT s.membre_id, s.tontine_id, s.nb_parts
      FROM souscriptions s JOIN tontines t ON t.id = s.tontine_id
      WHERE t.actif = 1 AND t.type = 'DYNAMIQUE' AND s.statut = 'ACTIVE'
    `)
    for (const s of dynSouscriptions) {
      await conn.query(`
        INSERT INTO cotisations_tontine
          (reunion_id, membre_id, tontine_id, parts_attendues, parts_payees, montant_paye, est_echec)
        VALUES (?, ?, ?, ?, 0, 0, 0)
      `, [reunion_id, s.membre_id, s.tontine_id, s.nb_parts])
    }

    // Cotisations PRESENCE (tous les membres actifs, 1 part)
    const [presenceTontines] = await conn.query(
      'SELECT id FROM tontines WHERE actif=1 AND type="PRESENCE"'
    )
    const [membresActifs] = await conn.query('SELECT id FROM membres WHERE statut="ACTIF"')
    for (const t of presenceTontines) {
      for (const m of membresActifs) {
        await conn.query(`
          INSERT INTO cotisations_tontine
            (reunion_id, membre_id, tontine_id, parts_attendues, parts_payees, montant_paye, est_echec)
          VALUES (?, ?, ?, 1, 0, 0, 0)
        `, [reunion_id, m.id, t.id])
      }
    }

    const totalSouscriptions = dynSouscriptions.length + presenceTontines.length * membresActifs.length

    // Bénéficiaire placeholder pour chaque tontine active
    const [tontines] = await conn.query('SELECT id FROM tontines WHERE actif=1')
    for (const t of tontines) {
      await conn.query(
        'INSERT INTO beneficiaires (reunion_id, tontine_id, membre_id) VALUES (?, ?, NULL)',
        [reunion_id, t.id]
      )
    }

    // Assigne les échéances sans reunion_id dont date_prevue <= date_reunion
    // Enveloppé en try/catch : la table ou colonne peut ne pas exister encore
    try {
      const [pendingEches] = await conn.query(`
        SELECT ep.id
        FROM echeances_pret ep
        JOIN prets p ON p.id = ep.pret_id
        WHERE ep.reunion_id IS NULL
          AND ep.statut = 'ATTENDU'
          AND ep.date_prevue <= ?
          AND p.statut IN ('EN_COURS','EN_RETARD')
          AND ep.numero = (
            SELECT MIN(ep2.numero)
            FROM echeances_pret ep2
            WHERE ep2.pret_id = ep.pret_id
              AND ep2.reunion_id IS NULL
              AND ep2.statut = 'ATTENDU'
          )
      `, [date_reunion])
      for (const e of pendingEches) {
        await conn.query('UPDATE echeances_pret SET reunion_id=? WHERE id=?', [reunion_id, e.id])
      }
    } catch (_) { /* table ou colonne absente, on ignore */ }

    await conn.commit()

    const [[created]] = await pool.query('SELECT * FROM reunions WHERE id = ?', [reunion_id])
    res.status(201).json({
      success: true,
      data: { ...created, nb_cotisations: totalSouscriptions, nb_tontines: tontines.length }
    })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// ── PUT /api/reunions/:id/sauvegarder ─────────────────────────
async function sauvegarder(req, res, next) {
  let conn
  try {
    const { id } = req.params
    const {
      cotisations_tontine = [],
      cotisations_rubrique = [],
      echeances = [],
      montants_membres = {},     // { [tontine_id]: montant_membre } pour présence split
      references_paiement = {},  // { [membre_id]: 'réf MoMo/OM' } référence transaction par membre
      montant_rafraichissement
    } = req.body

    const [[reunion]] = await pool.query('SELECT statut FROM reunions WHERE id = ?', [id])
    if (!reunion) return res.status(404).json({ success: false, message: 'Réunion introuvable' })
    if (reunion.statut === 'VALIDEE')
      return res.status(400).json({ success: false, message: 'Impossible de modifier une réunion validée' })

    conn = await pool.getConnection()
    await conn.beginTransaction()

    // Garde-fou : on ne peut pas cotiser plus de parts que celles souscrites.
    // Plafond par cotisation = parts_attendues × montant_par_part de la tontine.
    if (cotisations_tontine.length) {
      const [infos] = await conn.query(`
        SELECT ct.id, ct.parts_attendues, t.montant_par_part, t.nom AS tontine_nom, m.nom, m.prenom
        FROM cotisations_tontine ct
        JOIN tontines t ON t.id = ct.tontine_id
        JOIN membres  m ON m.id = ct.membre_id
        WHERE ct.reunion_id = ?
      `, [id])
      const infoMap = new Map(infos.map(r => [r.id, r]))
      for (const ct of cotisations_tontine) {
        const info = infoMap.get(ct.id)
        if (!info) continue
        const maxMontant = Number(info.parts_attendues) * Number(info.montant_par_part)
        if (Number(ct.montant_paye) > maxMontant) {
          await conn.rollback()
          return res.status(400).json({
            success: false,
            message: `Saisie invalide — ${info.prenom} ${info.nom} / ${info.tontine_nom} : ${Number(ct.montant_paye).toLocaleString('fr-FR')} FCFA dépasse les ${info.parts_attendues} part(s) souscrite(s) (max ${maxMontant.toLocaleString('fr-FR')} FCFA).`
          })
        }
      }
    }

    // Cotisations tontine
    for (const ct of cotisations_tontine) {
      const estEchec = ct.parts_payees === 0 ? 1 : 0
      await conn.query(
        'UPDATE cotisations_tontine SET parts_payees=?, montant_paye=?, est_echec=? WHERE id=? AND reunion_id=?',
        [ct.parts_payees, ct.montant_paye, estEchec, ct.id, id]
      )
    }

    // Cotisations rubrique (DELETE + INSERT si montant > 0)
    for (const cr of cotisations_rubrique) {
      await conn.query(
        'DELETE FROM cotisations_rubrique WHERE reunion_id=? AND membre_id=? AND rubrique=?',
        [id, cr.membre_id, cr.rubrique]
      )
      if (cr.montant > 0) {
        await conn.query(
          'INSERT INTO cotisations_rubrique (reunion_id, membre_id, rubrique, montant) VALUES (?, ?, ?, ?)',
          [id, cr.membre_id, cr.rubrique, cr.montant]
        )
      }
    }

    // Échéances de prêts
    for (const e of echeances) {
      await conn.query(
        'UPDATE echeances_pret SET montant_paye=? WHERE id=? AND reunion_id=?',
        [e.montant_paye, e.id, id]
      )
    }

    // Présence split : montant_membre par tontine
    for (const [tontine_id, montant_membre] of Object.entries(montants_membres)) {
      await conn.query(
        'UPDATE beneficiaires SET montant_membre=? WHERE reunion_id=? AND tontine_id=?',
        [montant_membre || null, id, tontine_id]
      )
    }

    // Références de paiement Mobile Money par membre (upsert si non vide, sinon suppression)
    try {
      for (const [membre_id, reference] of Object.entries(references_paiement)) {
        const ref = (reference ?? '').toString().trim()
        if (ref) {
          await conn.query(
            `INSERT INTO reunion_references_paiement (reunion_id, membre_id, reference)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE reference = VALUES(reference)`,
            [id, membre_id, ref]
          )
        } else {
          await conn.query(
            'DELETE FROM reunion_references_paiement WHERE reunion_id=? AND membre_id=?',
            [id, membre_id]
          )
        }
      }
    } catch (_) { /* table absente si migration phase 3 non appliquée */ }

    // Rafraîchissement
    if (montant_rafraichissement !== undefined) {
      await conn.query(
        'UPDATE reunions SET montant_rafraichissement = ? WHERE id = ?',
        [Number(montant_rafraichissement) || 0, id]
      )
    }

    await conn.commit()
    res.json({ success: true, message: 'Réunion sauvegardée' })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// ── POST /api/reunions/:id/beneficiaire ───────────────────────
async function setBeneficiaire(req, res, next) {
  try {
    const { id } = req.params
    const { tontine_id, membre_id, montant_membre } = req.body

    if (!tontine_id) return res.status(400).json({ success: false, message: 'tontine_id est obligatoire' })

    const [[reunion]] = await pool.query('SELECT statut FROM reunions WHERE id = ?', [id])
    if (!reunion) return res.status(404).json({ success: false, message: 'Réunion introuvable' })
    if (reunion.statut === 'VALIDEE')
      return res.status(400).json({ success: false, message: 'Impossible de modifier une réunion validée' })

    if (membre_id) {
      const [[tontine]] = await pool.query('SELECT type FROM tontines WHERE id=?', [tontine_id])
      if (tontine?.type === 'DYNAMIQUE') {
        // Source de vérité principale : cotisations réelles de cette réunion
        const [[ct]] = await pool.query(
          'SELECT id FROM cotisations_tontine WHERE membre_id=? AND tontine_id=? AND reunion_id=?',
          [membre_id, tontine_id, id]
        )
        // Fallback : souscription active (cas où le membre n'a pas encore payé mais est souscrit)
        const [[sous]] = await pool.query(
          "SELECT id FROM souscriptions WHERE membre_id=? AND tontine_id=? AND statut='ACTIVE'",
          [membre_id, tontine_id]
        )
        if (!ct && !sous)
          return res.status(400).json({ success: false, message: 'Ce membre n\'est pas souscrit à cette tontine' })
      }
    }

    const [result] = await pool.query(
      'UPDATE beneficiaires SET membre_id=?, montant_membre=? WHERE reunion_id=? AND tontine_id=?',
      [membre_id || null, montant_membre !== undefined ? montant_membre : null, id, tontine_id]
    )
    if (result.affectedRows === 0) {
      await pool.query(
        'INSERT INTO beneficiaires (reunion_id, tontine_id, membre_id, montant_membre) VALUES (?, ?, ?, ?)',
        [id, tontine_id, membre_id || null, montant_membre || null]
      )
    }

    res.json({ success: true, message: 'Bénéficiaire mis à jour' })
  } catch (err) {
    next(err)
  }
}

// ── POST /api/reunions/:id/valider ────────────────────────────
async function valider(req, res, next) {
  let conn
  try {
    const { id } = req.params
    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [[reunion]] = await conn.query('SELECT * FROM reunions WHERE id = ?', [id])
    if (!reunion) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Réunion introuvable' }) }
    if (reunion.statut === 'VALIDEE') { await conn.rollback(); return res.status(400).json({ success: false, message: 'Déjà validée' }) }

    // ── 0. Vérifier que chaque tontine active (DYNAMIQUE + PRESENCE) a un bénéficiaire ──
    const [manquants] = await conn.query(`
      SELECT t.nom
      FROM tontines t
      LEFT JOIN beneficiaires b
        ON b.tontine_id = t.id AND b.reunion_id = ? AND b.membre_id IS NOT NULL
      WHERE t.actif = 1 AND b.id IS NULL
    `, [id])
    if (manquants.length > 0) {
      await conn.rollback()
      return res.status(400).json({
        success: false,
        message: `Bénéficiaire manquant pour : ${manquants.map(r => r.nom).join(', ')}`
      })
    }

    // ── 0b. Vérifier que la part membre est saisie pour les tontines PRESENCE ──
    const [presenceSansPart] = await conn.query(`
      SELECT t.nom
      FROM beneficiaires b
      JOIN tontines t ON t.id = b.tontine_id
      WHERE b.reunion_id = ? AND t.type = 'PRESENCE' AND b.membre_id IS NOT NULL
        AND (b.montant_membre IS NULL OR b.montant_membre = 0)
    `, [id])
    if (presenceSansPart.length > 0) {
      await conn.rollback()
      return res.status(400).json({
        success: false,
        message: `Veuillez saisir la part membre pour la cotisation présence : ${presenceSansPart.map(r => r.nom).join(', ')}`
      })
    }

    const penaliteRate = await getParam(conn, 'PENALITE_ECHEC', 5)
    const dateLabel    = new Date(reunion.date_reunion).toLocaleDateString('fr-FR')

    // ── 1. Cotisations tontine ──
    const [[{ tontineTotal }]] = await conn.query(
      'SELECT COALESCE(SUM(montant_paye),0) AS tontineTotal FROM cotisations_tontine WHERE reunion_id=? AND est_echec=0',
      [id]
    )

    // ── 2. Cotisations rubrique ──
    const [[{ rubriqueTotal }]] = await conn.query(
      'SELECT COALESCE(SUM(montant),0) AS rubriqueTotal FROM cotisations_rubrique WHERE reunion_id=?', [id]
    )

    // ── 3. Échéances prêts ──
    let pretTotal = 0
    try {
      const statusFilter = 'ep.reunion_id=?'  // pas de filtre statut si colonne absente
      const [echeances] = await conn.query(
        `SELECT ep.*, p.membre_id FROM echeances_pret ep JOIN prets p ON p.id=ep.pret_id WHERE ${statusFilter}`,
        [id]
      )
      for (const e of echeances) {
        const montant_du = Number(e.montant_du ?? e.montant_total ?? 0)
        if (e.montant_paye >= montant_du && montant_du > 0) {
          // Payée
          try { await conn.query('UPDATE echeances_pret SET statut="PAYE" WHERE id=?', [e.id]) } catch (_) {}
          pretTotal += Number(e.montant_paye)
          try {
            const [[{ nb_restant }]] = await conn.query(
              'SELECT COUNT(*) AS nb_restant FROM echeances_pret WHERE pret_id=? AND statut NOT IN ("PAYE","REECHELONNE")',
              [e.pret_id]
            )
            if (nb_restant === 0) await conn.query('UPDATE prets SET statut="REMBOURSE" WHERE id=?', [e.pret_id])
          } catch (_) {}
        } else if (Number(e.montant_paye) > 0) {
          // Partiellement payée → EN_RETARD
          try {
            const penalite = arrondirFCFA((montant_du || 0) * penaliteRate / 100)
            await conn.query('UPDATE echeances_pret SET statut="EN_RETARD", penalite=? WHERE id=?', [penalite, e.id])
          } catch (_) { try { await conn.query('UPDATE echeances_pret SET montant_paye=? WHERE id=?', [e.montant_paye, e.id]) } catch (__) {} }
          try { await conn.query('UPDATE prets SET statut="EN_RETARD" WHERE id=?', [e.pret_id]) } catch (_) {}
          pretTotal += Number(e.montant_paye)
        } else {
          // Non payée
          try {
            const penalite = arrondirFCFA((montant_du || 0) * penaliteRate / 100)
            await conn.query('UPDATE echeances_pret SET statut="EN_RETARD", penalite=? WHERE id=?', [penalite, e.id])
          } catch (_) {}
          try { await conn.query('UPDATE prets SET statut="EN_RETARD" WHERE id=?', [e.pret_id]) } catch (_) {}
        }
      }
    } catch (_) { /* table echeances_pret absente ou schéma incomplet */ }

    // ── 4. Sanctions payées ce jour ──
    const [sanctionsPaid] = await conn.query(
      'SELECT * FROM sanctions WHERE reunion_id=? AND statut="PAYEE"', [id]
    )
    let sanctionTotal = sanctionsPaid.reduce((s, x) => s + x.montant, 0)

    // ── 5. Mise à jour total_collecte ──
    const total = Math.round(
      (Number(tontineTotal) || 0) +
      (Number(rubriqueTotal) || 0) +
      (Number(pretTotal)    || 0) +
      (Number(sanctionTotal)|| 0)
    )
    await conn.query('UPDATE reunions SET statut="VALIDEE", total_collecte=? WHERE id=?', [total, id])

    // ── 5b. Mise à jour soldes_membres (fond_caisse / fond_banque) ──
    try {
      const [rubAll] = await conn.query('SELECT * FROM cotisations_rubrique WHERE reunion_id=?', [id])
      const soldesDiff = {}
      for (const r of rubAll) {
        if (!soldesDiff[r.membre_id]) soldesDiff[r.membre_id] = { fc: 0, fb: 0 }
        if (r.rubrique === 'FONDS_CAISSE') soldesDiff[r.membre_id].fc += Number(r.montant)
        if (r.rubrique === 'BANQUE')       soldesDiff[r.membre_id].fb += Number(r.montant)
      }
      for (const [mid, d] of Object.entries(soldesDiff)) {
        if (d.fc > 0 || d.fb > 0) {
          await conn.query(`
            INSERT INTO soldes_membres (membre_id, fond_caisse, fond_banque)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
              fond_caisse = fond_caisse + ?,
              fond_banque = fond_banque + ?
          `, [mid, d.fc, d.fb, d.fc, d.fb])
        }
      }
    } catch (_) { /* table absente */ }

    // ── 5c. Auto-reconstitution des aides (contribution par contribution) ──
    try {
      const [rubAll] = await conn.query(
        'SELECT membre_id, rubrique, montant FROM cotisations_rubrique WHERE reunion_id=?', [id]
      )
      const fcContributors = [...new Set(
        rubAll.filter(r => r.rubrique === 'FONDS_CAISSE' && Number(r.montant) > 0).map(r => r.membre_id)
      )]
      for (const mid of fcContributors) {
        const [[solde]] = await conn.query(
          'SELECT fond_caisse FROM soldes_membres WHERE membre_id=?', [mid]
        )
        let fondRestant = Number(solde?.fond_caisse || 0)
        // Contributions non reconstituées, triées du délai le plus proche
        const [contributions] = await conn.query(`
          SELECT ca.id, a.montant_par_membre
          FROM contributions_aide ca
          JOIN aides a ON a.id = ca.aide_id
          WHERE ca.membre_id = ? AND ca.reconstitue = 0
          ORDER BY ca.date_limite_reconstitution ASC
        `, [mid])
        for (const contrib of contributions) {
          const montant = Number(contrib.montant_par_membre || 0)
          if (montant > 0 && fondRestant >= montant) {
            await conn.query(
              'UPDATE contributions_aide SET reconstitue=1, date_reconstitution=CURDATE() WHERE id=?',
              [contrib.id]
            )
            fondRestant -= montant
          }
        }
      }
    } catch (_) { /* table absente */ }

    // ── 6. Mouvements caisse ──
    if (tontineTotal > 0) {
      await conn.query(`INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description, reunion_id)
        VALUES (?, 'ENTREE', 'COTISATION_TONTINE', ?, ?, ?)`,
        [reunion.date_reunion, tontineTotal, `Cotisations tontines – ${dateLabel}`, id])
    }
    if (rubriqueTotal > 0) {
      await conn.query(`INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description, reunion_id)
        VALUES (?, 'ENTREE', 'COTISATION_RUBRIQUE', ?, ?, ?)`,
        [reunion.date_reunion, rubriqueTotal, `Rubriques – ${dateLabel}`, id])
    }
    if (pretTotal > 0) {
      await conn.query(`INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description, reunion_id)
        VALUES (?, 'ENTREE', 'AUTRE', ?, ?, ?)`,
        [reunion.date_reunion, pretTotal, `Remboursements prêts – ${dateLabel}`, id])
    }
    // Sorties bénéficiaires tontines
    const [beneficiaires] = await conn.query(`
      SELECT b.*, t.nom AS nom_tontine, t.type AS type_tontine,
        m.nom AS bnom, m.prenom AS bprenom,
        COALESCE(SUM(CASE WHEN ct.est_echec=0 THEN ct.montant_paye ELSE 0 END),0) AS pot
      FROM beneficiaires b
      JOIN tontines t ON t.id = b.tontine_id
      LEFT JOIN membres m ON m.id = b.membre_id
      LEFT JOIN cotisations_tontine ct ON ct.reunion_id=b.reunion_id AND ct.tontine_id=b.tontine_id
      WHERE b.reunion_id=? AND b.membre_id IS NOT NULL
      GROUP BY b.tontine_id, b.membre_id
    `, [id])

    for (const b of beneficiaires) {
      // Pour la PRESENCE : utilise montant_membre si défini, sinon pot complet
      const sortie = (b.type_tontine === 'PRESENCE' && b.montant_membre !== null)
        ? b.montant_membre
        : b.pot
      if (sortie > 0) {
        await conn.query(`INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description, reunion_id)
          VALUES (?, 'SORTIE', 'COTISATION_TONTINE', ?, ?, ?)`,
          [reunion.date_reunion, sortie, `Bénéficiaire ${b.nom_tontine} – ${b.bprenom} ${b.bnom}`, id])
      }
    }

    // ── 7. Historique bénéficiaires + incrément nb_reunions_tour ──
    try {
      for (const b of beneficiaires) {
        const sortie = (b.type_tontine === 'PRESENCE' && b.montant_membre !== null)
          ? b.montant_membre : b.pot
        if (sortie > 0) {
          const [[t]] = await conn.query('SELECT tour_actuel FROM tontines WHERE id=?', [b.tontine_id])
          await conn.query(`
            INSERT INTO historique_beneficiaires
              (tontine_id, membre_id, tour, reunion_id, montant_recu)
            VALUES (?, ?, ?, ?, ?)
          `, [b.tontine_id, b.membre_id, t?.tour_actuel || 1, id, sortie])
        }
      }
      await conn.query(
        'UPDATE tontines SET nb_reunions_tour = nb_reunions_tour + 1 WHERE actif = 1'
      )
    } catch (_) { /* nouvelles tables/colonnes absentes si migration non encore appliquée */ }

    await conn.commit()
    res.json({
      success: true,
      message: 'Réunion validée avec succès',
      data: { total_collecte: total }
    })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// ── POST /api/reunions/:id/rouvrir ────────────────────────────
// Uniquement le jour même. Inverse la validation, enregistre l'amende.
async function rouvrir(req, res, next) {
  let conn
  try {
    const { id } = req.params
    const { montant_amende = 0 } = req.body

    const [[reunion]] = await pool.query('SELECT * FROM reunions WHERE id = ?', [id])
    if (!reunion) return res.status(404).json({ success: false, message: 'Réunion introuvable' })
    if (reunion.statut !== 'VALIDEE')
      return res.status(400).json({ success: false, message: 'La réunion n\'est pas validée' })

    // Vérification même jour
    const reunionDate = new Date(reunion.date_reunion).toISOString().split('T')[0]
    const today       = new Date().toISOString().split('T')[0]
    if (reunionDate !== today)
      return res.status(400).json({ success: false, message: 'La réouverture n\'est possible que le jour même' })

    conn = await pool.getConnection()
    await conn.beginTransaction()

    // Supprime tous les mouvements liés à cette réunion (validation + encaissements sanctions)
    await conn.query('DELETE FROM mouvements_caisse WHERE reunion_id=?', [id])

    // Remet les sanctions à NON_PAYEE (leurs mouvements viennent d'être supprimés)
    await conn.query('UPDATE sanctions SET statut="NON_PAYEE" WHERE reunion_id=?', [id])

    // Inverse les soldes_membres ajoutés lors de la validation
    try {
      const [rubAll] = await conn.query('SELECT * FROM cotisations_rubrique WHERE reunion_id=?', [id])
      const soldesDiff = {}
      for (const r of rubAll) {
        if (!soldesDiff[r.membre_id]) soldesDiff[r.membre_id] = { fc: 0, fb: 0 }
        if (r.rubrique === 'FONDS_CAISSE') soldesDiff[r.membre_id].fc += Number(r.montant)
        if (r.rubrique === 'BANQUE')       soldesDiff[r.membre_id].fb += Number(r.montant)
      }
      for (const [mid, d] of Object.entries(soldesDiff)) {
        if (d.fc > 0 || d.fb > 0) {
          await conn.query(
            'UPDATE soldes_membres SET fond_caisse = fond_caisse - ?, fond_banque = fond_banque - ? WHERE membre_id=?',
            [d.fc, d.fb, mid]
          )
        }
      }
    } catch (_) {}

    // Remet les échéances EN_RETARD en ATTENDU (pas encore payées)
    await conn.query(
      'UPDATE echeances_pret SET statut="ATTENDU", penalite=0 WHERE reunion_id=? AND statut="EN_RETARD"',
      [id]
    )
    // Remet les prêts dont toutes les échéances sont maintenant ATTENDU
    await conn.query(`
      UPDATE prets SET statut='EN_COURS'
      WHERE statut='EN_RETARD'
        AND id NOT IN (SELECT DISTINCT pret_id FROM echeances_pret WHERE statut='EN_RETARD')
    `)

    // Remet la réunion en BROUILLON
    await conn.query('UPDATE reunions SET statut="BROUILLON", total_collecte=0 WHERE id=?', [id])

    // Inverse nb_reunions_tour et efface l'historique bénéficiaires de cette réunion
    try {
      await conn.query(
        'UPDATE tontines SET nb_reunions_tour = GREATEST(nb_reunions_tour - 1, 0) WHERE actif = 1'
      )
      await conn.query('DELETE FROM historique_beneficiaires WHERE reunion_id=?', [id])
    } catch (_) { /* colonnes/tables absentes si migration non encore appliquée */ }

    // Amende de réouverture (sans reunion_id pour ne pas être supprimée à la prochaine réouverture)
    if (montant_amende > 0) {
      await conn.query(`
        INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description)
        VALUES (?, 'ENTREE', 'AUTRE', ?, ?)
      `, [reunion.date_reunion, montant_amende, `Amende réouverture – réunion du ${new Date(reunion.date_reunion).toLocaleDateString('fr-FR')}`])
    }

    await conn.commit()
    res.json({ success: true, message: 'Réunion réouverte' })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// ── POST /api/reunions/:id/sanctions ─────────────────────────
async function addSanction(req, res, next) {
  let conn
  try {
    const { id } = req.params
    const { membre_id, type, description, montant, statut } = req.body

    if (!membre_id || !type)
      return res.status(400).json({ success: false, message: 'membre_id et type sont obligatoires' })

    const montantNum = Number(montant) || 0
    const statutVal  = statut || 'NON_PAYEE'

    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [result] = await conn.query(
      'INSERT INTO sanctions (reunion_id, membre_id, type, description, montant, statut) VALUES (?, ?, ?, ?, ?, ?)',
      [id, membre_id, type, description || null, montantNum, statutVal]
    )

    // Mouvement caisse immédiat si la sanction est créée directement comme PAYEE
    if (statutVal === 'PAYEE' && montantNum > 0) {
      const [[m]] = await conn.query('SELECT nom, prenom FROM membres WHERE id=?', [membre_id])
      await conn.query(
        `INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description, reunion_id)
         VALUES (CURDATE(), 'ENTREE', 'AUTRE', ?, ?, ?)`,
        [montantNum, `Sanction encaissée – ${m.prenom} ${m.nom} (${type})`, Number(id)]
      )
    }

    await conn.commit()
    res.status(201).json({ success: true, data: { id: result.insertId } })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// ── PUT /api/reunions/:id/sanctions/:sid ──────────────────────
async function updateSanction(req, res, next) {
  let conn
  try {
    const { id, sid } = req.params
    const { statut, montant, description } = req.body

    const [[s]] = await pool.query('SELECT * FROM sanctions WHERE id=? AND reunion_id=?', [sid, id])
    if (!s) return res.status(404).json({ success: false, message: 'Sanction introuvable' })

    const newStatut  = statut  ?? s.statut
    const newMontant = Number(montant ?? s.montant)

    conn = await pool.getConnection()
    await conn.beginTransaction()

    await conn.query(
      'UPDATE sanctions SET statut=?, montant=?, description=? WHERE id=?',
      [newStatut, newMontant, description ?? s.description, sid]
    )

    // Génère le mouvement caisse au moment de l'encaissement
    if (newStatut === 'PAYEE' && s.statut !== 'PAYEE' && newMontant > 0) {
      const [[m]] = await conn.query('SELECT nom, prenom FROM membres WHERE id=?', [s.membre_id])
      await conn.query(
        `INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description, reunion_id)
         VALUES (CURDATE(), 'ENTREE', 'AUTRE', ?, ?, ?)`,
        [newMontant, `Sanction encaissée – ${m.prenom} ${m.nom} (${s.type})`, Number(id)]
      )
    }

    await conn.commit()
    res.json({ success: true, message: 'Sanction mise à jour' })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// ── DELETE /api/reunions/:id/sanctions/:sid ───────────────────
async function removeSanction(req, res, next) {
  try {
    const { id, sid } = req.params
    const [[s]] = await pool.query('SELECT statut FROM sanctions WHERE id=? AND reunion_id=?', [sid, id])
    if (!s) return res.status(404).json({ success: false, message: 'Sanction introuvable' })
    if (s.statut === 'PAYEE')
      return res.status(400).json({ success: false, message: 'Impossible de supprimer une sanction payée' })

    await pool.query('DELETE FROM sanctions WHERE id=?', [sid])
    res.json({ success: true, message: 'Sanction supprimée' })
  } catch (err) {
    next(err)
  }
}

// ── DELETE /api/reunions/:id ──────────────────────────────────
async function remove(req, res, next) {
  try {
    const { id } = req.params
    const [[reunion]] = await pool.query('SELECT statut FROM reunions WHERE id = ?', [id])
    if (!reunion) return res.status(404).json({ success: false, message: 'Réunion introuvable' })
    if (reunion.statut === 'VALIDEE')
      return res.status(400).json({ success: false, message: 'Impossible de supprimer une réunion validée' })

    await pool.query('DELETE FROM cotisations_tontine  WHERE reunion_id=?', [id])
    await pool.query('DELETE FROM cotisations_rubrique WHERE reunion_id=?', [id])
    await pool.query('DELETE FROM beneficiaires        WHERE reunion_id=?', [id])
    await pool.query('DELETE FROM sanctions            WHERE reunion_id=?', [id])
    try { await pool.query('DELETE FROM reunion_references_paiement WHERE reunion_id=?', [id]) } catch (_) { /* table absente */ }
    await pool.query('UPDATE echeances_pret SET reunion_id=NULL WHERE reunion_id=?', [id])
    await pool.query('DELETE FROM reunions             WHERE id=?',         [id])

    res.json({ success: true, message: 'Réunion supprimée' })
  } catch (err) {
    next(err)
  }
}

module.exports = {
  getAll, getOne, create, sauvegarder, setBeneficiaire,
  valider, rouvrir,
  addSanction, updateSanction, removeSanction,
  remove
}
