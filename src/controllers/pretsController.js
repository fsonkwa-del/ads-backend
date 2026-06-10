const pool = require('../config/db')
const { arrondirFCFA } = require('../utils/money')

// ── Lecture d'un paramètre système ───────────────────────────
async function getParam(conn_or_pool, cle, defaut) {
  try {
    const [[row]] = await (conn_or_pool || pool).query(
      'SELECT valeur FROM parametres WHERE cle = ?', [cle]
    )
    return row ? parseFloat(row.valeur) : defaut
  } catch {
    return defaut
  }
}

// ── Calcul du montant par réunion selon le mode ───────────────
// mode 0 → à l'échéance : 1 réunion (prochaine séance)
//   total = capital + capital × taux%
// mode 1 → 1 mois : 2 réunions de remboursement
//   total = capital + capital × taux%
//   par réunion = total ÷ 2
// mode 2 → 2 mois : 4 réunions de remboursement
//   total = capital + capital × taux% × 2  (intérêts fixes sur capital initial)
//   par réunion = total ÷ 4
function calcEcheances(capital, taux, mode) {
  const nbReunions = mode === 0 ? 1 : mode === 1 ? 2 : 4
  const interets   = arrondirFCFA(capital * taux / 100) * (mode === 0 ? 1 : mode)
  const total      = capital + interets
  const parReunion = arrondirFCFA(total / nbReunions)
  const reste      = total - parReunion * nbReunions
  return { nbReunions, total, parReunion, reste }
}

