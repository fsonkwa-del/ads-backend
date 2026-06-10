const pool = require('../config/db')

// Postes nominatifs (titulaire + adjoint). CONSEILLER : multiples, sans adjoint.
const POSTES = ['PRESIDENT', 'SECRETAIRE', 'TRESORIER', 'COMMISSAIRE_COMPTES', 'CENSEUR', 'CHARGE_CULTUREL', 'CONSEILLER']
const ROLES  = ['TITULAIRE', 'ADJOINT']

const addYears = (dateStr, n) => {
  const d = new Date(dateStr)
  d.setFullYear(d.getFullYear() + n)
  return d.toISOString().slice(0, 10)
}

// ── Composition d'un mandat ────────────────────────────────────
async function getComposition(db, mandatId) {
  const [rows] = await db.query(`
    SELECT bp.id, bp.membre_id, bp.poste, bp.role, m.nom, m.prenom
    FROM bureau_postes bp JOIN membres m ON m.id = bp.membre_id
    WHERE bp.mandat_id = ?
    ORDER BY FIELD(bp.poste,'PRESIDENT','SECRETAIRE','TRESORIER','COMMISSAIRE_COMPTES','CENSEUR','CHARGE_CULTUREL','CONSEILLER'),
             FIELD(bp.role,'TITULAIRE','ADJOINT'), m.nom, m.prenom
  `, [mandatId])
  return rows
}

// ── Éligibilité : un membre ne peut faire plus de 2 mandats consécutifs ──
// Pour un mandat de numéro `targetNumero`, on calcule pour chaque membre actif
// le nombre de mandats consécutifs (numéros target-1, target-2, …) qu'il a occupés.
// run >= 2 → l'ajouter à `targetNumero` ferait 3 consécutifs → inéligible.
async function eligibiliteMembres(db, targetNumero) {
  const [membres] = await db.query("SELECT id, nom, prenom FROM membres WHERE statut='ACTIF' ORDER BY nom, prenom")
  const [rows] = await db.query(`
    SELECT bm.numero, bp.membre_id
    FROM bureau_postes bp JOIN bureau_mandats bm ON bm.id = bp.mandat_id
    WHERE bm.numero < ?
  `, [targetNumero])
  const byNumero = {}
  for (const r of rows) { (byNumero[r.numero] = byNumero[r.numero] || new Set()).add(r.membre_id) }
  return membres.map(m => {
    let run = 0
    for (let n = targetNumero - 1; n >= 1; n--) {
      if (byNumero[n] && byNumero[n].has(m.id)) run++; else break
    }
    return { id: m.id, nom: m.nom, prenom: m.prenom, mandats_consecutifs: run, ineligible: run >= 2 }
  })
}

// Valide la cohérence d'une composition (hors règle d'éligibilité)
function validerComposition(composition) {
  const errors = new Set()
  const vusMembres = new Set()
  const slotsNominatifs = new Set()
  for (const c of composition) {
    const mid = Number(c.membre_id)
    if (!mid || !POSTES.includes(c.poste) || !ROLES.includes(c.role)) {
      errors.add('Une entrée de composition est invalide.'); continue
    }
    if (vusMembres.has(mid)) errors.add('Un même membre ne peut occuper deux postes dans le même bureau.')
    vusMembres.add(mid)
    if (c.poste !== 'CONSEILLER') {
      if (c.role === 'ADJOINT' && c.poste === 'CONSEILLER') errors.add('Un conseiller n\'a pas d\'adjoint.')
      const slot = `${c.poste}|${c.role}`
      if (slotsNominatifs.has(slot)) errors.add(`Le poste ${c.poste} (${c.role.toLowerCase()}) est attribué plusieurs fois.`)
      slotsNominatifs.add(slot)
    }
  }
  return [...errors]
}

async function insertComposition(conn, mandatId, composition) {
  for (const c of composition) {
    const role = c.poste === 'CONSEILLER' ? 'TITULAIRE' : (c.role === 'ADJOINT' ? 'ADJOINT' : 'TITULAIRE')
    await conn.query(
      'INSERT INTO bureau_postes (mandat_id, membre_id, poste, role) VALUES (?, ?, ?, ?)',
      [mandatId, Number(c.membre_id), c.poste, role]
    )
  }
}

// Renvoie les membre_id de `ids` inéligibles (déjà 2 mandats consécutifs avant targetNumero)
async function membresIneligibles(conn, targetNumero, ids) {
  const uniq = [...new Set(ids.map(Number).filter(Boolean))]
  if (!uniq.length) return []
  const elig = await eligibiliteMembres(conn, targetNumero)
  const inelSet = new Set(elig.filter(m => m.ineligible).map(m => m.id))
  return uniq.filter(id => inelSet.has(id))
}

