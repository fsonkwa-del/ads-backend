const pool = require('../config/db')
const { arrondirFCFA } = require('../utils/money')
const { disponiblePrets } = require('../utils/reliquat')

// ── GET /api/caisse/soldes ────────────────────────────────────
async function getSoldes(req, res, next) {
  try {
    const [overdue] = await pool.query(`
      SELECT DISTINCT membre_id FROM contributions_aide
      WHERE reconstitue = 0 AND date_limite_reconstitution < CURDATE()
    `).catch(() => [[]])
    const overdueSet = new Set(overdue.map(r => r.membre_id))

    const [rows] = await pool.query(`
      SELECT m.id, m.nom, m.prenom,
        COALESCE(s.fond_caisse, 0) AS fond_caisse,
        COALESCE(s.fond_banque,  0) AS fond_banque,
        s.updated_at
      FROM membres m
      LEFT JOIN soldes_membres s ON s.membre_id = m.id
      WHERE m.statut = 'ACTIF'
      ORDER BY m.nom, m.prenom
    `)
    const data = rows.map(r => ({
      ...r,
      statut_reconstitution: overdueSet.has(r.id) ? 'NON_A_JOUR' : 'A_JOUR',
    }))
    const totaux = {
      total_caisse: data.reduce((s, r) => s + Number(r.fond_caisse), 0),
      total_banque: data.reduce((s, r) => s + Number(r.fond_banque), 0),
    }
    res.json({ success: true, data, totaux })
  } catch (err) { next(err) }
}

