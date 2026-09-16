#!/usr/bin/env python3
"""ximi_assistant.py - Assistant Ximi Local"""

import os, re, sys, json, subprocess, logging
from datetime import datetime, date, timedelta
from pathlib import Path

import pandas as pd
try:
    import duckdb
except ImportError:
    duckdb = None
try:
    import ollama
except ImportError:
    ollama = None

BASE_DIR   = Path(__file__).parent
SCRAPER_JS = BASE_DIR / "extracteurs" / "ximi_scraper.js"
RAPPORTS   = BASE_DIR / "rapports"
RAPPORTS.mkdir(exist_ok=True)
MODEL = "llama3.1:8b"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("ximi")

MOIS_FR = {
    "janvier":1,"fevrier":2,"mars":3,"avril":4,"mai":5,"juin":6,
    "juillet":7,"aout":8,"septembre":9,"octobre":10,"novembre":11,"decembre":12
}

def normaliser(s):
    import unicodedata
    return unicodedata.normalize('NFD', s).encode('ascii','ignore').decode().lower().strip()

def extraire_date(question):
    q = question.lower()
    m = re.search(r'\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})\b', question)
    if m:
        j,mo,a = m.groups()
        return f"{a}-{int(mo):02d}-{int(j):02d}"
    motif = "|".join(MOIS_FR.keys())
    m2 = re.search(rf'\b(\d{{1,2}})(?:er)?\s+({motif})(?:\s+(\d{{4}}))?\b', normaliser(q))
    if m2:
        j=int(m2.group(1)); mo=MOIS_FR[m2.group(2)]; a=int(m2.group(3)) if m2.group(3) else datetime.now().year
        return f"{a}-{mo:02d}-{j:02d}"
    aujourd = date.today()
    if any(x in q for x in ["aujourd","ce soir","ce matin"]): return str(aujourd)
    if "demain" in q: return str(aujourd + timedelta(days=1))
    if "hier" in q:   return str(aujourd - timedelta(days=1))
    return None

def extraire_mois(question):
    q = normaliser(question)
    motif = "|".join(MOIS_FR.keys())
    m = re.search(rf'\b({motif})(?:\s+(\d{{4}}))?\b', q)
    if m:
        mo=MOIS_FR[m.group(1)]; a=int(m.group(2)) if m.group(2) else datetime.now().year
        return f"{a}-{mo:02d}"
    if "ce mois" in q or "mois en cours" in q: return datetime.now().strftime("%Y-%m")
    return None

def extraire_nom_personne(question):
    """Detecte un nom propre dans la question (NOM Prenom ou Prenom NOM)"""
    q = question.strip()
    # Patterns : "de X", "pour X", "horaires de X", nom en majuscules
    patterns = [
        r"(?:de|pour|intervenant|agent)\s+([A-Z][a-zA-Z\-]+(?:\s+[A-Z][a-zA-Z\-]+)+)",
        r"([A-Z]{2,}(?:\s+[A-Z][a-zA-Z\-]+)+)",
        r"([A-Z][a-zA-Z\-]+\s+[A-Z]{2,})",
    ]
    for pat in patterns:
        m = re.search(pat, q)
        if m: return m.group(1).strip()
    return None

def detecter_intention(question):
    q = normaliser(question)
    date_str = extraire_date(question)
    mois_str = extraire_mois(question)
    nom_str  = extraire_nom_personne(question)
    mots_mois = ["mois","semaine","periode","mensuel"]
    if date_str:
        type_req = "planning_jour"
    elif mois_str or any(m in q for m in mots_mois):
        type_req = "planning_mois"
        if not mois_str: mois_str = datetime.now().strftime("%Y-%m")
    else:
        type_req = "planning_jour"
        date_str = str(date.today())
    return { "type": type_req, "date": date_str, "mois": mois_str, "nom": nom_str }

