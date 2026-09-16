import { chromium } from 'playwright';
import { readJSONEnc, loadEnv } from '../../secure/vault.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '../../');
const SESSION_FILE   = path.join(ROOT, 'ximi-session.json.enc');
const ENV_FILE       = path.join(ROOT, '.env');
const SORTIE_DEFAULT = path.join(ROOT, 'ximi-assistant', 'rapports', 'extraction_temp.json');
const API_BASE       = 'https://app.ximi.xelya.io/Ximi2/api/Scheduler';
const SCHEDULER_URL  = 'https://app.ximi.xelya.io/Ximi2/Scheduler';

function log(msg) { process.stderr.write('[' + new Date().toLocaleTimeString('fr-FR') + '] ' + msg + '\n'); }

function sauvegarder(data, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  log('Sauvegarde : ' + filePath);
}

function parisMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDate   = new Date(Date.UTC(y, m-1, d, 0, 0, 0));
  const localStr  = utcDate.toLocaleString('sv-SE', { timeZone: 'Europe/Paris' });
  const localDate = new Date(localStr + 'Z');
  return Date.UTC(y, m-1, d, 0, 0, 0) + (utcDate - localDate);
}

function getPeriodRange(type, param) {
  if (type === 'planning_jour') {
    const start = parisMidnight(param);
    return { start, end: start + 86400000 };
  }
  if (type === 'planning_mois') {
    const [annee, mois] = param.split('-').map(Number);
    const start     = Date.UTC(annee, mois-1, 1, 0, 0, 0);
    const moisSuiv  = mois === 12 ? 1 : mois + 1;
    const anneeSuiv = mois === 12 ? annee + 1 : annee;
    const end       = Date.UTC(anneeSuiv, moisSuiv-1, 1, 0, 0, 0);
    log('Mois UTC : ' + new Date(start).toISOString() + ' -> ' + new Date(end).toISOString());
    return { start, end };
  }
  const start = parisMidnight(param);
  return { start, end: start + 86400000 };
}

function buildBody(start, end) {
  return JSON.stringify({
    Start: start, End: end,
    ViewId: 'RESOURCE', IsResource: true,
    Mode: 'INTERVENTION', ResourceView: 'AGENT',
    Resources: null,
    FiltersValues: {
      Agencies: [], Sectors: [], Teams: [], Skills: [],
      SkillsOperator: null, InterventionStatus: [], Agents: [],
      Clients: [], InterventionTypes: [], ProductCategories: [],
      Modalities: [], Services: [],
      ShowBillClientInterventions: 0, ShowPayAgentInterventions: 0,
      ShowMyClientsOnly: false, ShowNotValidInterventions: 0,
      CancelledAgentEvent: [], HideEmptyAgents: false,
      ShowHighPriorityInterventions: false, ShowVipClientsOnly: false
    }
  });
}

async function getCsrfToken(page) {
  const token = await page.evaluate(() => {
    const input = document.querySelector('input[name="__RequestVerificationToken"]');
    if (input) return input.value;
    for (const i of document.querySelectorAll('input[type="hidden"]')) {
      const n = (i.name || '').toLowerCase();
      if (n.includes('token') || n.includes('csrf') || n.includes('forgery')) return i.value;
    }
    return null;
  });
  if (!token) throw new Error('CSRF token introuvable. Relancer node login.js');
  log('CSRF token OK (' + token.length + ' chars)');
  return token;
}

async function appelGetData(page, csrfToken, start, end) {
  log('POST GetData : ' + new Date(start).toISOString() + ' -> ' + new Date(end).toISOString());
  return await page.evaluate(async ({ apiBase, body, csrf }) => {
    const rep = await fetch(apiBase + '/GetData', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-csrf-token': csrf },
      body, credentials: 'same-origin'
    });
    if (!rep.ok) { const t = await rep.text().catch(()=>''); throw new Error('HTTP ' + rep.status + ' : ' + t.slice(0,400)); }
    return await rep.json();
  }, { apiBase: API_BASE, body: buildBody(start, end), csrf: csrfToken });
}

function parseTitle(html) {
  if (!html) return { client: '', prestation: '', titreComplet: '' };
  const decode = s => s
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(Number(c)))
    .replace(/&[a-z]+;/g,'').replace(/<[^>]+>/g,'').trim();
  const parts = html.split('</div>');
  const texts = [];
  for (const part of parts) {
    const idx = part.lastIndexOf('>');
    if (idx === -1) continue;
    const decoded = decode(part.slice(idx+1));
    if (decoded) texts.push(decoded);
  }
  return { client: texts[0]||'', prestation: texts[1]||'', titreComplet: texts.join(' | ') };
}

function buildResourceMap(resources) {
  const map = {};
  if (!Array.isArray(resources)) return map;
  resources.forEach(r => { if (r.id && r.title) map[r.id] = r.title; });
  return map;
}