// ── GET /api/prets ────────────────────────────────────────────
async function getAll(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT
        p.*,
        m.nom, m.prenom,
        mg.nom AS garant_nom, mg.prenom AS garant_prenom,
        COUNT(ep.id)                                          AS nb_echeances,
        SUM(CASE WHEN ep.statut='PAYE'  THEN 1 ELSE 0 END)   AS nb_payees,
        COALESCE(SUM(ep.montant_paye), 0)                    AS total_rembourse,
        COALESCE(SUM(ep.montant_du), 0) AS total_du
      FROM prets p
      JOIN membres m ON m.id = p.membre_id
      LEFT JOIN membres mg ON mg.id = p.garant_id
      LEFT JOIN echeances_pret ep ON ep.pret_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `)
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
}

// ── GET /api/prets/:id ────────────────────────────────────────
async function getOne(req, res, next) {
  try {
    const { id } = req.params
    const [[pret]] = await pool.query(`
      SELECT p.*, m.nom, m.prenom, mg.nom AS garant_nom, mg.prenom AS garant_prenom
      FROM prets p
      JOIN membres m ON m.id = p.membre_id
      LEFT JOIN membres mg ON mg.id = p.garant_id
      WHERE p.id = ?
    `, [id])
    if (!pret) return res.status(404).json({ success: false, message: 'Prêt introuvable' })

    const [echeances] = await pool.query(`
      SELECT ep.*, r.date_reunion
      FROM echeances_pret ep
      LEFT JOIN reunions r ON r.id = ep.reunion_id
      WHERE ep.pret_id = ? ORDER BY ep.numero
    `, [id])

    res.json({ success: true, data: { ...pret, echeances } })
  } catch (err) { next(err) }
}

// ── GET /api/prets/membre/:membre_id ─────────────────────────
async function getByMembre(req, res, next) {
  try {
    const { membre_id } = req.params
    const [rows] = await pool.query(`
      SELECT
        p.*,
        m.nom, m.prenom,
        mg.nom AS garant_nom, mg.prenom AS garant_prenom,
        COUNT(ep.id)                                          AS nb_echeances,
        SUM(CASE WHEN ep.statut='PAYE'  THEN 1 ELSE 0 END)   AS nb_payees,
        COALESCE(SUM(ep.montant_paye), 0)                    AS total_rembourse,
        COALESCE(SUM(ep.montant_du), 0) AS total_du
      FROM prets p
      JOIN membres m ON m.id = p.membre_id
      LEFT JOIN membres mg ON mg.id = p.garant_id
      LEFT JOIN echeances_pret ep ON ep.pret_id = p.id
      WHERE p.membre_id = ?
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `, [membre_id])
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
}

// ── POST /api/prets ───────────────────────────────────────────
// Crée le prêt, génère les échéances et le mouvement SORTIE en caisse.
// mode = nb_echeances : 1 = "en une fois" (2 réunions), 2 = "2 mois" (4 réunions)
async function create(req, res, next) {
  let conn
  try {
    const {
      membre_id, montant_capital, type_garantie,
      garant_id, garants_ids, tontine_garantie_id, reunion_octroi_id, date_debut,
      nb_echeances,            // 0, 1 ou 2
      interet_retenu_source    // booléen : intérêt déduit du montant remis
    } = req.body

    if (!membre_id || !montant_capital || !type_garantie || !date_debut)
      return res.status(400).json({
        success: false,
        message: 'membre_id, montant_capital, type_garantie et date_debut sont obligatoires'
      })

    // Liste des garants : priorité au tableau garants_ids, repli sur garant_id (legacy)
    const garantsList = Array.isArray(garants_ids)
      ? [...new Set(garants_ids.map(Number).filter(Boolean))]
      : (garant_id ? [Number(garant_id)] : [])
    if (type_garantie === 'GARANT' && garantsList.length === 0)
      return res.status(400).json({ success: false, message: 'Au moins un garant est requis pour ce type de garantie.' })

    // ── Règle 1 : un seul prêt par membre par réunion ─────────
    if (reunion_octroi_id) {
      const [[{ nb_jour }]] = await pool.query(
        'SELECT COUNT(*) AS nb_jour FROM prets WHERE membre_id=? AND reunion_octroi_id=?',
        [membre_id, reunion_octroi_id]
      )
      if (nb_jour > 0)
        return res.status(400).json({
          success: false,
          message: 'Ce membre a déjà bénéficié d\'un prêt lors de cette réunion.'
        })
    }

    // ── Règle 2 : prêt actif → garantie Président obligatoire ─
    const [[{ nb_actifs }]] = await pool.query(
      'SELECT COUNT(*) AS nb_actifs FROM prets WHERE membre_id=? AND statut IN (\'EN_COURS\',\'EN_RETARD\')',
      [membre_id]
    )
    if (nb_actifs > 0 && type_garantie !== 'PRESIDENT')
      return res.status(400).json({
        success: false,
        message: 'Ce membre a déjà un prêt en cours. Un second prêt nécessite l\'autorisation du président.'
      })

    // ── Règle 3 : fonds disponibles suffisants ─────────────────
    if (reunion_octroi_id) {
      const [[{ banque }]] = await pool.query(
        'SELECT COALESCE(SUM(montant),0) AS banque FROM cotisations_rubrique WHERE reunion_id=? AND rubrique=\'BANQUE\'',
        [reunion_octroi_id]
      )
      let remboursements = 0
      try {
        const [[r]] = await pool.query(
          'SELECT COALESCE(SUM(montant_paye),0) AS r FROM echeances_pret WHERE reunion_id=?',
          [reunion_octroi_id]
        )
        remboursements = Number(r?.r || 0)
      } catch (_) {}
      const [[{ deja }]] = await pool.query(
        'SELECT COALESCE(SUM(montant_capital),0) AS deja FROM prets WHERE reunion_octroi_id=?',
        [reunion_octroi_id]
      )
      const disponible = Number(banque) + remboursements - Number(deja)
      if (Number(montant_capital) > disponible)
        return res.status(400).json({
          success: false,
          message: `Fonds insuffisants — Disponible : ${Math.round(disponible).toLocaleString('fr-FR')} FCFA, demandé : ${Number(montant_capital).toLocaleString('fr-FR')} FCFA.`
        })
    }

    // ── Règle 4 : la tontine mise en garantie ne doit pas avoir déjà bénéficié ce tour ──
    if (type_garantie === 'TONTINE') {
      if (!tontine_garantie_id)
        return res.status(400).json({ success: false, message: 'La tontine en garantie est obligatoire.' })

      const [[sous]] = await pool.query(
        "SELECT id FROM souscriptions WHERE membre_id=? AND tontine_id=? AND statut='ACTIVE'",
        [membre_id, tontine_garantie_id]
      )
      if (!sous)
        return res.status(400).json({ success: false, message: 'La tontine en garantie n\'appartient pas à l\'emprunteur (souscription active introuvable).' })

      const [[{ deja }]] = await pool.query(`
        SELECT EXISTS(
          SELECT 1 FROM historique_beneficiaires hb
          JOIN tontines t ON t.id = hb.tontine_id
          WHERE hb.membre_id = ? AND hb.tontine_id = ? AND hb.tour = t.tour_actuel
        ) AS deja
      `, [membre_id, tontine_garantie_id])
      if (deja)
        return res.status(400).json({ success: false, message: 'Cette tontine a déjà bénéficié du pot dans le tour actuel ; elle ne peut pas servir de garantie.' })
    }

    if (type_garantie === 'GARANT') {
      // Garants éligibles = ceux ayant ≥1 souscription DYNAMIQUE active non bénéficiaire ce tour
      const [eligibles] = await pool.query(`
        SELECT DISTINCT s.membre_id
        FROM souscriptions s
        JOIN tontines t ON t.id = s.tontine_id
        WHERE s.statut = 'ACTIVE' AND t.actif = 1 AND t.type = 'DYNAMIQUE'
          AND s.membre_id IN (?)
          AND NOT EXISTS(
            SELECT 1 FROM historique_beneficiaires hb
            WHERE hb.membre_id = s.membre_id AND hb.tontine_id = s.tontine_id AND hb.tour = t.tour_actuel
          )
      `, [garantsList])
      const eligibleSet = new Set(eligibles.map(r => r.membre_id))
      const ineligibles = garantsList.filter(gid => !eligibleSet.has(gid))
      if (ineligibles.length > 0) {
        const [noms] = await pool.query('SELECT nom, prenom FROM membres WHERE id IN (?)', [ineligibles])
        const label = noms.map(m => `${m.prenom} ${m.nom}`).join(', ')
        return res.status(400).json({ success: false, message: `Garant(s) inéligible(s) — aucune tontine disponible en garantie (déjà bénéficiaire ce tour) : ${label}` })
      }
    }

    conn = await pool.getConnection()
    await conn.beginTransaction()

    const taux = await getParam(conn, 'TAUX_INTERET_MENSUEL', 2.5)
    const nb   = Number(nb_echeances)
    const mode = nb === 0 ? 0 : nb === 1 ? 1 : 2
    const retenu = !!interet_retenu_source

    // Intérêt retenu à la source : les échéances ne portent que le capital (taux 0),
    // et seul le net (capital − intérêts) est remis au membre en caisse.
    const { nbReunions, total, parReunion, reste } = calcEcheances(montant_capital, retenu ? 0 : taux, mode)
    const interetsTotal = arrondirFCFA(Number(montant_capital) * taux / 100) * (mode === 0 ? 1 : mode)
    const montantRemis  = retenu ? Number(montant_capital) - interetsTotal : Number(montant_capital)

    // Crée le prêt
    const [result] = await conn.query(`
      INSERT INTO prets
        (membre_id, montant_capital, taux_mensuel, nb_echeances, date_debut,
         type_garantie, garant_id, tontine_garantie_id, reunion_octroi_id, interet_retenu_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [membre_id, montant_capital, taux, mode, date_debut,
        type_garantie, garantsList[0] || null, tontine_garantie_id || null, reunion_octroi_id || null, retenu ? 1 : 0])

    const pret_id = result.insertId

    // Garants multiples (table de jointure)
    for (const gid of garantsList) {
      try {
        await conn.query('INSERT INTO prets_garants (pret_id, membre_id) VALUES (?, ?)', [pret_id, gid])
      } catch (_) { /* table absente si migration phase 4 non appliquée */ }
    }

    // Trouve les réunions cibles pour les échéances
    // mode 0 : prochaine réunion (N+1) — remboursement immédiat
    // modes 1/2 : on saute N+1, on commence à N+2
    let targetReunionIds = []
    if (reunion_octroi_id) {
      const [[r0]] = await conn.query('SELECT date_reunion FROM reunions WHERE id=?', [reunion_octroi_id])
      if (r0) {
        const [futures] = await conn.query(
          'SELECT id FROM reunions WHERE date_reunion > ? ORDER BY date_reunion ASC LIMIT ?',
          [r0.date_reunion, mode === 0 ? 1 : nbReunions + 1]
        )
        targetReunionIds = mode === 0 ? futures.map(r => r.id) : futures.slice(1).map(r => r.id)
      }
    }

    // Génère les lignes d'échéances
    const capitalParEch = arrondirFCFA(Number(montant_capital) / nbReunions)
    for (let i = 0; i < nbReunions; i++) {
      const isLast     = i === nbReunions - 1
      const montant_du = parReunion + (isLast ? reste : 0)
      const capitalEch = isLast ? Number(montant_capital) - capitalParEch * (nbReunions - 1) : capitalParEch
      const montant_interets_ech = montant_du - capitalEch
      const reunion_id = targetReunionIds[i] || null
      await conn.query(
        'INSERT INTO echeances_pret (pret_id, numero, reunion_id, montant_du, montant_interets) VALUES (?, ?, ?, ?, ?)',
        [pret_id, i + 1, reunion_id, montant_du, montant_interets_ech]
      )
    }

    // Mouvement SORTIE en caisse
    const [[membre]] = await conn.query('SELECT nom, prenom FROM membres WHERE id=?', [membre_id])
    await conn.query(`
      INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description, reunion_id)
      VALUES (?, 'SORTIE', 'AUTRE', ?, ?, ?)
    `, [date_debut, montantRemis,
        `Prêt octroyé – ${membre.prenom} ${membre.nom}`,
        reunion_octroi_id || null])

    await conn.commit()

    const [[created]] = await pool.query(
      'SELECT p.*, m.nom, m.prenom FROM prets p JOIN membres m ON m.id=p.membre_id WHERE p.id=?', [pret_id]
    )
    const [echeances] = await pool.query(
      'SELECT * FROM echeances_pret WHERE pret_id=? ORDER BY numero', [pret_id]
    )

    res.status(201).json({ success: true, data: { ...created, echeances, simulation: { nbReunions, total, parReunion } } })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// ── POST /api/prets/echeances/:id/reechelonner ────────────────
// Le membre paie les intérêts dus et le capital est reporté à la prochaine réunion.
async function reechelonner(req, res, next) {
  let conn
  try {
    const { id } = req.params
    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [[ech]] = await conn.query(`
      SELECT ep.*, p.taux_mensuel, p.membre_id, p.nb_echeances
      FROM echeances_pret ep JOIN prets p ON p.id = ep.pret_id
      WHERE ep.id = ? AND ep.statut IN ('ATTENDU','EN_RETARD')
    `, [id])
    if (!ech) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Échéance introuvable ou déjà traitée' }) }

    // Intérêts sur cette échéance = montant_du - capital_par_reunion
    const [[{ max_num }]] = await conn.query('SELECT MAX(numero) AS max_num FROM echeances_pret WHERE pret_id=?', [ech.pret_id])
    const nouveau_num = (max_num || 0) + 1

    // Marque comme rééchelonnée (paie les intérêts seulement)
    const [[pret]] = await conn.query('SELECT montant_capital, nb_echeances FROM prets WHERE id=?', [ech.pret_id])
    const nbR      = pret.nb_echeances === 1 ? 2 : 4
    const montant_du_ech = Number(ech.montant_du ?? ech.montant_total ?? 0)
    const capitalParR    = arrondirFCFA(pret.montant_capital / nbR)
    const montant_interets = arrondirFCFA(Math.max(0, montant_du_ech - capitalParR))

    await conn.query('UPDATE echeances_pret SET montant_paye=? WHERE id=?', [montant_interets, id])

    // Nouvelle échéance pour le capital restant, à la prochaine réunion disponible
    const [[nextReunion]] = await conn.query(`
      SELECT id FROM reunions
      WHERE date_reunion > IFNULL((SELECT date_reunion FROM reunions WHERE id=(SELECT reunion_id FROM echeances_pret WHERE id=?)), CURDATE())
        AND statut='BROUILLON'
      ORDER BY date_reunion ASC LIMIT 1
    `, [id])

    await conn.query(
      'INSERT INTO echeances_pret (pret_id, numero, reunion_id, montant_du, montant_interets) VALUES (?, ?, ?, ?, 0)',
      [ech.pret_id, nouveau_num, nextReunion?.id || null, capitalParR + montant_interets]
    )

    await conn.commit()
    res.json({ success: true, message: 'Échéance rééchelonnée' })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

// ── DELETE /api/prets/:id ─────────────────────────────────────
// Suppression uniquement si la réunion d'octroi est encore en BROUILLON
async function remove(req, res, next) {
  let conn
  try {
    const { id } = req.params

    const [[pret]] = await pool.query(`
      SELECT p.*, m.prenom, m.nom, r.statut AS reunion_statut
      FROM prets p
      JOIN membres m ON m.id = p.membre_id
      LEFT JOIN reunions r ON r.id = p.reunion_octroi_id
      WHERE p.id = ?
    `, [id])

    if (!pret) return res.status(404).json({ success: false, message: 'Prêt introuvable' })
    if (pret.reunion_statut === 'VALIDEE')
      return res.status(400).json({ success: false, message: 'Impossible de supprimer un prêt d\'une réunion validée' })

    conn = await pool.getConnection()
    await conn.beginTransaction()

    // Supprime les échéances (FK CASCADE si en place, sinon explicite)
    try { await conn.query('DELETE FROM echeances_pret WHERE pret_id = ?', [id]) } catch (_) {}
    // Supprime les garants associés
    try { await conn.query('DELETE FROM prets_garants WHERE pret_id = ?', [id]) } catch (_) {}

    // Recompose le montant réellement décaissé (net si intérêt retenu à la source)
    const factor        = pret.nb_echeances === 0 ? 1 : pret.nb_echeances
    const interetsTotal = arrondirFCFA(Number(pret.montant_capital) * Number(pret.taux_mensuel) / 100) * factor
    const montantRemis  = pret.interet_retenu_source ? Number(pret.montant_capital) - interetsTotal : Number(pret.montant_capital)

    // Annule le mouvement SORTIE correspondant
    await conn.query(
      `DELETE FROM mouvements_caisse
       WHERE reunion_id = ? AND type_mvt = 'SORTIE' AND montant = ?
         AND description = ? LIMIT 1`,
      [pret.reunion_octroi_id, montantRemis, `Prêt octroyé – ${pret.prenom} ${pret.nom}`]
    )

    await conn.query('DELETE FROM prets WHERE id = ?', [id])
    await conn.commit()
    res.json({ success: true, message: 'Prêt supprimé' })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

module.exports = { getAll, getOne, getByMembre, create, remove, reechelonner, getParam, calcEcheances }