def lancer_scraper(intention):
    fichier_sortie = RAPPORTS / f"extraction_{datetime.now().strftime('%H%M%S')}.json"
    if intention["type"] == "planning_jour":
        commande, param = "planning_jour", intention["date"] or str(date.today())
    else:
        commande, param = "planning_mois", intention["mois"] or datetime.now().strftime("%Y-%m")
    log.info(f"Lancement scraper : node {SCRAPER_JS.name} {commande} {param}")
    try:
        proc = subprocess.run(
            ["node", str(SCRAPER_JS), commande, param, str(fichier_sortie)],
            capture_output=True, text=True, timeout=180, cwd=str(BASE_DIR)
        )
        if proc.stderr:
            for l in proc.stderr.strip().split("\n"):
                if l.strip(): log.info(f"[scraper] {l}")
        if proc.returncode != 0: return {"erreur": proc.stderr or "Erreur inconnue"}
        if proc.stdout.strip():
            try: return json.loads(proc.stdout)
            except: pass
        if fichier_sortie.exists(): return json.loads(fichier_sortie.read_text())
        return {"erreur": "Aucune donnee retournee"}
    except subprocess.TimeoutExpired: return {"erreur": "Timeout 180s"}
    except FileNotFoundError:         return {"erreur": "Node.js introuvable"}
    except Exception as e:            return {"erreur": str(e)}

def analyser(donnees, question, intention):
    if "erreur" in donnees: return f"Erreur : {donnees['erreur']}"
    evenements = donnees.get("evenements", [])
    if not evenements:
        return f"Aucun evenement trouve pour {donnees.get('date') or donnees.get('mois') or '?'}."
    df       = pd.DataFrame(evenements)
    log.info(f"DataFrame : {len(df)} lignes, colonnes : {list(df.columns)}")
    q        = normaliser(question)
    type_req = intention.get("type")
    stats    = donnees.get("stats_types", {})
    nom_cible = intention.get("nom")

    def stats_str():
        return "  (" + ", ".join(f"{k}: {v}" for k,v in stats.items()) + ")" if stats else ""

    col = "nom_intervenant"
    if col not in df.columns:
        col = next((c for c in df.columns if "nom" in c.lower()), None)

    # --- Recherche par nom specifique ---
    if nom_cible and col:
        nom_norm = normaliser(nom_cible)
        mask = df[col].apply(lambda x: nom_norm in normaliser(str(x)) if pd.notna(x) else False)
        df_nom = df[mask].copy()
        if df_nom.empty:
            return f"Aucun evenement trouve pour '{nom_cible}'."
        periode = donnees.get("date") or donnees.get("mois") or "?"
        out = [f"", f"Planning de {nom_cible} -- {periode} -- {len(df_nom)} evenement(s)", ""]
        df_nom = df_nom.sort_values("debut")
        for _, row in df_nom.iterrows():
            d = str(row.get("debut_formate") or "").strip()
            f = str(row.get("fin_formate")   or "").strip()
            client = str(row.get("client") or "").strip()
            prest  = str(row.get("prestation") or "").strip()
            statut = str(row.get("statut") or "").strip()
            debut_date = str(row.get("debut") or "")[:10]
            hor = f"{d}-{f}" if d and f and d != "nan" and f != "nan" else d
            detail = " | ".join(filter(None, [client, prest, statut]))
            out.append(f"  {debut_date}  {hor:<12}  {detail}")
        return "\n".join(out)

    if type_req == "planning_jour":
        date_str = donnees.get("date","?")
        demande_absences = any(x in q for x in ["absent","absence","conge","ne travaille pas","travaille pas"])
        demande_interv   = any(x in q for x in ["intervention","client","prestation"])
        if demande_absences:
            df_f = df[df["type_event"]=="AgentAbsence"].copy(); titre=f"Absences du {date_str}"
        elif demande_interv:
            df_f = df[df["type_event"]=="Intervention"].copy(); titre=f"Interventions du {date_str}"
        else:
            df_f = df[df["type_event"].isin(["Intervention","AgentAbsence","AgentEvent"])].copy()
            titre = f"Planning du {date_str}"
        out = ["", f"{titre} -- {len(df)} evenement(s) total", stats_str(), ""]
        if col and df_f[col].notna().any():
            interv = sorted(df_f[df_f[col].str.strip()!=""][col].dropna().unique().tolist(), key=lambda x:x.strip().upper())
            out.append(f"{len(interv)} intervenant(s) :")
            out.append("")
            for nom in interv:
                sous = df_f[df_f[col]==nom]
                nb_ev = len(sous)
                horaires = []
                for _, row in sous.iterrows():
                    d = str(row.get("debut_formate") or "").strip()
                    f = str(row.get("fin_formate")   or "").strip()
                    if d and d!="nan": horaires.append(f"{d}-{f}" if f and f!="nan" else d)
                hor = "  |  ".join(horaires[:3])
                if len(horaires)>3: hor += f" (+{len(horaires)-3})"
                out.append(f"  {nom:<35} {nb_ev:>3} ev.   {hor}")
        else: out.append("(aucun nom disponible)")
        return "\n".join(out)

    elif type_req == "planning_mois":
        mois_str = donnees.get("mois","?")
        df_i = df[df["type_event"]=="Intervention"] if "type_event" in df.columns else df
        out  = ["", f"Planning du mois {mois_str} -- {len(df)} evenement(s)", stats_str(), ""]
        if col and col in df_i.columns:
            cpt = df_i[df_i[col].str.strip()!=""].groupby(col).size().reset_index(name="nb")
            cpt = cpt.sort_values(col, key=lambda s: s.str.upper())
            out.append(f"{len(cpt)} intervenant(s) avec interventions :")
            out.append("")
            for _, row in cpt.iterrows():
                out.append(f"  {row[col]:<35} {row['nb']:>4} intervention(s)")
        return "\n".join(out)
    return f"Donnees extraites : {len(df)} lignes"