// ── GET /api/caisse/tresorerie ────────────────────────────────
async function getTresorerie(req, res, next) {
  try {
    const [[soldes]] = await pool.query(
      'SELECT COALESCE(SUM(fond_caisse),0) AS fc, COALESCE(SUM(fond_banque),0) AS fb FROM soldes_membres'
    )
    const [[flux]] = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type_mvt='ENTREE' THEN montant ELSE 0 END),0) AS entrees,
        COALESCE(SUM(CASE WHEN type_mvt='SORTIE' THEN montant ELSE 0 END),0) AS sorties
      FROM mouvements_caisse
    `)
    let prets_en_cours = 0
    try {
      const [[p]] = await pool.query(
        'SELECT COALESCE(SUM(montant_capital),0) AS v FROM prets WHERE statut IN ("EN_COURS","EN_RETARD")'
      )
      prets_en_cours = Number(p.v)
    } catch (_) {}

    // Disponible prêts à préparer : reliquat reporté + collecte de la séance en cours
    let disponible_prets = 0
    try { disponible_prets = await disponiblePrets(pool) } catch (_) {}

    res.json({
      success: true,
      data: {
        fond_caisse_global:  Number(soldes.fc),
        banque_globale:      Number(soldes.fb),
        tresorerie_actuelle: Number(flux.entrees) - Number(flux.sorties),
        total_entrees:       Number(flux.entrees),
        total_sorties:       Number(flux.sorties),
        prets_en_cours,
        disponible_prets,
      }
    })
  } catch (err) { next(err) }
}

// ── GET /api/caisse/mouvements ────────────────────────────────
// Filtres : ?reunion_id= &date_debut= &date_fin= &categorie=
async function getMouvements(req, res, next) {
  try {
    const { reunion_id, date_debut, date_fin, categorie } = req.query
    const conds = []; const params = []
    if (reunion_id) { conds.push('mc.reunion_id = ?');     params.push(reunion_id) }
    if (date_debut) { conds.push('mc.date_mvt >= ?');      params.push(date_debut) }
    if (date_fin)   { conds.push('mc.date_mvt <= ?');      params.push(date_fin) }
    if (categorie)  { conds.push('mc.categorie = ?');      params.push(categorie) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

    // Fenêtre de solde cumulé (MySQL 8+)
    try {
      const [rows] = await pool.query(`
        SELECT sub.*, r.date_reunion
        FROM (
          SELECT
            mc.id, mc.date_mvt, mc.type_mvt, mc.categorie, mc.montant,
            mc.description, mc.reference, mc.reunion_id,
            SUM(CASE WHEN mc.type_mvt='ENTREE' THEN mc.montant ELSE -mc.montant END)
              OVER (ORDER BY mc.date_mvt ASC, mc.id ASC) AS solde_cumule
          FROM mouvements_caisse mc
        ) sub
        LEFT JOIN reunions r ON r.id = sub.reunion_id
        ${where}
        ORDER BY sub.date_mvt DESC, sub.id DESC
        LIMIT 500
      `, params)
      return res.json({ success: true, data: rows })
    } catch (_) {
      // Fallback sans window function
      const [rows] = await pool.query(`
        SELECT mc.*, r.date_reunion
        FROM mouvements_caisse mc
        LEFT JOIN reunions r ON r.id = mc.reunion_id
        ${where}
        ORDER BY mc.date_mvt DESC, mc.id DESC
        LIMIT 500
      `, params)
      // Solde cumulé calculé en JS
      let running = rows.reduce((s, r) => s + (r.type_mvt === 'ENTREE' ? r.montant : -r.montant), 0)
      const withBalance = []
      for (const row of rows) {
        withBalance.push({ ...row, solde_cumule: running })
        running -= (row.type_mvt === 'ENTREE' ? row.montant : -row.montant)
      }
      return res.json({ success: true, data: withBalance })
    }
  } catch (err) { next(err) }
}

// ── POST /api/caisse/mouvements ───────────────────────────────
async function addMouvement(req, res, next) {
  try {
    const { date_mvt, type_mvt, categorie, montant, description, reference } = req.body
    if (!date_mvt || !type_mvt || !categorie || !montant)
      return res.status(400).json({ success: false, message: 'date_mvt, type_mvt, categorie, montant sont obligatoires' })
    if (!['ENTREE', 'SORTIE'].includes(type_mvt))
      return res.status(400).json({ success: false, message: 'type_mvt invalide (ENTREE | SORTIE)' })

    const [result] = await pool.query(
      'INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description, reference) VALUES (?, ?, ?, ?, ?, ?)',
      [date_mvt, type_mvt, categorie, Number(montant), description || null, reference || null]
    )
    res.status(201).json({ success: true, data: { id: result.insertId } })
  } catch (err) { next(err) }
}

// ── PUT /api/caisse/mouvements/:id ───────────────────────────
// Uniquement les mouvements manuels (reunion_id IS NULL)
async function updateMouvement(req, res, next) {
  try {
    const { id } = req.params
    const [[m]] = await pool.query('SELECT reunion_id FROM mouvements_caisse WHERE id = ?', [id])
    if (!m) return res.status(404).json({ success: false, message: 'Mouvement introuvable' })
    if (m.reunion_id) return res.status(400).json({ success: false, message: 'Impossible de modifier un mouvement lié à une réunion' })

    const { date_mvt, type_mvt, categorie, montant, description, reference } = req.body
    await pool.query(
      'UPDATE mouvements_caisse SET date_mvt=?, type_mvt=?, categorie=?, montant=?, description=?, reference=? WHERE id=?',
      [date_mvt, type_mvt, categorie, Number(montant), description || null, reference || null, id]
    )
    res.json({ success: true, message: 'Mouvement mis à jour' })
  } catch (err) { next(err) }
}

// ── DELETE /api/caisse/mouvements/:id ─────────────────────────
// Uniquement les mouvements manuels (reunion_id IS NULL)
async function deleteMouvement(req, res, next) {
  try {
    const { id } = req.params
    const [[m]] = await pool.query('SELECT reunion_id FROM mouvements_caisse WHERE id = ?', [id])
    if (!m) return res.status(404).json({ success: false, message: 'Mouvement introuvable' })
    if (m.reunion_id) return res.status(400).json({ success: false, message: 'Impossible de supprimer un mouvement lié à une réunion' })

    await pool.query('DELETE FROM mouvements_caisse WHERE id = ?', [id])
    res.json({ success: true, message: 'Mouvement supprimé' })
  } catch (err) { next(err) }
}

// ── GET /api/caisse/reconstitutions ──────────────────────────
async function getReconstitutions(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT ca.*, m.nom, m.prenom,
        a.type_aide, a.date_aide, a.montant_par_membre
      FROM contributions_aide ca
      JOIN membres m ON m.id = ca.membre_id
      JOIN aides a   ON a.id = ca.aide_id
      WHERE ca.reconstitue = 0
        AND ca.date_limite_reconstitution < CURDATE()
      ORDER BY ca.date_limite_reconstitution ASC
    `)
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
}

