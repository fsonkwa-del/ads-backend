const pool   = require('../config/db')
const ExcelJS = require('exceljs')
const PDFDocument = require('pdfkit')
const { repartirEgal } = require('../utils/money')
const { reliquatPrecedent } = require('../utils/reliquat')

// ── Format helpers ────────────────────────────────────────────
// toLocaleString('fr-FR') produit des espaces insécables (U+00A0) que PDFKit rend en '/'.
// On utilise une regex pour avoir un espace ordinaire, compatible PDFKit et Excel.
const fmtNum  = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

// formatFCFA : séparateur espace ASCII 32 — aucun U+00A0 / U+202F, compatible PDFKit.
function formatFCFA(montant) {
  if (montant === null || montant === undefined) return '0 FCFA'
  const n = Math.round(Number(montant))
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' FCFA'
}
const fmtDate = d => d ? new Date(d).toLocaleDateString('fr-FR') : '—'
const nowStr  = () => new Date().toLocaleDateString('fr-FR') + ' à ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

const CAT_LABELS = {
  COTISATION_TONTINE:  'Cotisations tontines',
  COTISATION_RUBRIQUE: 'Fonds caisse / Banque',
  SOUSCRIPTION:        "Droits d'inscription",
  AUTRE:               'Autres',
}

// ═══════════════════════════════════════════════════════════════
//  PDF HELPERS
// ═══════════════════════════════════════════════════════════════
const PDF_ML = 40
const PDF_HEAD_H = 24
const PDF_ROW_H  = 20
const PDF_FOOT_H = 22

function makePDF(res, filename, title, subtitle, layout = 'portrait') {
  const doc = new PDFDocument({
    size: 'A4', layout, margin: PDF_ML, bufferPages: true, autoFirstPage: false,
    lineGap: 0, compress: true
  })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  doc.pipe(res)

  const drawHeader = () => {
    const W = doc.page.width
    doc.rect(0, 0, W, 98).fill('#1B4332')
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(14)
    const hOpts = { width: W - PDF_ML * 2, align: 'center', lineGap: 0, paragraphGap: 0 }
    doc.text('ADS', PDF_ML, 16, hOpts)
    doc.font('Helvetica').fontSize(9)
    doc.text('Association pour le Développement et le Social — Douala, Lendi', PDF_ML, 36, hOpts)
    doc.fillColor('#BBE5A5').font('Helvetica-Bold').fontSize(11)
    doc.text(title, PDF_ML, 58, hOpts)
    if (subtitle) {
      doc.fillColor('#93CFA6').font('Helvetica').fontSize(9)
      doc.text(subtitle, PDF_ML, 78, hOpts)
    }
    doc.y = 106  // contenu démarre 8pt sous le bandeau (était 112)
  }

  doc.on('pageAdded', drawHeader)
  doc.addPage()
  return doc
}

function finalizePDF(doc) {
  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    const W  = doc.page.width
    const fy = doc.page.height - 40  // position absolue fixe en bas de page

    // IMPORTANT : on annule la marge basse le temps d'écrire le pied de page.
    // Sinon doc.text() près du bas de page dépasse maxY et PDFKit ajoute
    // automatiquement une nouvelle page (→ pages vides parasites).
    const savedBottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0

    // Ligne de séparation
    doc.moveTo(PDF_ML, fy - 6).lineTo(W - PDF_ML, fy - 6)
      .strokeColor('#CCCCCC').lineWidth(0.5).stroke().lineWidth(1)

    // Texte du pied de page en position absolue
    doc.fillColor('#999999').font('Helvetica').fontSize(7.5)
    const fOpts = { width: W - PDF_ML * 2, lineBreak: false, lineGap: 0, paragraphGap: 0 }
    doc.text(`Généré le ${nowStr()} — Confidentiel`, PDF_ML, fy, { ...fOpts, align: 'left' })
    doc.y = fy  // reset avant 2e appel
    doc.text(`Page ${i + 1} / ${range.count}`, PDF_ML, fy, { ...fOpts, align: 'right' })

    doc.page.margins.bottom = savedBottom  // restaure la marge
  }
  doc.flushPages()
  doc.end()
}

function drawTable(doc, { title, headers, rows, colWidths, footerRow }) {
  const W     = doc.page.width
  const totalW = colWidths.reduce((a, b) => a + b, 0)
  const LIMIT  = doc.page.height - 42  // laisser 42pt pour le pied de page (était 45)

  // Scale columns if too wide
  const scale = totalW > (W - PDF_ML * 2) ? (W - PDF_ML * 2) / totalW : 1
  const cw    = colWidths.map(w => Math.floor(w * scale))
  const cwTot = cw.reduce((a, b) => a + b, 0)

  // Section title
  if (title) {
    if (doc.y + 24 > LIMIT) doc.addPage()
    const tY = doc.y + 2
    doc.fillColor('#1B4332').font('Helvetica-Bold').fontSize(10)
    doc.text(title, PDF_ML, tY, { lineGap: 0, paragraphGap: 0 })
    doc.y = tY + 14  // reset explicite : empêche PDFKit de doubler l'avance
  }

  let y = doc.y

  // Dessiner les en-têtes de colonnes.
  // IMPORTANT : après chaque doc.text(), on remet doc.y à la position connue
  // pour empêcher PDFKit d'auto-paginer au milieu d'une ligne de tableau.
  const renderHeaders = (atY) => {
    let cx = PDF_ML
    cw.forEach((w, i) => {
      doc.rect(cx, atY, w, PDF_HEAD_H).fill('#1B4332')
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8)
      doc.text(headers[i] || '', cx + 4, atY + 7, { width: w - 8, lineBreak: false, ellipsis: true, lineGap: 0 })
      doc.y = atY + PDF_HEAD_H  // reset après chaque cellule
      cx += w
    })
    return atY + PDF_HEAD_H
  }

  if (y + PDF_HEAD_H > LIMIT) { doc.addPage(); y = doc.y }
  y = renderHeaders(y)

  rows.forEach((row, ri) => {
    // Vérifier l'espace avant chaque ligne (jamais laisser PDFKit décider)
    if (y + PDF_ROW_H > LIMIT) {
      doc.addPage()
      y = doc.y
      y = renderHeaders(y)
    }
    const bg = ri % 2 === 0 ? '#FFFFFF' : '#F2F6F2'
    let cx = PDF_ML
    cw.forEach((w, ci) => {
      const raw = row[ci]
      const txt = raw === null || raw === undefined ? '—' : String(raw)
      doc.rect(cx, y, w, PDF_ROW_H).fill(bg)
      doc.fillColor('#222222').font('Helvetica').fontSize(8)
      doc.text(txt, cx + 4, y + 5, { width: w - 8, lineBreak: false, ellipsis: true, lineGap: 0 })
      doc.y = y + PDF_ROW_H  // reset impératif après chaque cellule
      cx += w
    })
    doc.moveTo(PDF_ML, y + PDF_ROW_H).lineTo(PDF_ML + cwTot, y + PDF_ROW_H)
      .strokeColor('#DEDEDE').lineWidth(0.4).stroke().lineWidth(1)
    y += PDF_ROW_H
  })

  if (footerRow) {
    if (y + PDF_FOOT_H > LIMIT) { doc.addPage(); y = doc.y }
    let cx = PDF_ML
    cw.forEach((w, i) => {
      const val = footerRow[i]
      doc.rect(cx, y, w, PDF_FOOT_H).fill('#FEFCE8')
      doc.fillColor('#333333').font('Helvetica-Bold').fontSize(8)
      doc.text(val === null || val === undefined ? '' : String(val),
        cx + 4, y + 5, { width: w - 8, lineBreak: false, ellipsis: true, lineGap: 0 })
      doc.y = y + PDF_FOOT_H  // reset après chaque cellule
      cx += w
    })
    doc.moveTo(PDF_ML, y + PDF_FOOT_H).lineTo(PDF_ML + cwTot, y + PDF_FOOT_H)
      .strokeColor('#BBBBBB').lineWidth(0.6).stroke().lineWidth(1)
    y += PDF_FOOT_H
  }

  doc.y = y + 6  // espacement entre sections
}