async function nomsMembres(db, ids) {
  if (!ids.length) return ''
  const [rows] = await db.query('SELECT nom, prenom FROM membres WHERE id IN (?)', [ids])
  return rows.map(m => `${m.prenom} ${m.nom}`).join(', ')
}

// ── GET /api/bureau ────────────────────────────────────────────
async function getCurrent(req, res, next) {
  try {
    const [[mandat]] = await pool.query("SELECT * FROM bureau_mandats WHERE statut='EN_COURS' ORDER BY numero DESC LIMIT 1")
    const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(numero),0) AS maxn FROM bureau_mandats')
    const prochainNumero = Number(maxRow.maxn) + 1
    const targetNumero   = mandat ? mandat.numero : prochainNumero
    res.json({
      success: true,
      data: {
        mandat_courant:  mandat || null,
        composition:     mandat ? await getComposition(pool, mandat.id) : [],
        peut_renouveler: !!(mandat && mandat.est_renouvellement === 0),
        prochain_numero: prochainNumero,
        membres:         await eligibiliteMembres(pool, targetNumero),
      }
    })
  } catch (err) { next(err) }
}

// ── GET /api/bureau/historique ─────────────────────────────────
async function getHistorique(req, res, next) {
  try {
    const [mandats] = await pool.query('SELECT * FROM bureau_mandats ORDER BY numero DESC')
    for (const m of mandats) m.composition = await getComposition(pool, m.id)
    res.json({ success: true, data: mandats })
  } catch (err) { next(err) }
}

// ── POST /api/bureau/mandats ───────────────────────────────────
async function createMandat(req, res, next) {
  let conn
  try {
    const { date_debut, date_fin, observations, composition = [] } = req.body
    if (!date_debut) return res.status(400).json({ success: false, message: 'La date de début du mandat est obligatoire.' })
    const fin = date_fin || addYears(date_debut, 2)
    if (new Date(fin) <= new Date(date_debut))
      return res.status(400).json({ success: false, message: 'La date de fin doit être postérieure à la date de début.' })

    const [[encours]] = await pool.query("SELECT id FROM bureau_mandats WHERE statut='EN_COURS' LIMIT 1")
    if (encours) return res.status(400).json({ success: false, message: 'Un mandat est déjà en cours. Clôturez-le avant d\'élire un nouveau bureau.' })

    const errs = validerComposition(composition)
    if (errs.length) return res.status(400).json({ success: false, message: errs.join(' ') })

    conn = await pool.getConnection(); await conn.beginTransaction()
    const [[maxRow]] = await conn.query('SELECT COALESCE(MAX(numero),0) AS maxn FROM bureau_mandats')
    const numero = Number(maxRow.maxn) + 1

    const inel = await membresIneligibles(conn, numero, composition.map(c => c.membre_id))
    if (inel.length) {
      await conn.rollback()
      return res.status(400).json({ success: false, message: `Membre(s) ayant déjà effectué 2 mandats consécutifs (inéligible) : ${await nomsMembres(pool, inel)}` })
    }

    const [r] = await conn.query(
      'INSERT INTO bureau_mandats (numero, date_debut, date_fin, est_renouvellement, statut, observations) VALUES (?, ?, ?, 0, ?, ?)',
      [numero, date_debut, fin, 'EN_COURS', observations || null]
    )
    await insertComposition(conn, r.insertId, composition)
    await conn.commit()
    res.status(201).json({ success: true, data: { id: r.insertId, numero } })
  } catch (err) { if (conn) await conn.rollback(); next(err) } finally { if (conn) conn.release() }
}