def sauvegarder_rapport(question, donnees, reponse):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    f  = RAPPORTS / f"rapport_{ts}.md"
    f.write_text(f"# Rapport Ximi\n\n## Question\n{question}\n\n## Reponse\n{reponse}\n", encoding="utf-8")
    log.info(f"Rapport sauvegarde : {f.name}")

def main():
    print("\n" + "="*55)
    print("ASSISTANT XIMI - Planning en direct")
    print("="*55)
    print("Exemples :")
    print("  -> Qui travaille demain ?")
    print("  -> Horaires de DARDENNE Valentin tout septembre")
    print("  -> Planning du mois de septembre 2026")
    print("  -> Qui est absent aujourd'hui ?")
    print("  -> 'quit' pour quitter")
    print("="*55 + "\n")
    while True:
        try: question = input("Question : ").strip()
        except KeyboardInterrupt: print("\nAu revoir !"); break
        if question.lower() in ("quit","exit","q"): print("Au revoir !"); break
        if not question: continue
        intention = detecter_intention(question)
        print(f"\nType : {intention['type']}", end="")
        if intention.get("date"): print(f" | Date : {intention['date']}", end="")
        if intention.get("mois"): print(f" | Mois : {intention['mois']}", end="")
        if intention.get("nom"):  print(f" | Nom  : {intention['nom']}", end="")
        print()
        print("Extraction depuis Ximi en cours...")
        donnees = lancer_scraper(intention)
        if "erreur" in donnees: print(f"\nErreur : {donnees['erreur']}\n"); continue
        nb = donnees.get("nb_evenements","?")
        print(f"{nb} element(s) extrait(s)")
        reponse = analyser(donnees, question, intention)
        print("\n" + "="*55)
        print("REPONSE :")
        print(reponse)
        print("="*55 + "\n")
        sauvegarder_rapport(question, donnees, reponse)

if __name__ == "__main__":
    main()