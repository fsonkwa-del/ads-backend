// Calcul chronologique du reliquat des fonds disponibles pour les prêts.
//
// Pour chaque réunion i (ordre date_reunion ASC, id ASC) :
//   disponible_initial[i] = reliquat[i-1] + banque[i] + remboursé[i]
//   reliquat[i]           = disponible_initial[i] - prêté[i]
// La chaîne n'avance que sur les réunions VALIDÉES ; le reliquat de la dernière
// validée est reporté sur la suivante (brouillon ou future).
//
// Renvoie la liste des réunions enrichies de :
//   { banque, rembourse, prete, reliquat_precedent, disponible_initial, reliquat }
async function computeReliquats(db) {
  let rows = []
  try {
    const [r] = await db.query(`
      SELECT r.id, r.date_reunion, r.statut,
        COALESCE(b.banque, 0)     AS banque,
        COALESCE(rb.rembourse, 0) AS rembourse,
        COALESCE(pr.prete, 0)     AS prete
      FROM reunions r
      LEFT JOIN (SELECT reunion_id, SUM(montant) AS banque
                 FROM cotisations_rubrique WHERE rubrique='BANQUE' GROUP BY reunion_id) b ON b.reunion_id = r.id
      LEFT JOIN (SELECT reunion_id, SUM(montant_paye) AS rembourse
                 FROM echeances_pret GROUP BY reunion_id) rb ON rb.reunion_id = r.id
      LEFT JOIN (SELECT reunion_octroi_id, SUM(montant_capital) AS prete
                 FROM prets WHERE reunion_octroi_id IS NOT NULL GROUP BY reunion_octroi_id) pr ON pr.reunion_octroi_id = r.id
      ORDER BY r.date_reunion ASC, r.id ASC
    `)
    rows = r
  } catch (_) {
    // Repli si echeances_pret / prets absents (migrations prêts non appliquées)
    const [r] = await db.query(`
      SELECT r.id, r.date_reunion, r.statut, COALESCE(b.banque, 0) AS banque, 0 AS rembourse, 0 AS prete
      FROM reunions r
      LEFT JOIN (SELECT reunion_id, SUM(montant) AS banque
                 FROM cotisations_rubrique WHERE rubrique='BANQUE' GROUP BY reunion_id) b ON b.reunion_id = r.id
      ORDER BY r.date_reunion ASC, r.id ASC
    `)
    rows = r
  }

  let reliquat = 0
  for (const row of rows) {
    row.banque    = Number(row.banque)
    row.rembourse = Number(row.rembourse)
    row.prete     = Number(row.prete)
    row.reliquat_precedent = reliquat
    row.disponible_initial = reliquat + row.banque + row.rembourse
    row.reliquat           = row.disponible_initial - row.prete
    if (row.statut === 'VALIDEE') reliquat = row.reliquat   // seules les validées font avancer la chaîne
  }
  return rows
}

// Reliquat reporté sur la réunion `reunionId` (= reliquat des validées précédentes)
async function reliquatPrecedent(db, reunionId) {
  const chain = await computeReliquats(db)
  const me = chain.find(r => String(r.id) === String(reunionId))
  return me ? me.reliquat_precedent : 0
}

// Disponible prêts à préparer : disponible du brouillon en cours, sinon reliquat de la dernière validée
async function disponiblePrets(db) {
  const chain = await computeReliquats(db)
  const brouillon = chain.find(r => r.statut === 'BROUILLON')
  if (brouillon) return brouillon.disponible_initial
  const validees = chain.filter(r => r.statut === 'VALIDEE')
  return validees.length ? validees[validees.length - 1].reliquat : 0
}

module.exports = { computeReliquats, reliquatPrecedent, disponiblePrets }
