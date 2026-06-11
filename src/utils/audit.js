// Journalisation centralisée des actions critiques dans `journaux_audit`.
// Tolérant aux pannes : un échec d'audit ne doit jamais casser l'action métier.
async function logAudit(db, { utilisateur_id, action, table_cible, id_cible, details, ip_adresse }) {
  try {
    await db.query(
      'INSERT INTO journaux_audit (utilisateur_id, action, table_cible, id_cible, details, ip_adresse) VALUES (?, ?, ?, ?, ?, ?)',
      [
        utilisateur_id || null,
        action,
        table_cible,
        id_cible || 0,
        details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)),
        ip_adresse || null,
      ]
    )
  } catch (_) { /* table absente (migration phase 7 non appliquée) ou erreur audit — on n'interrompt pas l'action */ }
}

module.exports = { logAudit }
