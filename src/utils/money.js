// Arrondi FCFA : plus petite pièce = 5 FCFA
// reste >= 3 → 5 supérieur, reste <= 2 → 5 inférieur
function arrondirFCFA(montant) {
  const entier = Math.trunc(montant)
  const reste  = entier % 5
  if (reste === 0) return entier
  return reste >= 3 ? entier + (5 - reste) : entier - reste
}

module.exports = { arrondirFCFA }
