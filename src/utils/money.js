// Arrondi FCFA : plus petite pièce = 5 FCFA
// reste >= 3 → 5 supérieur, reste <= 2 → 5 inférieur
function arrondirFCFA(montant) {
  const entier = Math.trunc(montant)
  const reste  = entier % 5
  if (reste === 0) return entier
  return reste >= 3 ? entier + (5 - reste) : entier - reste
}

// Répartit un montant entier `total` en `n` parts entières (somme exacte = total).
// Les parts diffèrent d'au plus 1 FCFA ; le reliquat va aux premières parts.
function repartirEgal(total, n) {
  if (!n || n <= 0) return []
  const t = Math.round(Number(total) || 0)
  const base = Math.floor(t / n)
  let reste = t - base * n
  const parts = []
  for (let i = 0; i < n; i++) {
    parts.push(base + (reste > 0 ? 1 : 0))
    if (reste > 0) reste--
  }
  return parts
}

module.exports = { arrondirFCFA, repartirEgal }
