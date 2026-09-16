const fs = require("fs");
// Ecrire un body de test avec UTC pur pour septembre
const body = {
  Start: Date.UTC(2026, 8, 1, 0, 0, 0),
  End:   Date.UTC(2026, 9, 1, 0, 0, 0),
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
};
console.log("Start UTC:", new Date(body.Start).toISOString(), body.Start);
console.log("End   UTC:", new Date(body.End).toISOString(),   body.End);
console.log("Body OK - a comparer avec scheduler-body.json");
// Lire le body capture precedemment
try {
  const ref = JSON.parse(fs.readFileSync('scheduler-body.json','utf8'));
  console.log("Ref Start:", new Date(ref.Start).toISOString(), ref.Start);
  console.log("Ref End  :", new Date(ref.End).toISOString(),   ref.End);
} catch(e) { console.log("scheduler-body.json absent"); }