// ═══════════════════════════════════════════════════════════════
//  EXCEL HELPERS
// ═══════════════════════════════════════════════════════════════
const XL_GREEN = { argb: 'FF1B4332' }
const XL_WHITE = { argb: 'FFFFFFFF' }
const XL_ALT   = { argb: 'FFF2F6F2' }
const XL_TOT   = { argb: 'FFFEFCE8' }
const FCFA_FMT = '#,##0'

function xlHeader(ws, values, widths) {
  const row = ws.addRow(values)
  row.font = { bold: true, color: XL_WHITE, size: 10 }
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: XL_GREEN }
  row.alignment = { vertical: 'middle', wrapText: false }
  row.height = 22
  widths?.forEach((w, i) => { ws.getColumn(i + 1).width = w })
  return row
}

function xlData(ws, values, isAlt, fcfaCols = []) {
  const row = ws.addRow(values)
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: isAlt ? XL_ALT : { argb: 'FFFFFFFF' } }
  row.alignment = { vertical: 'middle' }
  row.height = 18
  fcfaCols.forEach(ci => { if (row.getCell(ci + 1)) row.getCell(ci + 1).numFmt = FCFA_FMT })
  return row
}

function xlTotal(ws, values, fcfaCols = []) {
  const row = ws.addRow(values)
  row.font = { bold: true, size: 10 }
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: XL_TOT }
  row.alignment = { vertical: 'middle' }
  row.height = 22
  row.border = { top: { style: 'thin', color: { argb: 'FFBBBBBB' } } }
  fcfaCols.forEach(ci => { if (row.getCell(ci + 1)) row.getCell(ci + 1).numFmt = FCFA_FMT })
  return row
}

function xlSheetHeader(ws, title, subtitle) {
  ws.addRow([title]).font = { bold: true, size: 13, color: XL_GREEN }
  if (subtitle) ws.addRow([subtitle]).font = { italic: true, size: 9, color: { argb: 'FF555555' } }
  ws.addRow([`Généré le ${nowStr()}`]).font = { size: 8, color: { argb: 'FF999999' } }
  ws.addRow([])
}