// ── POST /api/caisse/cassation/simuler ────────────────────────
async function simulerCassation(req, res, next) {
  try {
    const { annee } = req.body
    if (!annee) return res.status(400).json({ success: false, message: 'annee est obligatoire' })

    // Total BANQUE cotisé dans l'année (réunions validées)
    const [[{ total_banque_annee }]] = await pool.query(`
      SELECT COALESCE(SUM(cr.montant),0) AS total_banque_annee
      FROM cotisations_rubrique cr
      JOIN reunions r ON r.id = cr.reunion_id
      WHERE cr.rubrique = 'BANQUE' AND YEAR(r.date_reunion) = ? AND r.statut = 'VALIDEE'
    `, [annee])

    // Intérêts totaux prévus sur les prêts de l'année + part retenue à la source
    const [pretsDuAnnee] = await pool.query(
      'SELECT montant_capital, taux_mensuel, nb_echeances, interet_retenu_source FROM prets WHERE YEAR(date_debut) = ?',
      [annee]
    )
    let total_interets_annee    = 0
    let interets_retenus_source = 0   // intérêts encaissés dès l'octroi (retenus du décaissement)
    for (const p of pretsDuAnnee) {
      const interetsMensuel = arrondirFCFA(Number(p.montant_capital) * Number(p.taux_mensuel) / 100)
      const factor          = p.nb_echeances === 0 ? 1 : Number(p.nb_echeances)
      const interetsPret    = interetsMensuel * factor
      total_interets_annee += interetsPret
      if (p.interet_retenu_source) interets_retenus_source += interetsPret
    }

    // Intérêts encaissés via les échéances PAYE (prêts classiques) dans des réunions de l'année
    const [[{ interets_echeances }]] = await pool.query(`
      SELECT COALESCE(SUM(ep.montant_interets), 0) AS interets_echeances
      FROM echeances_pret ep
      JOIN reunions r ON r.id = ep.reunion_id
      WHERE ep.statut = 'PAYE' AND YEAR(r.date_reunion) = ?
    `, [annee])

    // Intérêts réellement encaissés = échéances payées + intérêts retenus à la source
    const interets_encaisses  = Number(interets_echeances) + interets_retenus_source
    const interets_en_attente = Math.max(0, total_interets_annee - interets_encaisses)

    // Cotisations BANQUE de l'année par membre
    const [cotisParMembre] = await pool.query(`
      SELECT cr.membre_id, SUM(cr.montant) AS cotis_banque_annee
      FROM cotisations_rubrique cr
      JOIN reunions r ON r.id = cr.reunion_id
      WHERE cr.rubrique = 'BANQUE' AND YEAR(r.date_reunion) = ? AND r.statut = 'VALIDEE'
      GROUP BY cr.membre_id
    `, [annee])
    const cotisMap = Object.fromEntries(cotisParMembre.map(r => [r.membre_id, Number(r.cotis_banque_annee)]))

    // Soldes actuels
    const [soldes] = await pool.query(`
      SELECT m.id AS membre_id, m.nom, m.prenom,
        COALESCE(s.fond_banque,0) AS solde_banque
      FROM membres m
      LEFT JOIN soldes_membres s ON s.membre_id = m.id
      WHERE m.statut = 'ACTIF'
      ORDER BY m.nom, m.prenom
    `)

    const tb = Number(total_banque_annee)
    const ti = Number(interets_encaisses)   // seuls les intérêts encaissés sont distribués

    // Répartition des intérêts par la méthode du plus fort reste (Hamilton) :
    // chaque part est plancher-arrondie au pas de 5, puis le reliquat (multiple de 5)
    // est attribué +5 par +5 aux plus grosses fractions. Garantit Σ parts = ti exactement.
    const PAS = 5
    const details = soldes.map(s => {
      const cotis_banque_annee = cotisMap[s.membre_id] || 0
      const exact = tb > 0 ? (cotis_banque_annee / tb) * ti : 0
      const base  = Math.floor(exact / PAS) * PAS
      return {
        membre_id: s.membre_id, nom: s.nom, prenom: s.prenom,
        solde_banque: Number(s.solde_banque),
        cotis_banque_annee,
        _frac: exact - base,
        part_interets: base,
      }
    })

    if (tb > 0) {
      const distribues = details.reduce((sum, d) => sum + d.part_interets, 0)
      let reliquat = Math.max(0, Math.round((ti - distribues) / PAS))   // nb de tranches de 5 à placer
      const ordre = [...details].sort((a, b) => b._frac - a._frac || b.cotis_banque_annee - a.cotis_banque_annee)
      for (let i = 0; i < reliquat && i < ordre.length; i++) ordre[i].part_interets += PAS
    }

    for (const d of details) {
      delete d._frac
      d.montant_restitue = d.solde_banque + d.part_interets
    }

    res.json({
      success: true,
      data: {
        annee:                  Number(annee),
        total_banque_annee:     tb,
        total_interets:         ti,               // encaissés → distribués
        interets_encaisses:     ti,
        interets_retenus_source: interets_retenus_source,
        interets_en_attente:    interets_en_attente,
        total_restitue:         details.reduce((s, d) => s + d.montant_restitue, 0),
        details,
      }
    })
  } catch (err) { next(err) }
}

