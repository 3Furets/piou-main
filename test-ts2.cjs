const fs = require("fs");

function parisMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDate   = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const localStr  = utcDate.toLocaleString('sv-SE', { timeZone: 'Europe/Paris' });
  const localDate = new Date(localStr + 'Z');
  return Date.UTC(y, m - 1, d, 0, 0, 0) + (utcDate - localDate);
}

// Test tous les cas
const cas = [
  ['2026-09-01', '2026-10-01'],
  ['2026-10-01', '2026-11-01'],
  ['2026-12-01', '2027-01-01'],
];

for (const [debut, fin] of cas) {
  const s = parisMidnight(debut);
  const e = parisMidnight(fin);
  console.log(`${debut} -> ${new Date(s).toISOString()} (${s})`);
  console.log(`${fin}   -> ${new Date(e).toISOString()} (${e})`);
  console.log(`Duree : ${(e-s)/86400000} jours`);
  console.log('---');
}

// Tester le body GetData avec ces valeurs
// Le planning_jour 2026-09-16 fonctionne avec :
// Start: 2026-09-15T22:00:00.000Z End: 2026-09-16T22:00:00.000Z
// Donc l API accepte bien le decalage Paris

// Pour le mois, tester aussi UTC pur
const startUTC = Date.UTC(2026, 8, 1, 0, 0, 0);  // 2026-09-01T00:00Z
const endUTC   = Date.UTC(2026, 9, 1, 0, 0, 0);  // 2026-10-01T00:00Z
console.log("UTC pur start :", new Date(startUTC).toISOString(), startUTC);
console.log("UTC pur end   :", new Date(endUTC).toISOString(),   endUTC);