// ═══════════════════════════════════════════════════════════════
//  DATA HELPERS
// ═══════════════════════════════════════════════════════════════
async function getReunionData(id) {
  const [[reunion]] = await pool.query('SELECT * FROM reunions WHERE id = ?', [id])
  if (!reunion) return null

  const [tontines] = await pool.query(
    `SELECT id, nom, type, montant_par_part FROM tontines WHERE actif=1
     ORDER BY CASE WHEN type='PRESENCE' THEN 0 ELSE 1 END, montant_par_part`
  )
  const [cotT] = await pool.query(`
    SELECT ct.membre_id, ct.tontine_id, ct.parts_attendues, ct.parts_payees,
           ct.montant_paye, ct.est_echec, m.nom, m.prenom, t.montant_par_part
    FROM cotisations_tontine ct
    JOIN membres m ON m.id=ct.membre_id JOIN tontines t ON t.id=ct.tontine_id
    WHERE ct.reunion_id=?
  `, [id])
  const [cotR] = await pool.query(`
    SELECT cr.membre_id, cr.rubrique, cr.montant, m.nom, m.prenom
    FROM cotisations_rubrique cr JOIN membres m ON m.id=cr.membre_id WHERE cr.reunion_id=?
  `, [id])
  const rubTypes = [...new Set(cotR.map(r => r.rubrique))]

  let pretRembs = []
  try {
    const [rows] = await pool.query(`
      SELECT p.membre_id, m.nom, m.prenom, ep.montant_paye,
             COALESCE(ep.montant_du, ep.montant_total, 0) AS montant_attendu
      FROM echeances_pret ep JOIN prets p ON p.id=ep.pret_id
      JOIN membres m ON m.id=p.membre_id
      WHERE ep.reunion_id=? AND ep.montant_paye>0
    `, [id])
    pretRembs = rows
  } catch (_) {}

  const map = {}
  const ensure = (mid, nom, prenom) => {
    if (!map[mid]) map[mid] = { membre_id: mid, nom, prenom, tontines: {}, rubriques: {}, pret_remboursement: 0, total_attendu: 0, total_paye: 0 }
  }
  for (const ct of cotT) {
    ensure(ct.membre_id, ct.nom, ct.prenom)
    map[ct.membre_id].tontines[ct.tontine_id] = { parts_attendues: ct.parts_attendues, parts_payees: ct.parts_payees, montant_paye: Number(ct.montant_paye), est_echec: ct.est_echec === 1 }
    map[ct.membre_id].total_attendu += Number(ct.parts_attendues) * Number(ct.montant_par_part)
    map[ct.membre_id].total_paye    += Number(ct.montant_paye)
  }
  for (const cr of cotR) {
    ensure(cr.membre_id, cr.nom, cr.prenom)
    map[cr.membre_id].rubriques[cr.rubrique] = Number(cr.montant)
    map[cr.membre_id].total_paye += Number(cr.montant)
  }
  for (const ep of pretRembs) {
    ensure(ep.membre_id, ep.nom, ep.prenom)
    map[ep.membre_id].pret_remboursement += Number(ep.montant_paye)
    map[ep.membre_id].total_paye         += Number(ep.montant_paye)
    map[ep.membre_id].total_attendu      += Number(ep.montant_attendu)
  }
  const grille = Object.values(map).sort((a, b) => a.nom.localeCompare(b.nom))

  // Pot par tontine (calcul séparé pour éviter le double-comptage en multi-bénéficiaires)
  const [potRows] = await pool.query(
    `SELECT tontine_id, COALESCE(SUM(CASE WHEN est_echec=0 THEN montant_paye ELSE 0 END),0) AS pot
     FROM cotisations_tontine WHERE reunion_id=? GROUP BY tontine_id`, [id]
  )
  const potParTontine = Object.fromEntries(potRows.map(r => [r.tontine_id, Number(r.pot)]))

  const [benefsRows] = await pool.query(`
    SELECT b.id, b.tontine_id, b.membre_id, b.montant_membre,
           t.nom AS nom_tontine, t.type AS type_tontine, m.nom, m.prenom
    FROM beneficiaires b JOIN tontines t ON t.id=b.tontine_id
    LEFT JOIN membres m ON m.id=b.membre_id
    WHERE b.reunion_id=? AND b.membre_id IS NOT NULL
    ORDER BY b.tontine_id, b.id
  `, [id])
  const benefsByTontine = {}
  for (const b of benefsRows) (benefsByTontine[b.tontine_id] = benefsByTontine[b.tontine_id] || []).push(b)
  const beneficiaires = []
  for (const [tid, liste] of Object.entries(benefsByTontine)) {
    const parts = repartirEgal(potParTontine[tid] || 0, liste.length)
    liste.forEach((b, i) => beneficiaires.push({
      ...b,
      montant_recu: (b.montant_membre !== null && b.montant_membre !== undefined) ? Number(b.montant_membre) : parts[i]
    }))
  }

  let pretsOctroyes = []
  try {
    const [rows] = await pool.query(
      `SELECT p.id, p.montant_capital, m.nom, m.prenom FROM prets p
       JOIN membres m ON m.id=p.membre_id WHERE p.reunion_octroi_id=?`, [id]
    )
    for (const p of rows) {
      const [ech] = await pool.query(
        `SELECT numero, date_prevue, COALESCE(montant_du,montant_total,0) AS montant_du
         FROM echeances_pret WHERE pret_id=? ORDER BY numero`, [p.id]
      )
      p.echeances = ech
    }
    pretsOctroyes = rows
  } catch (_) {}

  let sanctions = []
  try {
    const [rows] = await pool.query(
      `SELECT s.type, s.montant, s.statut, s.description, m.nom, m.prenom
       FROM sanctions s JOIN membres m ON m.id=s.membre_id WHERE s.reunion_id=?`, [id]
    )
    sanctions = rows
  } catch (_) {}

  const [mouvs] = await pool.query(
    `SELECT type_mvt, categorie, SUM(montant) AS total FROM mouvements_caisse
     WHERE reunion_id=? GROUP BY type_mvt, categorie`, [id]
  )
  const totalEntrees = mouvs.filter(m => m.type_mvt === 'ENTREE').reduce((s, m) => s + Number(m.total), 0)
  const totalSorties = mouvs.filter(m => m.type_mvt === 'SORTIE').reduce((s, m) => s + Number(m.total), 0)

  let reliquat_precedent = 0
  try { reliquat_precedent = await reliquatPrecedent(pool, id) } catch (_) {}

  return {
    reunion, tontines, rubrique_types: rubTypes, grille, beneficiaires,
    prets_octroyes: pretsOctroyes, sanctions, reliquat_precedent,
    recap: { total_entrees: totalEntrees, total_sorties: totalSorties,
             rafraichissement: Number(reunion.montant_rafraichissement || 0),
             solde_net: totalEntrees - totalSorties, par_categorie: mouvs }
  }
}

async function getMembresData() {
  const [membres] = await pool.query(`
    SELECT m.id, m.nom, m.prenom, m.telephone, m.date_adhesion,
      COALESCE(sm.fond_caisse,0) AS fond_caisse, COALESCE(sm.fond_banque,0) AS fond_banque,
      COUNT(DISTINCT CASE WHEN ct.est_echec=1 THEN ct.id END) AS nb_echecs
    FROM membres m
    LEFT JOIN soldes_membres sm ON sm.membre_id=m.id
    LEFT JOIN cotisations_tontine ct ON ct.membre_id=m.id
    WHERE m.statut='ACTIF' GROUP BY m.id ORDER BY m.nom, m.prenom
  `)
  if (!membres.length) return []
  const ids = membres.map(m => m.id)
  const ph = ids.map(() => '?').join(',')

  const [sous] = await pool.query(
    `SELECT s.membre_id, s.nb_parts, t.nom AS nom_tontine, t.type
     FROM souscriptions s JOIN tontines t ON t.id=s.tontine_id
     WHERE s.membre_id IN (${ph}) AND s.statut='ACTIVE'`, ids
  )
  let prets = []
  try {
    const [rows] = await pool.query(
      `SELECT p.membre_id, p.montant_capital, p.statut,
        COALESCE(SUM(CASE WHEN ep.statut='PAYE' THEN ep.montant_paye ELSE 0 END),0) AS montant_rembourse,
        COUNT(CASE WHEN ep.statut NOT IN ('PAYE','REECHELONNE') THEN 1 END) AS nb_echeances_restantes
       FROM prets p LEFT JOIN echeances_pret ep ON ep.pret_id=p.id
       WHERE p.membre_id IN (${ph}) AND p.statut IN ('EN_COURS','EN_RETARD')
       GROUP BY p.id`, ids
    )
    prets = rows.map(p => ({ ...p, restant_du: Number(p.montant_capital) - Number(p.montant_rembourse) }))
  } catch (_) {}

  const sousByM  = sous.reduce((acc, s) => { (acc[s.membre_id] = acc[s.membre_id] || []).push(s); return acc }, {})
  const pretByM  = prets.reduce((acc, p) => ({ ...acc, [p.membre_id]: p }), {})
  return membres.map(m => ({ ...m, souscriptions: sousByM[m.id] || [], pret_en_cours: pretByM[m.id] || null }))
}