function parseReponse(raw, start, end, type, param) {
  const auditPath = path.join(ROOT, 'ximi-assistant', 'rapports', 'getdata_raw_last.json');
  try { fs.mkdirSync(path.dirname(auditPath),{recursive:true}); fs.writeFileSync(auditPath, JSON.stringify(raw,null,2),'utf-8'); log('Reponse brute -> ' + auditPath); } catch(e) { log('Audit err: '+e.message); }

  const events    = raw.events    || [];
  const resources = raw.resources || [];
  const resMap    = buildResourceMap(resources);
  log('Events : ' + events.length + ' | Resources : ' + resources.length);

  const stats = {};
  events.forEach(e => { const t=(e.id||'').split(':')[0]; stats[t]=(stats[t]||0)+1; });
  log('Types : ' + JSON.stringify(stats));

  const statutMap = {
    'Intervention':'Planifiee','InterventionCancelled':'Annulee',
    'InterventionDone':'Realisee','InterventionValidated':'Validee',
    'InterventionPartial':'Partielle','AgentAbsence':'Absence',
    'AgentEvent':'Evenement','Availability':'Disponibilite'
  };

  const toHHMM = iso => iso ? new Date(iso).toLocaleTimeString('fr-FR',{timeZone:'Europe/Paris',hour:'2-digit',minute:'2-digit'}) : '';

  const evenements = events.map(item => {
    const idParts = (item.id||'').split(':');
    const typeEvent = idParts[0]||'';
    const idEvent   = idParts[1]||item.id||'';
    const nomIntervenant = resMap[item.resourceId] || item.resourceId || '';
    const parsed   = parseTitle(item.title||'');
    const cssClass = Array.isArray(item.cssClasses)?(item.cssClasses[0]||''):'';
    const statut   = statutMap[cssClass]||cssClass;
    const debutISO = item.start ? new Date(item.start).toISOString() : '';
    const finISO   = item.end   ? new Date(item.end).toISOString()   : '';
    return {
      id: idEvent, type_event: typeEvent,
      nom: parsed.titreComplet, nom_intervenant: nomIntervenant,
      debut: debutISO, fin: finISO,
      debut_formate: toHHMM(debutISO), fin_formate: toHHMM(finISO),
      client: parsed.client, adresse: '', prestation: parsed.prestation,
      prix: '', statut, detailTexte: parsed.titreComplet
    };
  });

  const result = {
    type,
    periode_start: new Date(start).toISOString().split('T')[0],
    periode_end:   new Date(end-1).toISOString().split('T')[0],
    nb_evenements: evenements.length,
    stats_types:   stats,
    evenements,
    extrait_le: new Date().toISOString()
  };
  if (type==='planning_jour') result.date = param;
  if (type==='planning_mois') result.mois = param;
  return result;
}

async function main() {
  const COMMANDE = process.argv[2] || 'planning_jour';
  const PARAM    = process.argv[3] || new Date().toISOString().split('T')[0];
  const SORTIE   = process.argv[4] || SORTIE_DEFAULT;
  log('Commande : ' + COMMANDE + ' | Param : ' + PARAM);
  log('ROOT : ' + ROOT);
  let browser;
  try {
    const env = await loadEnv(ENV_FILE);
    for (const [k,v] of Object.entries(env)) process.env[k]=v;
    if (!fs.existsSync(SESSION_FILE)) throw new Error('Session absente. Lance : node login.js');
    const storageState = await readJSONEnc(SESSION_FILE);
    if (!storageState||!storageState.cookies||!storageState.cookies.length) throw new Error('Session vide. Lance : node login.js');
    log('Session OK : ' + storageState.cookies.length + ' cookies');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState, viewport:{width:1920,height:1080}, locale:'fr-FR', timezoneId:'Europe/Paris' });
    const page = await context.newPage();
    log('Navigation -> Scheduler...');
    const resp = await page.goto(SCHEDULER_URL, { waitUntil:'networkidle', timeout:45000 });
    log('Status : ' + (resp?resp.status():'null') + ' | URL : ' + page.url());
    const finalUrl = page.url();
    if (finalUrl.includes('sso')||finalUrl.includes('login')||finalUrl.includes('microsoftonline')) throw new Error('Session expiree. Lance : node login.js');
    const csrfToken = await getCsrfToken(page);
    const range     = getPeriodRange(COMMANDE, PARAM);
    log('Start : ' + new Date(range.start).toISOString() + ' | End : ' + new Date(range.end).toISOString());
    const rawData  = await appelGetData(page, csrfToken, range.start, range.end);
    const resultat = parseReponse(rawData, range.start, range.end, COMMANDE, PARAM);
    log('Evenements : ' + resultat.nb_evenements);
    sauvegarder(resultat, SORTIE);
    process.stdout.write(JSON.stringify(resultat) + '\n');
  } catch(err) {
    log('ERREUR : ' + err.message);
    process.stdout.write(JSON.stringify({ erreur: err.message, conseil: err.message.includes('login.js')?'Lance: node login.js':'Voir logs stderr' }) + '\n');
    process.exit(1);
  } finally { if (browser) await browser.close(); }
}

main();