// ── PUT /api/bureau/mandats/:id ────────────────────────────────
async function updateMandat(req, res, next) {
  let conn
  try {
    const { id } = req.params
    const { date_debut, date_fin, observations, composition } = req.body
    const [[mandat]] = await pool.query('SELECT * FROM bureau_mandats WHERE id = ?', [id])
    if (!mandat) return res.status(404).json({ success: false, message: 'Mandat introuvable.' })

    conn = await pool.getConnection(); await conn.beginTransaction()

    if (date_debut || date_fin || observations !== undefined) {
      const newDebut = date_debut || mandat.date_debut
      const newFin   = date_fin   || mandat.date_fin
      if (new Date(newFin) <= new Date(newDebut)) {
        await conn.rollback()
        return res.status(400).json({ success: false, message: 'La date de fin doit être postérieure à la date de début.' })
      }
      await conn.query(
        'UPDATE bureau_mandats SET date_debut=?, date_fin=?, observations=? WHERE id=?',
        [newDebut, newFin, observations !== undefined ? (observations || null) : mandat.observations, id]
      )
    }

    if (Array.isArray(composition)) {
      const errs = validerComposition(composition)
      if (errs.length) { await conn.rollback(); return res.status(400).json({ success: false, message: errs.join(' ') }) }
      const inel = await membresIneligibles(conn, mandat.numero, composition.map(c => c.membre_id))
      if (inel.length) {
        await conn.rollback()
        return res.status(400).json({ success: false, message: `Membre(s) ayant déjà effectué 2 mandats consécutifs (inéligible) : ${await nomsMembres(pool, inel)}` })
      }
      await conn.query('DELETE FROM bureau_postes WHERE mandat_id = ?', [id])
      await insertComposition(conn, id, composition)
    }

    await conn.commit()
    res.json({ success: true, message: 'Bureau mis à jour.' })
  } catch (err) { if (conn) await conn.rollback(); next(err) } finally { if (conn) conn.release() }
}

// ── POST /api/bureau/mandats/:id/renouveler ────────────────────
async function renouveler(req, res, next) {
  let conn
  try {
    const { id } = req.params
    const { date_debut, date_fin } = req.body
    const [[mandat]] = await pool.query('SELECT * FROM bureau_mandats WHERE id = ?', [id])
    if (!mandat) return res.status(404).json({ success: false, message: 'Mandat introuvable.' })
    if (mandat.est_renouvellement === 1)
      return res.status(400).json({ success: false, message: 'Ce mandat est déjà une reconduction (4 ans atteints). Une nouvelle élection est requise.' })

    conn = await pool.getConnection(); await conn.beginTransaction()
    const [[maxRow]] = await conn.query('SELECT COALESCE(MAX(numero),0) AS maxn FROM bureau_mandats')
    const numero   = Number(maxRow.maxn) + 1
    const newDebut = date_debut || addYears(mandat.date_debut, 2)
    const newFin   = date_fin   || addYears(newDebut, 2)

    const compo = (await getComposition(conn, mandat.id)).map(c => ({ membre_id: c.membre_id, poste: c.poste, role: c.role }))

    const inel = await membresIneligibles(conn, numero, compo.map(c => c.membre_id))
    if (inel.length) {
      await conn.rollback()
      return res.status(400).json({ success: false, message: `Reconduction impossible — membre(s) à 2 mandats consécutifs : ${await nomsMembres(pool, inel)}` })
    }

    await conn.query("UPDATE bureau_mandats SET statut='TERMINE' WHERE id=?", [id])
    const [r] = await conn.query(
      'INSERT INTO bureau_mandats (numero, date_debut, date_fin, est_renouvellement, mandat_precedent_id, statut, observations) VALUES (?, ?, ?, 1, ?, ?, ?)',
      [numero, newDebut, newFin, id, 'EN_COURS', mandat.observations]
    )
    await insertComposition(conn, r.insertId, compo)
    await conn.commit()
    res.status(201).json({ success: true, data: { id: r.insertId, numero } })
  } catch (err) { if (conn) await conn.rollback(); next(err) } finally { if (conn) conn.release() }
}

// ── POST /api/bureau/mandats/:id/cloturer ──────────────────────
async function cloturer(req, res, next) {
  try {
    const { id } = req.params
    const [r] = await pool.query("UPDATE bureau_mandats SET statut='TERMINE' WHERE id=? AND statut='EN_COURS'", [id])
    if (!r.affectedRows) return res.status(400).json({ success: false, message: 'Mandat introuvable ou déjà clôturé.' })
    res.json({ success: true, message: 'Mandat clôturé.' })
  } catch (err) { next(err) }
}

// ── DELETE /api/bureau/mandats/:id ─────────────────────────────
async function remove(req, res, next) {
  try {
    const { id } = req.params
    const [[ref]] = await pool.query('SELECT id FROM bureau_mandats WHERE mandat_precedent_id = ?', [id])
    if (ref) return res.status(400).json({ success: false, message: 'Impossible de supprimer : ce mandat est référencé par une reconduction.' })
    const [r] = await pool.query('DELETE FROM bureau_mandats WHERE id = ?', [id])
    if (!r.affectedRows) return res.status(404).json({ success: false, message: 'Mandat introuvable.' })
    res.json({ success: true, message: 'Mandat supprimé.' })
  } catch (err) { next(err) }
}

module.exports = { getCurrent, getHistorique, createMandat, updateMandat, renouveler, cloturer, remove }
