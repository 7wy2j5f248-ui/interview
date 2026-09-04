# PLI case-bound analysis v2: architecture map

This map was completed against commit `f0d1ede` before the v2 implementation
was started. The legacy analysis tables and reports remain historical records;
v2 is a separate path and does not rewrite or reactivate them.

| Agreed contract | Existing path at `f0d1ede` | v2 implementation boundary |
|---|---|---|
| One case may span resumed sessions | Jobs are keyed to one `session_id`; researcher labels include `-S01` | One project/participant case with an ordered set of linked sessions and one `P00001` identity |
| Freeze the complete conversation | The worker rereads live rows and filters out interviewer turns | Freeze every interviewer and participant turn, stable message ID, case-local `T###`, original text, and English analytical text |
| English analysis; original retained | Stored translations exist, but Stage 1 can fall back to original non-English text | A non-English case cannot freeze until every included turn has stored English; the snapshot retains both |
| Stage 1 starts when a completed case becomes ready | A researcher manually creates a corpus-wide run | An active researcher-approved project configuration arms future cases; formal completion/translation readiness creates one pending case attempt |
| One selected AI per run | Provider/model labels are run-level, but runtime settings and prompt are partly environment-derived | Provider, exact model, reasoning, output allowance, rules, project context, schema, and literal request are frozen per attempt |
| Full MU -> CO -> CA -> TH in one connected result | The current prompt has no output schema; later software parses and reconstructs forms | Strict model output contract with explicit case-local IDs and direct support links; presentation copies only explicit fields |
| Exact request frozen before the call | Only a plan hash and version labels are stored | Immutable request JSON plus SHA-256 is committed before submission |
| Exact provider response frozen first | Extracted text/status are stored; complete provider response is not | Complete provider-native JSON and exact output text are committed before presentation parsing |
| Technical outcome only | `failed` and `incomplete` provider returns can be persisted as completed reports | Only provider `completed` closes Stage 1; `incomplete` is technically incomplete; `failed`/`cancelled`/transport failure is failed |
| No validator, reviewer, repair, fallback, or automatic retry | Analytical validators were removed, but legacy recovery structures remain | One submission per attempt. A new attempt can only be created by an explicit researcher action and never overwrites the prior attempt |
| Completed cases are terminal | Historical run machinery can create separate broad runs | A database constraint/function prevents any new v2 attempt after case completion |
| Unresolved cases block the cohort | Stage 2A checks a completed historical run and currently waits for separate approval | Cohort membership is frozen on closure; all members must be Stage 1 completed before one whole-cohort Stage 2A run is queued |
| Stage 2 starts at the objective barrier | Current UI says cross-case work never starts automatically | Closing the researcher-defined cohort is the corpus decision; the last completed Stage 1 member automatically opens Stage 2A without another approval gate |
| P# stays outside Stage 2 model input | Historical Stage 2A paired participant IDs with Codes | The frozen model payload contains only compact `PC######` references and Code labels; a separate service-only table retains case provenance |

## Runtime sequence

```text
researcher activates immutable project configuration
        -> completed case becomes English-ready
        -> complete case source snapshot freezes
        -> Stage 1 attempt queues automatically
        -> exact request freezes
        -> one provider response is submitted
        -> complete provider response freezes
        -> objective provider status closes or leaves the case unresolved
        -> explicit MU/CO/CA/TH fields become read-only presentation rows
        -> closed cohort waits for every member
        -> all complete: one whole-cohort Stage 2A run queues
           with compact preliminary-Code references and labels only
           while P# remains outside the model pipeline
```

Provider-response retrieval is transport bookkeeping for the same durable
response ID. It never creates a replacement request. No AI judges the content
or decides whether the case is complete.