async function getBilanData(periode, mois, annee) {
  const yr = parseInt(annee) || new Date().getFullYear()
  let dateDebut, dateFin
  if (periode === 'mensuel') {
    const mo = parseInt(mois) || (new Date().getMonth() + 1)
    dateDebut = `${yr}-${String(mo).padStart(2, '0')}-01`
    dateFin   = `${yr}-${String(mo).padStart(2, '0')}-${new Date(yr, mo, 0).getDate()}`
  } else {
    dateDebut = `${yr}-01-01`; dateFin = `${yr}-12-31`
  }

  const [mouvs] = await pool.query(
    `SELECT type_mvt, categorie, SUM(montant) AS total, COUNT(*) AS nb
     FROM mouvements_caisse WHERE date_mvt BETWEEN ? AND ?
     GROUP BY type_mvt, categorie ORDER BY type_mvt, categorie`,
    [dateDebut, dateFin]
  )
  const entrees = mouvs.filter(m => m.type_mvt === 'ENTREE')
  const sorties = mouvs.filter(m => m.type_mvt === 'SORTIE')
  const [[{ tresorerie_ouverture }]] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type_mvt='ENTREE' THEN montant ELSE -montant END),0) AS tresorerie_ouverture
     FROM mouvements_caisse WHERE date_mvt < ?`, [dateDebut]
  )
  const [reunions] = await pool.query(
    `SELECT r.id, r.date_reunion, r.statut, r.total_collecte,
       COUNT(DISTINCT ct.id) AS nb_cotisations
     FROM reunions r LEFT JOIN cotisations_tontine ct ON ct.reunion_id=r.id
     WHERE r.date_reunion BETWEEN ? AND ? GROUP BY r.id ORDER BY r.date_reunion`,
    [dateDebut, dateFin]
  )
  const totalE = entrees.reduce((s, m) => s + Number(m.total), 0)
  const totalS = sorties.reduce((s, m) => s + Number(m.total), 0)
  return {
    periode: { type: periode, debut: dateDebut, fin: dateFin },
    entrees: { detail: entrees, total: totalE },
    sorties: { detail: sorties, total: totalS },
    solde_net: totalE - totalS,
    tresorerie_ouverture: Number(tresorerie_ouverture),
    tresorerie_cloture: Number(tresorerie_ouverture) + totalE - totalS,
    reunions
  }
}

async function getPretsData() {
  let actifs = [], retard = [], soldes = []
  let totalCirculation = 0, interetsEncaisses = 0
  try {
    const [rows] = await pool.query(`
      SELECT p.id, p.montant_capital, p.statut, p.date_debut, m.nom, m.prenom,
        COALESCE(SUM(CASE WHEN ep.statut='PAYE' THEN ep.montant_paye ELSE 0 END),0) AS montant_rembourse,
        COUNT(CASE WHEN ep.statut='PAYE' THEN 1 END) AS nb_echeances_payees,
        COUNT(ep.id) AS nb_echeances_total,
        COUNT(CASE WHEN ep.statut='EN_RETARD' THEN 1 END) AS nb_echeances_retard,
        COALESCE(SUM(CASE WHEN ep.statut='EN_RETARD' THEN ep.montant_interets ELSE 0 END),0) AS penalite_due
      FROM prets p JOIN membres m ON m.id=p.membre_id
      LEFT JOIN echeances_pret ep ON ep.pret_id=p.id
      WHERE p.statut IN ('EN_COURS','EN_RETARD')
      GROUP BY p.id, p.montant_capital, p.statut, p.date_debut, m.nom, m.prenom
      ORDER BY p.statut DESC, m.nom
    `)
    for (const p of rows) {
      p.restant_du = Number(p.montant_capital) - Number(p.montant_rembourse)
      totalCirculation += p.restant_du
      // Push d'abord, puis enrichir : si la requête d'échéance échoue le prêt
      // est quand même compté (évite le catch global qui vide actifs/retard).
      if (p.statut === 'EN_RETARD') retard.push(p); else actifs.push(p)
      try {
        const [[prochaine]] = await pool.query(
          `SELECT ep.montant_du, r.date_reunion AS date_prevue
           FROM echeances_pret ep
           LEFT JOIN reunions r ON r.id = ep.reunion_id
           WHERE ep.pret_id=? AND ep.statut NOT IN ('PAYE','REECHELONNE')
           ORDER BY ep.numero ASC LIMIT 1`, [p.id]
        )
        p.prochaine_echeance = prochaine || null
      } catch (_) { p.prochaine_echeance = null }
    }
    const annee = new Date().getFullYear()
    const [soldees] = await pool.query(
      `SELECT p.id, p.montant_capital, p.created_at, m.nom, m.prenom,
         COALESCE(SUM(ep.montant_paye),0) AS total_rembourse
       FROM prets p JOIN membres m ON m.id=p.membre_id
       LEFT JOIN echeances_pret ep ON ep.pret_id=p.id
       WHERE p.statut='REMBOURSE' AND YEAR(p.date_debut)=?
       GROUP BY p.id, p.montant_capital, p.date_debut, m.nom, m.prenom ORDER BY m.nom`, [annee]
    )
    for (const p of soldees) {
      p.interets = Math.max(0, Number(p.total_rembourse) - Number(p.montant_capital))
      interetsEncaisses += p.interets
      soldes.push(p)
    }
  } catch (_) {}
  return { actifs, retard, soldes, totaux: { capital_en_circulation: totalCirculation, interets_encaisses: interetsEncaisses, nb_prets_actifs: actifs.length, nb_prets_retard: retard.length } }
}

// ═══════════════════════════════════════════════════════════════
//  JSON ENDPOINTS
// ═══════════════════════════════════════════════════════════════
async function rapportReunion(req, res, next) {
  try {
    const data = await getReunionData(req.params.id)
    if (!data) return res.status(404).json({ success: false, message: 'Réunion introuvable' })
    res.json({ success: true, data })
  } catch (err) { next(err) }
}

async function rapportMembres(req, res, next) {
  try { res.json({ success: true, data: await getMembresData() }) } catch (err) { next(err) }
}

async function rapportBilan(req, res, next) {
  try {
    const { periode = 'mensuel', mois, annee } = req.query
    res.json({ success: true, data: await getBilanData(periode, mois, annee) })
  } catch (err) { next(err) }
}

async function rapportPrets(req, res, next) {
  try { res.json({ success: true, data: await getPretsData() }) } catch (err) { next(err) }
}

// ═══════════════════════════════════════════════════════════════
//  PDF ENDPOINTS
// ═══════════════════════════════════════════════════════════════
async function pdfReunion(req, res, next) {
  try {
    const data = await getReunionData(req.params.id)
    if (!data) return res.status(404).json({ success: false, message: 'Réunion introuvable' })
    const { reunion, tontines, rubrique_types, grille, beneficiaires, prets_octroyes, sanctions, recap } = data
    const dateLabel = fmtDate(reunion.date_reunion)
    const doc = makePDF(res, `reunion-${req.params.id}.pdf`,
      `Rapport de Réunion — ${dateLabel}`, `Statut : ${reunion.statut} · Total collecté : ${formatFCFA(reunion.total_collecte)}`)

    // Grille cotisations
    const headers = ['Membre', ...tontines.map(t => t.nom), ...rubrique_types.map(r => r === 'FONDS_CAISSE' ? 'F. Caisse' : r === 'BANQUE' ? 'Banque' : r), 'Prêt', 'Total payé', 'Écart']
    const baseColW = [130, ...tontines.map(() => 85), ...rubrique_types.map(() => 65), 65, 75, 75]
    const rows = grille.map(m => [
      `${m.prenom} ${m.nom}`,
      ...tontines.map(t => m.tontines[t.id] ? formatFCFA(m.tontines[t.id].montant_paye) : '—'),
      ...rubrique_types.map(r => m.rubriques[r] ? formatFCFA(m.rubriques[r]) : '—'),
      m.pret_remboursement ? formatFCFA(m.pret_remboursement) : '—',
      formatFCFA(m.total_paye),
      (m.total_paye - m.total_attendu >= 0 ? '+' : '') + formatFCFA(m.total_paye - m.total_attendu)
    ])
    const totRow = [
      'TOTAL',
      ...tontines.map(t => formatFCFA(grille.reduce((s, m) => s + (m.tontines[t.id]?.montant_paye || 0), 0))),
      ...rubrique_types.map(r => formatFCFA(grille.reduce((s, m) => s + (m.rubriques[r] || 0), 0))),
      formatFCFA(grille.reduce((s, m) => s + m.pret_remboursement, 0)),
      formatFCFA(grille.reduce((s, m) => s + m.total_paye, 0)),
      ''
    ]
    drawTable(doc, { title: 'Grille des cotisations', headers, rows, colWidths: baseColW, footerRow: totRow })

    // Bénéficiaires
    if (beneficiaires.length) {
      drawTable(doc, {
        title: 'Bénéficiaires de la séance',
        headers: ['Tontine', 'Bénéficiaire', 'Montant reçu (FCFA)'],
        rows: beneficiaires.map(b => [b.nom_tontine, `${b.prenom} ${b.nom}`, formatFCFA(b.montant_recu)]),
        colWidths: [220, 220, 160],
        footerRow: ['', 'Total', formatFCFA(beneficiaires.reduce((s, b) => s + b.montant_recu, 0))]
      })
    }

    // Prêts octroyés
    if (prets_octroyes.length) {
      drawTable(doc, {
        title: 'Prêts octroyés',
        headers: ['Bénéficiaire', 'Capital (FCFA)', 'Nb échéances'],
        rows: prets_octroyes.map(p => [`${p.prenom} ${p.nom}`, formatFCFA(p.montant_capital), p.echeances?.length || 0]),
        colWidths: [280, 200, 120],
      })
    }

    // Sanctions
    if (sanctions.length) {
      drawTable(doc, {
        title: 'Sanctions',
        headers: ['Membre', 'Type', 'Montant (FCFA)', 'Statut'],
        rows: sanctions.map(s => [`${s.prenom} ${s.nom}`, s.type, formatFCFA(s.montant), s.statut]),
        colWidths: [200, 130, 140, 100],
      })
    }

    // Récapitulatif
    drawTable(doc, {
      title: 'Récapitulatif financier',
      headers: ['Type', 'Catégorie', 'Montant (FCFA)'],
      rows: recap.par_categorie.map(m => [m.type_mvt, CAT_LABELS[m.categorie] || m.categorie, formatFCFA(m.total)]),
      colWidths: [100, 280, 190],
      footerRow: ['', 'Solde net', (recap.solde_net >= 0 ? '+' : '') + formatFCFA(recap.solde_net)]
    })

    finalizePDF(doc)
  } catch (err) { next(err) }
}

async function pdfMembres(req, res, next) {
  try {
    const data = await getMembresData()
    const doc = makePDF(res, 'membres.pdf', 'Situation des Membres', `${data.length} membres actifs — ${fmtDate(new Date())}`, 'portrait')
    drawTable(doc, {
      headers: ['Membre', 'Téléphone', 'F. Caisse', 'F. Banque', 'Échecs', 'Souscriptions actives', 'Prêt', 'Restant dû', 'Éch. rest.'],
      rows: data.map(m => [
        `${m.prenom} ${m.nom}`, m.telephone || '—',
        formatFCFA(m.fond_caisse), formatFCFA(m.fond_banque), m.nb_echecs,
        m.souscriptions.map(s => `${s.nom_tontine} (${s.nb_parts}p)`).join(', ') || '—',
        m.pret_en_cours ? m.pret_en_cours.statut : '—',
        m.pret_en_cours ? formatFCFA(m.pret_en_cours.restant_du) : '—',
        m.pret_en_cours ? m.pret_en_cours.nb_echeances_restantes : '—'
      ]),
      colWidths: [120, 85, 75, 75, 48, 155, 80, 75, 55],
    })
    finalizePDF(doc)
  } catch (err) { next(err) }
}

async function pdfBilan(req, res, next) {
  try {
    const { periode = 'mensuel', mois, annee } = req.query
    const data = await getBilanData(periode, mois, annee)
    const subtitle = `${data.periode.debut} au ${data.periode.fin} · Trésorerie : ${formatFCFA(data.tresorerie_cloture)}`
    const doc = makePDF(res, 'bilan.pdf', 'Bilan Financier', subtitle, 'portrait')

    drawTable(doc, {
      title: 'Entrées',
      headers: ['Catégorie', 'Nb opérations', 'Total (FCFA)'],
      rows: data.entrees.detail.map(m => [CAT_LABELS[m.categorie] || m.categorie, m.nb, formatFCFA(m.total)]),
      colWidths: [280, 80, 155],
      footerRow: ['Total entrées', '', formatFCFA(data.entrees.total)]
    })
    drawTable(doc, {
      title: 'Sorties',
      headers: ['Catégorie', 'Nb opérations', 'Total (FCFA)'],
      rows: data.sorties.detail.map(m => [CAT_LABELS[m.categorie] || m.categorie, m.nb, formatFCFA(m.total)]),
      colWidths: [280, 80, 155],
      footerRow: ['Total sorties', '', formatFCFA(data.sorties.total)]
    })
    drawTable(doc, {
      title: `${data.reunions.length} réunion(s) sur la période`,
      headers: ['Date', 'Statut', 'Cotisations', 'Total collecté (FCFA)'],
      rows: data.reunions.map(r => [fmtDate(r.date_reunion), r.statut, r.nb_cotisations, formatFCFA(r.total_collecte)]),
      colWidths: [100, 80, 80, 175],
    })
    finalizePDF(doc)
  } catch (err) { next(err) }
}

async function pdfPrets(req, res, next) {
  try {
    const data = await getPretsData()
    const doc = makePDF(res, 'prets.pdf', 'Suivi des Prêts',
      `Capital en circulation : ${formatFCFA(data.totaux.capital_en_circulation)} · ${data.actifs.length + data.retard.length} prêt(s) actif(s)`,
      'portrait')

    if (data.actifs.length) {
      drawTable(doc, {
        title: `Prêts en cours (${data.actifs.length})`,
        headers: ['Membre', 'Capital', 'Remboursé', 'Restant dû', 'Éch.', 'Prochaine échéance', 'Montant'],
        rows: data.actifs.map(p => [
          `${p.prenom} ${p.nom}`, formatFCFA(p.montant_capital), formatFCFA(p.montant_rembourse),
          formatFCFA(p.restant_du), `${p.nb_echeances_payees}/${p.nb_echeances_total}`,
          p.prochaine_echeance ? fmtDate(p.prochaine_echeance.date_prevue) : '—',
          p.prochaine_echeance ? formatFCFA(p.prochaine_echeance.montant_du) : '—'
        ]),
        colWidths: [130, 90, 90, 90, 60, 120, 90],
        footerRow: ['Total', formatFCFA(data.actifs.reduce((s, p) => s + Number(p.montant_capital), 0)), '', formatFCFA(data.actifs.reduce((s, p) => s + p.restant_du, 0)), '', '', '']
      })
    }
    if (data.retard.length) {
      drawTable(doc, {
        title: `Prêts en retard (${data.retard.length})`,
        headers: ['Membre', 'Capital', 'Restant dû', 'Éch. en retard', 'Pénalités dues'],
        rows: data.retard.map(p => [`${p.prenom} ${p.nom}`, formatFCFA(p.montant_capital), formatFCFA(p.restant_du), p.nb_echeances_retard, formatFCFA(p.penalite_due)]),
        colWidths: [200, 130, 130, 120, 130],
      })
    }
    if (data.soldes.length) {
      drawTable(doc, {
        title: `Prêts soldés cette année (${data.soldes.length})`,
        headers: ['Membre', 'Capital', 'Total remboursé', 'Intérêts', 'Octroyé le'],
        rows: data.soldes.map(p => [`${p.prenom} ${p.nom}`, formatFCFA(p.montant_capital), formatFCFA(p.total_rembourse), p.interets > 0 ? `+${formatFCFA(p.interets)}` : '—', fmtDate(p.date_debut)]),
        colWidths: [180, 120, 130, 120, 110],
        footerRow: ['Total', formatFCFA(data.soldes.reduce((s, p) => s + Number(p.montant_capital), 0)), formatFCFA(data.soldes.reduce((s, p) => s + Number(p.total_rembourse), 0)), formatFCFA(data.totaux.interets_encaisses), '']
      })
    }
    if (!data.actifs.length && !data.retard.length && !data.soldes.length) {
      doc.fillColor('#888').font('Helvetica').fontSize(11)
        .text('Aucun prêt enregistré.', PDF_ML, doc.y + 16, { lineGap: 0, paragraphGap: 0 })
    }
    finalizePDF(doc)
  } catch (err) { next(err) }
}

// ── Bureau exécutif (PDF / Excel) ──────────────────────────────
async function getBureauData() {
  try {
    const [[mandat]] = await pool.query("SELECT * FROM bureau_mandats WHERE statut='EN_COURS' ORDER BY numero DESC LIMIT 1")
    if (!mandat) return null
    const [postes] = await pool.query(`
      SELECT bp.poste, bp.role, m.nom, m.prenom
      FROM bureau_postes bp JOIN membres m ON m.id = bp.membre_id
      WHERE bp.mandat_id = ?
      ORDER BY FIELD(bp.role,'TITULAIRE','ADJOINT'), m.nom, m.prenom
    `, [mandat.id])
    const [defs] = await pool.query('SELECT code, label, ordre, a_adjoint, multiple FROM bureau_postes_def WHERE actif=1 ORDER BY ordre, label')
    return { mandat, postes, defs: defs.map(d => ({ ...d, a_adjoint: !!d.a_adjoint, multiple: !!d.multiple })) }
  } catch (_) { return null }
}

const bureauSub = m => `Mandat n°${m.numero}${m.est_renouvellement ? ' (reconduction)' : ''} · du ${fmtDate(m.date_debut)} au ${fmtDate(m.date_fin)}`

async function pdfBureau(req, res, next) {
  try {
    const data = await getBureauData()
    const doc = makePDF(res, 'bureau.pdf', 'Bureau exécutif', data ? bureauSub(data.mandat) : '', 'portrait')

    if (!data) {
      doc.fillColor('#888').font('Helvetica').fontSize(11)
        .text('Aucun bureau en cours.', PDF_ML, doc.y + 16, { lineGap: 0, paragraphGap: 0 })
      return finalizePDF(doc)
    }

    const find = (code, role) => {
      const c = data.postes.find(x => x.poste === code && x.role === role)
      return c ? `${c.prenom} ${c.nom}` : '—'
    }
    drawTable(doc, {
      title: 'Composition du bureau',
      headers: ['Poste', 'Titulaire', 'Adjoint'],
      rows: data.defs.filter(d => !d.multiple).map(d => [d.label, find(d.code, 'TITULAIRE'), d.a_adjoint ? find(d.code, 'ADJOINT') : '—']),
      colWidths: [180, 170, 170],
    })

    for (const d of data.defs.filter(x => x.multiple)) {
      const list = data.postes.filter(p => p.poste === d.code).map(c => `${c.prenom} ${c.nom}`)
      drawTable(doc, {
        title: `${d.label}s (${list.length})`,
        headers: ['#', d.label],
        rows: list.length ? list.map((n, i) => [i + 1, n]) : [['—', 'Aucun désigné']],
        colWidths: [50, 300],
      })
    }

    if (data.mandat.observations) {
      doc.fillColor('#444').font('Helvetica-Oblique').fontSize(9)
        .text(`Observations : ${data.mandat.observations}`, PDF_ML, doc.y + 8, { width: doc.page.width - PDF_ML * 2, lineGap: 0 })
    }

    finalizePDF(doc)
  } catch (err) { next(err) }
}

async function excelBureau(req, res, next) {
  try {
    const data = await getBureauData()
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Bureau exécutif')

    if (!data) {
      xlSheetHeader(ws, 'Bureau exécutif', 'Aucun bureau en cours')
    } else {
      xlSheetHeader(ws, 'Bureau exécutif', bureauSub(data.mandat))
      xlHeader(ws, ['Poste', 'Titulaire', 'Adjoint'], [28, 26, 26])
      const find = (code, role) => {
        const c = data.postes.find(x => x.poste === code && x.role === role)
        return c ? `${c.prenom} ${c.nom}` : '—'
      }
      data.defs.filter(d => !d.multiple).forEach((d, i) =>
        xlData(ws, [d.label, find(d.code, 'TITULAIRE'), d.a_adjoint ? find(d.code, 'ADJOINT') : '—'], i % 2 === 1))

      for (const d of data.defs.filter(x => x.multiple)) {
        const list = data.postes.filter(p => p.poste === d.code)
        ws.addRow([])
        const head = ws.addRow([`${d.label}s (${list.length})`]); head.font = { bold: true, size: 11, color: XL_GREEN }
        list.forEach((c, i) => xlData(ws, [`${c.prenom} ${c.nom}`], i % 2 === 1))
      }
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="bureau.xlsx"')
    await wb.xlsx.write(res); res.end()
  } catch (err) { next(err) }
}

// ═══════════════════════════════════════════════════════════════
//  EXCEL ENDPOINTS
// ═══════════════════════════════════════════════════════════════
async function excelReunion(req, res, next) {
  try {
    const data = await getReunionData(req.params.id)
    if (!data) return res.status(404).json({ success: false, message: 'Réunion introuvable' })
    const { reunion, tontines, rubrique_types, grille, beneficiaires, sanctions, recap } = data
    const wb = new ExcelJS.Workbook()
    const dateLabel = fmtDate(reunion.date_reunion)

    // Feuille 1 : Grille
    const ws1 = wb.addWorksheet('Grille cotisations')
    xlSheetHeader(ws1, `Rapport de réunion — ${dateLabel}`, `Statut : ${reunion.statut}`)
    const hCols = ['Membre', ...tontines.map(t => t.nom), ...rubrique_types, 'Prêt', 'Total payé', 'Écart']
    const colW  = [22, ...tontines.map(() => 16), ...rubrique_types.map(() => 14), 12, 14, 14]
    xlHeader(ws1, hCols, colW)
    const fcfaCols = [...tontines.map((_, i) => i + 1), ...rubrique_types.map((_, i) => tontines.length + i + 1), tontines.length + rubrique_types.length + 1, tontines.length + rubrique_types.length + 2]
    grille.forEach((m, ri) => {
      xlData(ws1, [
        `${m.prenom} ${m.nom}`,
        ...tontines.map(t => m.tontines[t.id]?.montant_paye ?? 0),
        ...rubrique_types.map(r => m.rubriques[r] ?? 0),
        m.pret_remboursement,
        m.total_paye,
        m.total_paye - m.total_attendu
      ], ri % 2 === 1, fcfaCols)
    })
    xlTotal(ws1, ['TOTAL', ...tontines.map(t => grille.reduce((s, m) => s + (m.tontines[t.id]?.montant_paye || 0), 0)), ...rubrique_types.map(r => grille.reduce((s, m) => s + (m.rubriques[r] || 0), 0)), grille.reduce((s, m) => s + m.pret_remboursement, 0), grille.reduce((s, m) => s + m.total_paye, 0), ''], fcfaCols)

    // Feuille 2 : Bénéficiaires
    if (beneficiaires.length) {
      const ws2 = wb.addWorksheet('Bénéficiaires')
      xlSheetHeader(ws2, `Bénéficiaires — ${dateLabel}`)
      xlHeader(ws2, ['Tontine', 'Bénéficiaire', 'Montant reçu (FCFA)'], [25, 25, 20])
      beneficiaires.forEach((b, ri) => xlData(ws2, [b.nom_tontine, `${b.prenom} ${b.nom}`, Number(b.montant_recu)], ri % 2 === 1, [2]))
      xlTotal(ws2, ['', 'Total', beneficiaires.reduce((s, b) => s + b.montant_recu, 0)], [2])
    }

    // Feuille 3 : Récapitulatif
    const ws3 = wb.addWorksheet('Récapitulatif')
    xlSheetHeader(ws3, `Récapitulatif financier — ${dateLabel}`)
    xlHeader(ws3, ['Type', 'Catégorie', 'Montant (FCFA)'], [12, 30, 20])
    recap.par_categorie.forEach((m, ri) => xlData(ws3, [m.type_mvt, CAT_LABELS[m.categorie] || m.categorie, Number(m.total)], ri % 2 === 1, [2]))
    xlTotal(ws3, ['', 'Solde net', recap.solde_net], [2])

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="reunion-${req.params.id}.xlsx"`)
    await wb.xlsx.write(res); res.end()
  } catch (err) { next(err) }
}

