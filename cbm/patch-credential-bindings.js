'use strict';
// Credential references only; secrets stay in n8n's encrypted credential store.
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const app = path.join(root, 'app');
const {config} = require('./app/runtime-bindings');
const ids = JSON.parse(fs.readFileSync(path.join(root, 'imported-workflow-ids.json'), 'utf8'));
const strict = process.argv.includes('--strict');
const missing = [];
const workflows = [];
for (const [relative, id] of Object.entries(ids)) {
  const file = path.join(app, ...relative.split('\\'));
  const w = JSON.parse(fs.readFileSync(file, 'utf8'));
  w.id = id;
  for (const n of w.nodes) {
    let type, key;
    const t = n.type, p = n.parameters;
    if (/postgres/i.test(t)) {
      type = 'postgres';
      key = relative.startsWith('knowledge\\') || n.name.startsWith('Demo -') || n.name === 'Verify Selected Technical Sources' ? 'knowledgePostgres' : 'ticketPostgres';
    } else if (/\.(gmail|gmailTool)$/.test(t)) { type = 'gmailOAuth2'; key = 'gmail'; }
    else if (/\.(googleDrive|googleDriveTrigger)$/.test(t)) { type = 'googleDriveOAuth2Api'; key = 'drive'; }
    else if (t.endsWith('.lmChatAnthropic')) { type = 'anthropicApi'; key = 'anthropic'; }
    else if (t.endsWith('.lmChatOpenRouter')) { type = 'openRouterApi'; key = 'openrouter'; }
    else if (t.endsWith('.embeddingsOpenAi')) { type = 'openAiApi'; key = 'openai'; p.model = config.embeddingModel; }
    else if (t.endsWith('.vectorStoreSupabase')) { type = 'supabaseApi'; key = 'supabase'; }
    else if (n.name === 'MultiSet - Get Token') { type = 'httpBasicAuth'; key = 'multisetBasic'; }
    else if (n.name === 'FM Chat') { type = 'httpBasicAuth'; key = 'dashboardBasic'; }
    else if (['Read Approved IFC Sources', 'Recheck Source Snapshot'].includes(n.name)) {
      type = 'httpHeaderAuth'; key = 'knowledgeHeader'; p.url = config.knowledgeSnapshotUrl;
    }
    if (key) {
      const ref = config.workflowCredentials?.[relative]?.[key] ?? config.credentials[key];
      if (ref?.id && ref?.name) (n.credentials ??= {})[type] = structuredClone(ref);
      else {
        if (n.credentials) delete n.credentials[type];
        missing.push(`${relative}: ${n.name} (${key})`);
      }
    }
    const serialized = JSON.stringify(n.credentials || {});
    if (/REPLACE_/i.test(serialized)) throw new Error(`Unresolved credential reference in ${relative}: ${n.name}`);
  }
  if (relative === 'knowledge\\sync_workflow.json') (w.settings ??= {}).errorWorkflow = ids['knowledge\\error_workflow.json'];
  workflows.push([file, w]);
}
if (strict && missing.length) throw new Error('Missing n8n credential bindings:\n' + missing.join('\n'));
for (const [file, w] of workflows) fs.writeFileSync(file, JSON.stringify(w, null, 2) + '\n');
console.log(`Applied canonical credential references to ${workflows.length} workflows.`);
if (missing.length) console.log('Credentials still required:\n' + missing.join('\n'));
