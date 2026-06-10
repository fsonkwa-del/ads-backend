const pool = require('../config/db')

const addYears = (dateStr, n) => {
  const d = new Date(dateStr)
  d.setFullYear(d.getFullYear() + n)
  return d.toISOString().slice(0, 10)
}

// Slug → code de poste (MAJUSCULES, sans accents)
function slugCode(label) {
  return String(label).normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'POSTE'
}

// ── Définitions de postes (statutaires + personnalisés) ─────────
async function getPostesDef(db) {
  const [rows] = await db.query(
    'SELECT code, label, ordre, a_adjoint, multiple, systeme FROM bureau_postes_def WHERE actif = 1 ORDER BY ordre, label'
  )
  return rows.map(r => ({ ...r, a_adjoint: !!r.a_adjoint, multiple: !!r.multiple, systeme: !!r.systeme }))
}
async function getDefMap(db) {
  return new Map((await getPostesDef(db)).map(d => [d.code, d]))
}

// ── Composition d'un mandat (ordonnée selon les définitions) ────
async function getComposition(db, mandatId) {
  const [rows] = await db.query(`
    SELECT bp.id, bp.membre_id, bp.poste, bp.role, m.nom, m.prenom, COALESCE(d.ordre, 999) AS ordre
    FROM bureau_postes bp
    JOIN membres m ON m.id = bp.membre_id
    LEFT JOIN bureau_postes_def d ON d.code = bp.poste
    WHERE bp.mandat_id = ?
    ORDER BY ordre, FIELD(bp.role,'TITULAIRE','ADJOINT'), m.nom, m.prenom
  `, [mandatId])
  return rows
}

// ── Éligibilité : pas plus de 2 mandats consécutifs par membre ──
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

function validerComposition(composition, defMap) {
  const errors = new Set()
  const vusMembres = new Set()
  const slots = new Set()
  for (const c of composition) {
    const mid = Number(c.membre_id)
    const def = defMap.get(c.poste)
    if (!mid || !def || !['TITULAIRE', 'ADJOINT'].includes(c.role)) { errors.add('Une entrée de composition est invalide.'); continue }
    if (vusMembres.has(mid)) errors.add('Un même membre ne peut occuper deux postes dans le même bureau.')
    vusMembres.add(mid)
    if (def.multiple) {
      if (c.role === 'ADJOINT') errors.add(`Le poste « ${def.label} » n'a pas d'adjoint.`)
    } else {
      if (c.role === 'ADJOINT' && !def.a_adjoint) errors.add(`Le poste « ${def.label} » n'a pas d'adjoint.`)
      const slot = `${c.poste}|${c.role}`
      if (slots.has(slot)) errors.add(`Le poste « ${def.label} » (${c.role.toLowerCase()}) est attribué plusieurs fois.`)
      slots.add(slot)
    }
  }
  return [...errors]
}

async function insertComposition(conn, mandatId, composition, defMap) {
  for (const c of composition) {
    const def = defMap.get(c.poste)
    const role = (def && !def.multiple && def.a_adjoint && c.role === 'ADJOINT') ? 'ADJOINT' : 'TITULAIRE'
    await conn.query(
      'INSERT INTO bureau_postes (mandat_id, membre_id, poste, role) VALUES (?, ?, ?, ?)',
      [mandatId, Number(c.membre_id), c.poste, role]
    )
  }
}

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
        postes_def:      await getPostesDef(pool),
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

    const defMap = await getDefMap(pool)
    const errs = validerComposition(composition, defMap)
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
    await insertComposition(conn, r.insertId, composition, defMap)
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
      const defMap = await getDefMap(conn)
      const errs = validerComposition(composition, defMap)
      if (errs.length) { await conn.rollback(); return res.status(400).json({ success: false, message: errs.join(' ') }) }
      const inel = await membresIneligibles(conn, mandat.numero, composition.map(c => c.membre_id))
      if (inel.length) {
        await conn.rollback()
        return res.status(400).json({ success: false, message: `Membre(s) ayant déjà effectué 2 mandats consécutifs (inéligible) : ${await nomsMembres(pool, inel)}` })
      }
      await conn.query('DELETE FROM bureau_postes WHERE mandat_id = ?', [id])
      await insertComposition(conn, id, composition, defMap)
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
    const defMap = await getDefMap(conn)
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
    await insertComposition(conn, r.insertId, compo, defMap)
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

// ── POSTES PERSONNALISÉS ───────────────────────────────────────
// POST /api/bureau/postes-def
async function createPosteDef(req, res, next) {
  try {
    const { label, a_adjoint = true } = req.body
    if (!label || !String(label).trim()) return res.status(400).json({ success: false, message: 'Le libellé du poste est obligatoire.' })
    let code = slugCode(label)
    const [[exist]] = await pool.query('SELECT code FROM bureau_postes_def WHERE code = ?', [code])
    if (exist) code = `${code}_${Date.now().toString().slice(-4)}`
    const [[{ maxo }]] = await pool.query('SELECT COALESCE(MAX(ordre),0) AS maxo FROM bureau_postes_def WHERE ordre < 100')
    const ordre = Math.min(99, Number(maxo) + 1)
    await pool.query(
      'INSERT INTO bureau_postes_def (code, label, ordre, a_adjoint, multiple, systeme, actif) VALUES (?, ?, ?, ?, 0, 0, 1)',
      [code, String(label).trim(), ordre, a_adjoint ? 1 : 0]
    )
    res.status(201).json({ success: true, data: { code } })
  } catch (err) { next(err) }
}

// PUT /api/bureau/postes-def/:code
async function updatePosteDef(req, res, next) {
  try {
    const { code } = req.params
    const { label, a_adjoint } = req.body
    const [[def]] = await pool.query('SELECT systeme FROM bureau_postes_def WHERE code = ?', [code])
    if (!def) return res.status(404).json({ success: false, message: 'Poste introuvable.' })
    const fields = [], params = []
    if (label && String(label).trim()) { fields.push('label=?'); params.push(String(label).trim()) }
    if (a_adjoint !== undefined && !def.systeme) { fields.push('a_adjoint=?'); params.push(a_adjoint ? 1 : 0) }
    if (!fields.length) return res.json({ success: true, message: 'Rien à modifier.' })
    params.push(code)
    await pool.query(`UPDATE bureau_postes_def SET ${fields.join(', ')} WHERE code = ?`, params)
    res.json({ success: true, message: 'Poste mis à jour.' })
  } catch (err) { next(err) }
}

// DELETE /api/bureau/postes-def/:code
async function deletePosteDef(req, res, next) {
  try {
    const { code } = req.params
    const [[def]] = await pool.query('SELECT systeme FROM bureau_postes_def WHERE code = ?', [code])
    if (!def) return res.status(404).json({ success: false, message: 'Poste introuvable.' })
    if (def.systeme) return res.status(400).json({ success: false, message: 'Poste statutaire — non supprimable.' })
    const [[{ nb }]] = await pool.query('SELECT COUNT(*) AS nb FROM bureau_postes WHERE poste = ?', [code])
    if (nb > 0) return res.status(400).json({ success: false, message: 'Ce poste est utilisé dans un bureau — impossible de le supprimer.' })
    await pool.query('DELETE FROM bureau_postes_def WHERE code = ?', [code])
    res.json({ success: true, message: 'Poste supprimé.' })
  } catch (err) { next(err) }
}

module.exports = {
  getCurrent, getHistorique, createMandat, updateMandat, renouveler, cloturer, remove,
  createPosteDef, updatePosteDef, deletePosteDef,
}