// ── POST /api/caisse/cassation/valider ────────────────────────
async function validerCassation(req, res, next) {
  let conn
  try {
    const { annee, total_interets, total_banque_annee, date_cassation, details } = req.body
    if (!annee || !date_cassation || !details?.length)
      return res.status(400).json({ success: false, message: 'Données incomplètes' })

    const [[existing]] = await pool.query(
      'SELECT id FROM cassations WHERE annee=? AND statut="VALIDEE"', [annee]
    )
    if (existing) return res.status(400).json({ success: false, message: `Cassation ${annee} déjà validée` })

    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [result] = await conn.query(`
      INSERT INTO cassations (annee, total_interets_annee, total_cotisations_banque, date_cassation, statut)
      VALUES (?, ?, ?, ?, 'VALIDEE')
    `, [annee, total_interets || 0, total_banque_annee || 0, date_cassation])
    const cassation_id = result.insertId

    for (const d of details) {
      await conn.query(`
        INSERT INTO cassation_details (cassation_id, membre_id, solde_banque, cotisations_banque, part_interets, montant_restitue)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [cassation_id, d.membre_id, d.solde_banque, d.cotis_banque_annee || 0, d.part_interets, d.montant_restitue])

      if (d.montant_restitue > 0) {
        await conn.query(`
          INSERT INTO mouvements_caisse (date_mvt, type_mvt, categorie, montant, description)
          VALUES (?, 'SORTIE', 'AUTRE', ?, ?)
        `, [date_cassation, d.montant_restitue, `Cassation ${annee} – ${d.prenom} ${d.nom}`])
      }

      await conn.query('UPDATE soldes_membres SET fond_banque = 0 WHERE membre_id=?', [d.membre_id])
    }

    await conn.commit()
    res.json({
      success: true,
      message: `Cassation ${annee} validée`,
      data: { id: cassation_id, total_restitue: details.reduce((s, d) => s + d.montant_restitue, 0) }
    })
  } catch (err) {
    if (conn) await conn.rollback()
    next(err)
  } finally {
    if (conn) conn.release()
  }
}

module.exports = {
  getSoldes, getTresorerie, getMouvements, addMouvement, updateMouvement, deleteMouvement,
  getReconstitutions, simulerCassation, validerCassation,
}