async function excelMembres(req, res, next) {
  try {
    const data = await getMembresData()
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Situation membres')
    xlSheetHeader(ws, 'Situation des Membres', `${data.length} membres actifs`)
    xlHeader(ws, ['Membre', 'Téléphone', 'F. Caisse', 'F. Banque', 'Nb échecs', 'Souscriptions actives', 'Statut prêt', 'Restant dû', 'Éch. restantes'],
      [22, 14, 13, 13, 11, 30, 13, 14, 13])
    data.forEach((m, ri) => {
      xlData(ws, [
        `${m.prenom} ${m.nom}`, m.telephone || '',
        Number(m.fond_caisse), Number(m.fond_banque), m.nb_echecs,
        m.souscriptions.map(s => `${s.nom_tontine} (${s.nb_parts}p)`).join(', ') || '—',
        m.pret_en_cours?.statut || '—',
        m.pret_en_cours ? m.pret_en_cours.restant_du : '',
        m.pret_en_cours ? m.pret_en_cours.nb_echeances_restantes : ''
      ], ri % 2 === 1, [2, 3, 7])
    })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="membres.xlsx"')
    await wb.xlsx.write(res); res.end()
  } catch (err) { next(err) }
}

async function excelBilan(req, res, next) {
  try {
    const { periode = 'mensuel', mois, annee } = req.query
    const data = await getBilanData(periode, mois, annee)
    const wb = new ExcelJS.Workbook()

    const wsE = wb.addWorksheet('Entrées')
    xlSheetHeader(wsE, 'Entrées', `${data.periode.debut} au ${data.periode.fin}`)
    xlHeader(wsE, ['Catégorie', 'Nb opérations', 'Total (FCFA)'], [30, 15, 20])
    data.entrees.detail.forEach((m, ri) => xlData(wsE, [CAT_LABELS[m.categorie] || m.categorie, m.nb, Number(m.total)], ri % 2 === 1, [2]))
    xlTotal(wsE, ['Total entrées', '', data.entrees.total], [2])

    const wsS = wb.addWorksheet('Sorties')
    xlSheetHeader(wsS, 'Sorties', `${data.periode.debut} au ${data.periode.fin}`)
    xlHeader(wsS, ['Catégorie', 'Nb opérations', 'Total (FCFA)'], [30, 15, 20])
    data.sorties.detail.forEach((m, ri) => xlData(wsS, [CAT_LABELS[m.categorie] || m.categorie, m.nb, Number(m.total)], ri % 2 === 1, [2]))
    xlTotal(wsS, ['Total sorties', '', data.sorties.total], [2])

    const wsR = wb.addWorksheet('Réunions')
    xlSheetHeader(wsR, 'Réunions de la période')
    xlHeader(wsR, ['Date', 'Statut', 'Nb cotisations', 'Total collecté (FCFA)'], [14, 12, 15, 22])
    data.reunions.forEach((r, ri) => xlData(wsR, [fmtDate(r.date_reunion), r.statut, r.nb_cotisations, Number(r.total_collecte)], ri % 2 === 1, [3]))
    xlTotal(wsR, ['', '', '', data.reunions.reduce((s, r) => s + Number(r.total_collecte), 0)], [3])

    const wsSyn = wb.addWorksheet('Synthèse')
    xlSheetHeader(wsSyn, 'Synthèse', `${data.periode.debut} au ${data.periode.fin}`)
    xlHeader(wsSyn, ['Indicateur', 'Montant (FCFA)'], [28, 20])
    ;[
      ['Trésorerie ouverture', data.tresorerie_ouverture],
      ['Total entrées', data.entrees.total],
      ['Total sorties', data.sorties.total],
      ['Solde net', data.solde_net],
      ['Trésorerie clôture', data.tresorerie_cloture]
    ].forEach(([label, val], ri) => xlData(wsSyn, [label, Number(val)], ri % 2 === 1, [1]))

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="bilan-${data.periode.debut}.xlsx"`)
    await wb.xlsx.write(res); res.end()
  } catch (err) { next(err) }
}

async function excelPrets(req, res, next) {
  try {
    const data = await getPretsData()
    const wb = new ExcelJS.Workbook()

    if (data.actifs.length) {
      const ws = wb.addWorksheet('Prêts en cours')
      xlSheetHeader(ws, 'Prêts en cours')
      xlHeader(ws, ['Membre', 'Capital', 'Remboursé', 'Restant dû', 'Éch. payées', 'Prochaine échéance', 'Montant'], [22, 14, 14, 14, 11, 18, 14])
      data.actifs.forEach((p, ri) => xlData(ws, [
        `${p.prenom} ${p.nom}`, Number(p.montant_capital), Number(p.montant_rembourse), p.restant_du,
        `${p.nb_echeances_payees}/${p.nb_echeances_total}`,
        p.prochaine_echeance ? fmtDate(p.prochaine_echeance.date_prevue) : '—',
        p.prochaine_echeance ? Number(p.prochaine_echeance.montant_du) : ''
      ], ri % 2 === 1, [1, 2, 3, 6]))
      xlTotal(ws, ['TOTAL', data.actifs.reduce((s, p) => s + Number(p.montant_capital), 0), '', data.actifs.reduce((s, p) => s + p.restant_du, 0), '', '', ''], [1, 3])
    }

    if (data.retard.length) {
      const ws = wb.addWorksheet('En retard')
      xlSheetHeader(ws, 'Prêts en retard')
      xlHeader(ws, ['Membre', 'Capital', 'Restant dû', 'Éch. en retard', 'Pénalités dues'], [22, 14, 14, 14, 14])
      data.retard.forEach((p, ri) => xlData(ws, [`${p.prenom} ${p.nom}`, Number(p.montant_capital), p.restant_du, p.nb_echeances_retard, Number(p.penalite_due)], ri % 2 === 1, [1, 2, 4]))
    }

    if (data.soldes.length) {
      const ws = wb.addWorksheet('Soldés cette année')
      xlSheetHeader(ws, 'Prêts soldés')
      xlHeader(ws, ['Membre', 'Capital', 'Total remboursé', 'Intérêts', 'Octroyé le'], [22, 14, 18, 14, 14])
      data.soldes.forEach((p, ri) => xlData(ws, [`${p.prenom} ${p.nom}`, Number(p.montant_capital), Number(p.total_rembourse), p.interets, fmtDate(p.date_debut)], ri % 2 === 1, [1, 2, 3]))
      xlTotal(ws, ['Total', data.soldes.reduce((s, p) => s + Number(p.montant_capital), 0), data.soldes.reduce((s, p) => s + Number(p.total_rembourse), 0), data.totaux.interets_encaisses, ''], [1, 2, 3])
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="prets.xlsx"')
    await wb.xlsx.write(res); res.end()
  } catch (err) { next(err) }
}

module.exports = {
  rapportReunion, rapportMembres, rapportBilan, rapportPrets,
  pdfReunion, pdfMembres, pdfBilan, pdfPrets, pdfBureau,
  excelReunion, excelMembres, excelBilan, excelPrets, excelBureau
}
