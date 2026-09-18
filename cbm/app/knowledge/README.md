# IFC technical knowledge and independent demo ingestion

Production retrieval maps reviewed manufacturer documents and scalar IFC properties to exact IFC GlobalIds. `extract.py` emits bounded citable chunks; n8n embeds them with text-embedding-3-small (1536 dimensions), and the invitation helper re-reads selected chunk IDs before sending excerpts. Document contents are data, never agent instructions.

Apply `schema.sql` in the separate Supabase database as owner. RLS is enabled; anonymous/authenticated users have no access. The native vector node uses a backend Supabase credential; generation management uses **CBM Supabase Postgres**, not the legacy **CBM Postgres** credential.

The head keeps separate `generation` (published) and `building_generation` pointers. The last published corpus remains readable while its replacement builds; only complete publication switches the pointer. Changed/removed chunks become inaccessible together at publication. The source must continue to be observed: without a successful observation for five minutes retrieval fails closed. Build lease: 65 minutes; n8n execution timeout: 3600 seconds. A final extraction fingerprint check prevents a changed source from publishing. Content and metadata checks remain exact; trimming or JSON serialization by the native loader must be verified with one real document before activation.

IFC property chunk IDs/revisions derive from the selected property content and identity rather than the versioned model filename. Maintenance-only version changes therefore preserve those IDs and reuse unchanged embeddings.

Import `error_workflow.json` before `sync_workflow.json`, rebind its ID in the sync settings after import, and configure the FM/operator Gmail credential. Failed production executions then notify the operator. Test the error route with a controlled failed synchronization. Official n8n behavior: [error workflows](https://docs.n8n.io/flow-logic/error-handling/) and [workflow settings](https://docs.n8n.io/workflows/settings/).

Copy `catalog.example.json` to ignored `catalog.local.json`. Supply actual GlobalIds, IFC class/type identities, reviewed products and documents. Mark approval only after checking applicability. `IfcSpaceHeater` is now included explicitly in the service candidates and sample generator; sample products are synthetic and do not establish manufacturer applicability.

Run `python -m uvicorn knowledge.service:app --host 127.0.0.1 --port 8001` with `IFC_MODEL_DIR`, `CBM_KNOWLEDGE_CATALOG`, and private `CBM_KNOWLEDGE_KEY` configured. The n8n Header Auth credential sends `X-CBM-Knowledge-Key`. Set `knowledge.snapshotUrl` to an address reachable from n8n. Bind credentials in `phase_b/deployment.local.json` or the imported templates. Use TLS/private networking across hosts.

## Independent demo library

Tracked builder: `demo_ingestion/build.js`; tests: `demo_ingestion/test.js`. The WF1 builder runs it as its last step and reproduces all 22 Demo nodes without an ignored baseline. Running it twice is safe.

1. Apply `knowledge/demo_schema.sql` in Supabase. It creates `cbm_demo_technical_documents`, its indexes, RLS and backend grants.
2. Supply the PDFs named in `technical_sheets/README.md` and set `CBM_TECHNICAL_SHEETS_DIR` to their mounted path inside self-hosted n8n.
3. Bind the Supabase API/SQL and OpenAI credentials. Start the local `unlimited-ocr` and `unlimited-ocr-adapter` Docker services; OCR itself needs no API credential.
4. Run **Demo - Load Technical Sheets** manually. Baidu Unlimited OCR extracts grounded text, tables and figure regions; embeddings preserve source filename, hash, page, content kind and uncertainty.

Only rows with metadata `active=true` and `complete=true` form the published demo library. Failed/incomplete imports stay inactive. Matching file hash and pipeline revision skip redundant ingestion. Removing a local PDF does not delete historical vectors.

**The demo table has no connection to the dispatch agent.** It is not a substitute for approved product-to-IFC mapping. Manufacturer PDFs are local inputs, ignored by Git and excluded from the release package.

Run all validation through `rebuild.ps1`. PGlite tests use synthetic vectors; actual Supabase RPC/native-loader serialization, Unlimited OCR and embedding calls require the deployment acceptance in `deployment/acceptance.json`.
