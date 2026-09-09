# Context Retriever TypeScript demo

A worked reference for [`@redis-iris/context-retriever`](https://www.npmjs.com/package/@redis-iris/context-retriever), the TypeScript SDK for Redis Context Retriever, over a retail-banking transaction model.

The SDK ships a good README and five example scripts. What it does not ship is those pieces assembled into a working application against a realistic data model, which is where the mistakes actually happen. This repository is that assembly, with each non-obvious decision explained where the code makes it.

It answers a question no single generated tool can: _how much have I sent to counterparties matching this text?_ Answering it needs a lexical search on one entity, an aggregation on another, a join between them, and a session that can only see one customer's records.

## What it demonstrates

Retrieval is scoped, measured and constrained rather than merely working:

- Latency, measured client-side rather than claimed. Median 3.2 ms and 95th percentile 5.6 ms over 30 calls of a ten-row scoped filter, against a locally running service. Your figures will differ; the point is that `npm run query -- --repeat 30` prints yours.
- Five guardrails, each shown refusing something rather than asserted. Two are enforced by the schema, one by the service, and two are the caller's job. That last group is the one worth knowing about.
- Token cost. Aggregations answer "how much" and "how many" without returning rows. The agent reports its own token and model-call counts per question, and `npm run bench` runs a committed question set and reports them per question and in aggregate.

## Requirements

- Node 22.18 or newer. The repository runs TypeScript through Node directly, with no transpiler, so type stripping must be available unflagged.
- A Context Retriever deployment, its admin API key, and a Redis database with the query engine and JSON available.

That is the whole dependency list. There is no build step, no bundler, and no embedding provider, because no entity carries a vector.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`, then work down the commands below. Each prints what to do next.

```bash
npm run doctor      # what is configured, and what is reachable
npm run seed        # write generated records into Redis
npm run provision   # create the surface, import, mint a scoped agent key
npm run tools       # the tool surface this deployment generated
npm run query       # one retrieval call, timed and validated
```

`npm run doctor` is worth running first and whenever something is confusing. It distinguishes the three things that look alike: a missing variable, an unreachable service, and a rejected credential.

`npm run provision` prints an agent key. It is returned exactly once and no endpoint reads it back, so store it when you see it.

Then the two demonstrations, and the agent:

```bash
npm run guardrails  # each guardrail, shown refusing something
npm run probe       # what the tool surface cannot express, with no model involved
npm run compose     # one question answered across both entities
npm run agent       # a web interface on http://localhost:3100
npm run bench       # the committed question set, timed and costed (calls a live model)
```

`probe` is the one to run if you have time for only one. Everything else here shows the system doing something; `probe` shows what it cannot do, and it calls no model, so the result is a property of the deployment rather than a sample of one model's behaviour on the day. It separates the reads no tool can express from the rules that live in a sentence of the system prompt, because both look identical in a transcript and only one of them survives a model upgrade. It exits non-zero if the surface turns out to expose a read it expected to be foreclosed.

## The data model

Two entities. `transaction` carries twenty-five fields, twelve of them indexed. `beneficiary` is the counterparty, normalised out of the transaction row, and the single relationship between them.

Three entities that a first pass would have modelled (customer, account and channel) are deliberately collapsed onto `transaction` as fields. None carries enough attributes to answer a question of its own, and every hop is a round trip charged in latency and tokens. `src/domain/retail-banking/entities.ts` records the reason for each index and each omission.

Three type mappings are decisions rather than translations, and all three are explained at the field:

| Source type             | Modelled as               | Why                                                                                                        |
| ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `NUMBER(20)` identifier | `str`, tag-indexed        | Twenty digits exceeds the largest integer JavaScript represents exactly, so an `int` is silently corrupted |
| `TIMESTAMP`             | `int`, epoch milliseconds | The engine has no date type, and both sorting and range filtering are numeric-index operations             |
| `NUMBER(18,2)` money    | `float`                   | Agent-friendly for ranges and sums. Minor-unit integers are exact but read in fils everywhere              |

### Swapping the model

`src/domain/` defines one interface. A different domain is a directory implementing it, one line in the registry, and `DEMO_DOMAIN` pointing at it. Provisioning, retrieval and the agent read only the interface, so nothing else changes.

## The generated tool surface

Tools are generated from the data model, so names and argument shapes are not known when this code is written. Nothing here hard-codes a tool name; `src/data-plane/tools.ts` derives them from the naming convention and copes with any of them being absent.

This list came from a real `listTools()` call, printed by `npm run tools`. Run it yourself rather than trusting this table, because which tools generate depends on your indexes and your data source's capabilities.

| Tool                                                   | Notes                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `get_<entity>_by_id`                                   | Exact lookup by key                                                               |
| `filter_<entity>`                                      | One composite filter per entity, taking `tag_conditions` and `numeric_conditions` |
| `count_<entity>`, `summarize_<entity>`                 | Aggregations. `summarize` needs a numeric field on the entity                     |
| `list_<entity>`                                        | Sorting. Needs a sortable field                                                   |
| `search_<entity>_by_text`                              | Lexical search across every text-indexed field on the entity                      |
| `expand_results`                                       | The only tool that changes entity. Follows a declared relationship                |
| `union_results`, `intersect_results`, `except_results` | Set operations over inline set definitions                                        |

Two things surprised us and are worth stating. The composite filter does not take a parameter per field: indexed fields appear as the `enum` of each condition array's `field` property. And the engine folds every indexed field's description into the tool's own description, so a field description is agent-facing prompt text charged on every turn, not internal documentation. Curate indexes and keep descriptions short.

## Guardrails

Run `npm run guardrails` to see each of these refuse something.

| Guardrail                            | Prevents                                                                                                                   | Enforced by    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `allowedValues` on enumerated fields | A filter on a value that does not exist. The permitted set is an enum in the tool contract, not an instruction in a prompt | The schema     |
| String identifiers                   | Silent corruption of a twenty-digit identifier passed through a JavaScript number                                          | The schema     |
| ACL mapping plus a scoped agent key  | One customer's session reaching another customer's records, including through an aggregate                                 | The service    |
| Transaction status                   | Reporting a `FAILED` or `PENDING` transaction as a completed payment. Money did not move                                   | **The caller** |
| Currency grouping                    | Adding amounts in different currencies into one meaningless total                                                          | **The caller** |

The last two are the important rows. They are not guardrails the platform can apply for you, and a demo that showed only the first three would mislead.

`npm run probe` reports the same table from the other direction: which of these boundaries no tool can express, and which are a sentence in a system prompt that a determined user could argue past.

### The enum guardrail, caught firing

The best demonstration of `allowedValues` was not written for the README. Asked how much had been spent on card payments last month, the agent decided to exclude transactions that had not settled, and filtered on a status value it had inferred rather than read:

```
invalid tag_conditions[3]: on "status": value "COMPLETED" is not allowed;
valid values: SUCCESS, FAILED, PENDING
```

`COMPLETED` is a reasonable guess and this schema does not use it. Three things in that one line are worth noticing. The refusal came from the service, not from a prompt, so it does not depend on the model having read an instruction. The message names the permitted set, so the agent could correct itself without a round trip to a human, and it did. And the same model, on the same question, sent the invented value on roughly half its attempts, which is the argument for putting the constraint in the contract rather than in the instructions: the failure is intermittent, so testing would not reliably catch it.

### User scoping, and how it fails closed

An entity declaring `aclFieldMappings` is deny-by-default. An agent key carries `accessTags`, mapping the declared tag to the values that key may see, and `npm run provision` mints one scoped to a single customer.

Worth knowing before you debug it: a key with no matching access tag sees **none** of that entity's records, which is correct and initially indistinguishable from a broken index. If a query returns nothing, check the key's access tags before you check the index.

Configuring an identity provider on the surface and passing a user token per request is the dynamic variant, where the tag comes from a verified claim rather than being fixed when the key is minted. That is not implemented here.

## Layout

```
src/config/env.ts    Zod-validated environment, reporting every missing variable at once
src/domain/          The DomainModel interface and the retail-banking implementation
src/control-plane/   Administrative REST: surfaces, provisioning, agent keys
src/data-plane/      MCP: session lifecycle, tool discovery, retrieval
src/seed/            A thin Redis seeding utility
src/cli/             The commands above
src/agent/           The bridge, an HTTP server and a single-file interface
```

`control-plane` and `data-plane` are separate directories with no import between them. They use different protocols and different credentials, and the SDK documents mixing them up as the usual cause of a puzzling 401. Keeping them apart makes holding the wrong credential structurally impossible rather than something to remember.

An admin key administers surfaces and must never reach an agent. An agent key is scoped to one surface and administers nothing.

## Things the SDK warns about, and what this code does

The SDK's README flags several behaviours that are easy to get wrong. Each is handled here, in one place, with the reasoning beside it:

- `src/control-plane/wait.ts` polls for `active` exactly. It treats any unrecognised status as still in flight rather than as ready, so a new status costs a timeout instead of a wrong answer. Tools do not exist until a surface is active.
- `src/control-plane/provision.ts` inspects the import response. `importData` reports per-record failure instead of throwing, so ignoring it means believing a half-failed import succeeded.
- The agent key is captured before anything else can fail, because it is returned once. An earlier version of this code validated first and threw, destroying a key it had just minted.
- `src/data-plane/session.ts` replaces a dead MCP session. It checks `isOpen` before handing a client out _and_ replaces it once on a 404, because the first request on a forgotten session is the request that discovers it.
- `src/agent/bridge.ts` treats results as data. It passes retrieved records to the model only as tool output. Nothing retrieved is interpolated into a system prompt, and the server-supplied tool descriptions are used for discovery, never as trusted configuration.

## The agent

`src/agent/bridge.ts` is the module worth reading. It merges two sources into one tool list: the retrieval tools discovered from the surface, and internal tools supplied by the application.

Internal tools exist because the generated tools cannot answer who is signed in or what time it is now. Both are properties of the session rather than the data.

- `get_customer_profile` returns the signed-in customer. **It takes no arguments, and that is the point:** a tool accepting a customer identifier would let the agent pivot to any customer by passing a different value.
- `get_current_time` returns the current instant. Not a convenience — `transaction_date` is epoch milliseconds and a model has no clock, so without it the agent invents a window and answers confidently about the wrong dates.
- `dataset_overview` reports record counts per entity.

**The demo authenticates nobody.** The signed-in customer comes from configuration. In production that value comes from a validated token, and the shape of the code is the same.

### What a turn actually costs

`npm run bench -- --repeat 3` runs the seven committed questions in `src/agent/questions.ts` and reports tokens, model calls, retrieval calls and latency for each. Two of the seven are questions this surface cannot answer, because a benchmark of only the flattering cases reports a figure nobody will reproduce.

The headline is not the one we expected. Measured over 21 turns on a locally running service, retrieval took a median of 11.5 ms per call while a whole turn took a median of 10.31 seconds, so **retrieval is around a tenth of one per cent of the time a question takes.** The model is the entire latency budget. That is worth stating plainly rather than burying: the useful claim is not that retrieval is fast enough, it is that retrieval never becomes the thing you have to optimise.

The same measurement undercuts a distinction this command was built to draw. The first turn of a process pays for the MCP connection and the first tool discovery, and it is measurably more expensive — 11.21 s against a 10.23 s median for every turn after it — but the premium is a fraction of the model's own variance, so it does not matter in practice. It would matter to a deployment that opened a session per request, which is the mistake `src/data-plane/session.ts` exists to avoid.

Run it with `--repeat 3` or more before quoting anything from it. The command reports which questions took a different number of retrieval calls across repeats, and on most runs two or three of the seven do. A single run of a model-driven question set is a sample of one.

## Known limitations

- Answers are only as good as the model. Every path here has been run against a live model, and the agent's own reasoning is the least predictable part of it: the same question can produce a different tool plan on consecutive turns. Retrieval latency does not vary that way, which is the point of showing both in the trace.
- Semantic and hybrid search are out of scope. No entity carries a vector, which is why no embedding provider is needed. Adding one is additive: a `list[float]` field with a `sourceField` coupling to a text-indexed field.
- Schema inference, activity logs, and any deployment automation are out of scope.
- `summarize_<entity>` and `count_<entity>` take no condition parameters, and `group_by` takes a single field, so there is no filtered SUM. A filtered aggregate is expressed by grouping and then selecting in the caller, as `npm run compose` does. Two consequences are worth knowing before you design questions around it. Grouping a sum by anything other than `currency_code` adds different currencies together and returns a number that means nothing. And a `group_by` is only useful while the field's distinct values fit under the hundred-group ceiling, which rules out encoding a composite slice key as a tag: on this dataset a code-currency-month key already has ninety-five distinct values and would grow by a dozen a month.
- Counting a filtered set is the exception, and it is exact. `filter_*` and `search_*` results carry `total_count`, the server-side match count for the conditions, independent of `limit`. Asking with `limit: 1` buys an exact count for one record transferred, which is why the agent is told to count that way rather than by measuring a result array.

## Development

```bash
npm run typecheck && npm run lint && npm test
```

All three pass on a clean checkout with nothing configured, so reviewing this repository costs nothing. Tests that would need a live deployment skip themselves and say why.

The compiler options are stricter than usual on purpose, and two are load-bearing. `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature` match the SDK's own repository, so its snippets paste in unchanged. `erasableSyntaxOnly` rejects syntax Node cannot strip, which is what makes running TypeScript without a transpiler safe.

Linting is type-aware, chosen for one rule: `no-floating-promises`. This codebase is almost entirely async around a `close()` the SDK documents as able to throw, and an unawaited promise is the likeliest bug in it.

## Licence

MIT. See [LICENSE](LICENSE).
