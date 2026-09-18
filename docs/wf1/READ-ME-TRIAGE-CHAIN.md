# IFC matching with a Basic LLM Chain

`Match IFC Asset and Describe Issue` is now the second **Basic LLM Chain**. It reuses the chain and OpenRouter model the user placed on the canvas. The selected model remains `qwen/qwen3-vl-8b-thinking`.

The system message contains the existing IFC matching and maintenance-description instructions. The user message sends only two JSON fields: `observations` from `Validate Room Observations`, and `candidates` from `Find IFC Element`. This stage receives no photograph.

## Where the output schema is

Open **Triage Output Parser → Parameters → JSON Schema**. The schema is already filled in, with Schema Type set to manual/Define using JSON Schema. No auto-fixing model is attached.

The same schema is saved in [cbm/openrouter/triage-output-schema.json](../../cbm/openrouter/triage-output-schema.json). Its maintained source is `triageSchema` in `cbm/openrouter/contracts.js`. This is a contract written for the workflow, not a schema to obtain from the model provider.

It requires `identified`, `global_id`, `visual_object_id`, `identification_confidence`, `identification_evidence`, `ambiguous`, `fault_observed`, `category`, `severity`, `description`, and `required_skill`. IDs can be null when unresolved. The observation parser on the first chain uses a different schema describing objects in the photograph.

`Parse Triage JSON` now reads the chain's structured output while retaining the exact-candidate, type, confidence, ambiguity and visible-fault checks. Chain/parser failures continue to this validator and the existing capture-failure path. A positive result continues to ticket preparation and FM authorization.

Rebuilding through `scripts/workflows/Prepare-CbmWorkflows.ps1` preserves both native chains, their selected models, parsers and connections. Validation includes 13 adapter/business-rule cases, graph and preservation checks, and two complete preparation runs. No live model call or email is needed for these checks.
