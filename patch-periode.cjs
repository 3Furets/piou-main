const fs   = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "ximi-assistant", "extracteurs", "ximi_scraper.js");
const contenu = fs.readFileSync(TARGET, "utf8");

// Reperer et remplacer getPeriodRange
const debut = contenu.indexOf("function getPeriodRange(");
const fin   = contenu.indexOf("function buildBody(");

if (debut === -1 || fin === -1) {
  console.error("Reperes non trouves debut=" + debut + " fin=" + fin);
  process.exit(1);
}

const avant = contenu.slice(0, debut);
const apres = contenu.slice(fin);

const nouvelleFn = [
  `function getPeriodRange(type, param) {`,
  `  if (type === 'planning_jour') {`,
  `    // Decalage Europe/Paris : minuit Paris en UTC`,
  `    const start = parisMidnight(param);`,
  `    return { start, end: start + 86400000 };`,
  `  }`,
  `  if (type === 'planning_mois') {`,
  `    // UTC pur pour eviter les problemes de passage heure ete/hiver`,
  `    // sur les longues periodes (decalage 30 vs 31 jours)`,
  `    const [annee, mois] = param.split('-').map(Number);`,
  `    // Premier jour du mois a minuit UTC`,
  `    const start = Date.UTC(annee, mois - 1, 1, 0, 0, 0);`,
  `    // Premier jour du mois suivant a minuit UTC`,
  `    const moisSuiv = mois === 12 ? 1 : mois + 1;`,
  `    const anneeSuiv = mois === 12 ? annee + 1 : annee;`,
  `    const end = Date.UTC(anneeSuiv, moisSuiv - 1, 1, 0, 0, 0);`,
  `    log('Mois UTC : ' + new Date(start).toISOString() + ' -> ' + new Date(end).toISOString());`,
  `    log('Duree    : ' + ((end - start) / 86400000) + ' jours');`,
  `    return { start, end };`,
  `  }`,
  `  // Fallback : traite comme jour`,
  `  const start = parisMidnight(param);`,
  `  return { start, end: start + 86400000 };`,
  `}`,
  ``,
].join('\n');

const nouveau = avant + nouvelleFn + apres;

fs.copyFileSync(TARGET, TARGET + ".bak5");
console.log("Backup : " + TARGET + ".bak5");
fs.writeFileSync(TARGET, nouveau, "utf8");
console.log("OK - getPeriodRange mis a jour");

// Verification
if (nouveau.includes("Date.UTC(annee, mois - 1, 1, 0, 0, 0)")) {
  console.log("OK - UTC pur pour planning_mois present");
} else {
  console.error("ERREUR - patch non applique !");
}
