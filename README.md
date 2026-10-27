<div align="center">
    <img width="300" src="https://raw.githubusercontent.com/redis/redis-vl-python/main/docs/_static/Redis_Logo_Red_RGB.svg" alt="Redis">
    <h1>Context Retriever TypeScript demo</h1>
    <p><strong>A worked reference for the Context Retriever TypeScript SDK</strong></p>
</div>

Built on [`@redis-iris/context-retriever`](https://www.npmjs.com/package/@redis-iris/context-retriever), the SDK for [Redis Iris](https://redis.io/iris/) Context Retriever, over a synthetic retail-banking transaction model.

---

## What Context Retriever is

Context Retriever turns a database into a tool surface an agent can use safely.

You declare a data model: your entities, their fields, and which of those fields are indexed. The service builds the Redis indexes and generates a set of typed [MCP](https://modelcontextprotocol.io) tools from that model, with names like `filter_transaction` and `summarize_transaction`. Your agent calls those tools. It never writes a query, and it cannot ask for anything the model does not declare.

Two consequences are the reason to reach for it.

**The tool contract is the boundary.** Constraints live in the schema rather than in a prompt, so a filter on a value outside an enumerated set is refused by the service. The agent cannot express the wrong request, rather than being asked not to make it.

**Reads are scoped by declaration.** A field mapping on the entity, paired with access tags on the calling credential, means one session sees one customer's records. Denial is the default, so a misconfiguration returns nothing rather than everything.

The vocabulary is worth having straight before you read any code:

| Term                | What it means                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| **Data model**      | The entities, fields, indexes, relationships and ACL mappings you declare                       |
| **Context surface** | One deployed data model, with its Redis indexes and its generated tools                         |
| **Control plane**   | The admin REST API. Creates surfaces, imports data, mints keys. Authenticated with an admin key |
| **Data plane**      | The MCP endpoint your agent calls. Authenticated with an agent key scoped to one surface        |
| **Agent key**       | A scoped credential. Its access tags decide which records the holder may see                    |
| **Generated tools** | The MCP tools built from your model. You discover them at runtime; you do not write them        |

The [product documentation](https://redis.io/docs/latest/develop/ai/context-engine/context-retriever/) covers the service itself. This repository covers using it from TypeScript.

## What this repository is

The SDK ships a good README and five example scripts. What it does not ship is those pieces assembled into a working application against a realistic data model, which is where the mistakes actually happen. This repository is that assembly, with each non-obvious decision explained where the code makes it.

The worked example is a retail-banking assistant: an agent that answers a signed-in customer's questions about their own transactions, and can see nobody else's. It is deliberately small enough to read in an afternoon and complete enough to run.

Read it for one of three reasons. To copy the patterns into your own TypeScript project. To see what the generated tool surface actually looks like against a non-trivial model. Or to understand where the boundaries of the product are, which is the part a demo usually leaves out.

## What is inside

| Command              | What it does                                                           |
| -------------------- | ---------------------------------------------------------------------- |
| `npm run doctor`     | Reports what is configured and what is reachable                       |
| `npm run seed`       | Writes deterministic synthetic records into Redis                      |
| `npm run provision`  | Creates the surface, imports the records, mints a scoped agent key     |
| `npm run tools`      | Prints the tool surface this deployment generated                      |
| `npm run query`      | One retrieval call, timed and validated                                |
| `npm run guardrails` | Each guardrail, shown refusing something                               |
| `npm run probe`      | What the tool surface cannot express, decided without calling a model  |
| `npm run compose`    | One question answered across both entities                             |
| `npm run agent`      | A tool-calling agent behind a single-file web interface                |
| `npm run bench`      | A committed question set, with tokens and latency per question         |
| `npm run sql:seed`   | Loads the same records into Postgres, for the comparison below         |
| `npm run compare`    | The same questions answered by this surface and by a text-to-SQL agent |
| `npm run teardown`   | Deletes the surface, leaving the records in Redis                      |

The code behind them:

```
src/config/env.ts    Zod-validated environment, reporting every missing variable at once
src/domain/          The DomainModel interface and the retail-banking implementation
src/control-plane/   Administrative REST: surfaces, provisioning, agent keys
src/data-plane/      MCP: session lifecycle, tool discovery, retrieval
src/seed/            A thin Redis seeding utility
src/cli/             The commands above
src/agent/           The bridge, the measured turn, an HTTP server and a single-file interface
src/compare/         The text-to-SQL comparison: arms, prompt scaffold, judge, report
src/sql-plane/       Postgres for the comparison's baseline
```

Everything except the last two is the reference. `src/compare/` and `src/sql-plane/` are an extension, and the only part that needs Docker.

## What it evidences

The three claims this repository makes, and the command that shows each. Every figure quoted further down was printed by one of these, so run yours rather than trusting ours.

| Claim           | How you see it                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Low latency** | `npm run query -- --repeat 30` reports a distribution. `npm run bench` reports retrieval against a whole agent turn               |
| **Guardrails**  | `npm run guardrails` makes each one refuse something. `npm run probe` reports what no tool can express at all                     |
| **Token cost**  | Aggregations answer "how much" and "how many" without returning rows. `npm run bench` reports tokens and model calls per question |

Not all five guardrails are the platform's to apply, and the table further down says which are yours.

## Requirements

- Node 22.18 or newer. The repository runs TypeScript through Node directly, with no transpiler, so type stripping must be available unflagged.
- A Context Retriever deployment, its admin API key, and a Redis database with the query engine and JSON available.

That is the whole dependency list. There is no build step, no bundler, and no embedding provider, because no entity carries a vector.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`, then run the commands in the order listed above. Each one prints what to do next, so you can work down the list without referring back here.

Three of them are worth a note before you start.

`npm run doctor` is worth running first, and again whenever something is confusing. It distinguishes the three failures that look alike: a missing variable, an unreachable service, and a rejected credential.

`npm run provision` prints an agent key. The service returns it exactly once and no endpoint reads it back, so put it in `.env` when you see it.

`npm run probe` is the one to run if you have time for only one. Everything else shows the system doing something; `probe` shows what it cannot do, and it calls no model, so its result is a property of the deployment rather than a sample of one model's behaviour on the day. It separates the reads no tool can express from the rules that live in a sentence of the system prompt, because both look identical in a transcript and only one survives a model upgrade. It exits non-zero if the surface turns out to expose a read it expected to be foreclosed.

## The data model

Two entities. `transaction` carries twenty-five fields. Fourteen are indexed, and twelve of those are tag- or numeric-indexed, which is the number that matters: only tag and numeric indexes become `filter_` parameters, and a tool schema is re-sent to the model on every turn. `beneficiary` is the counterparty, normalised out of the transaction row, and the single relationship between them.

Three entities that a first pass would have modelled (customer, account and channel) are deliberately collapsed onto `transaction` as fields. None carries enough attributes to answer a question of its own, and every hop is a round trip charged in latency and tokens. `src/domain/retail-banking/entities.ts` records the reason for each index and each omission.

Three type mappings are decisions rather than translations, and all three are explained at the field:

| Source type             | Modelled as               | Why                                                                                                        |
| ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `NUMBER(20)` identifier | `str`, tag-indexed        | Twenty digits exceeds the largest integer JavaScript represents exactly, so an `int` is silently corrupted |
| `TIMESTAMP`             | `int`, epoch milliseconds | The engine has no date type, and both sorting and range filtering are numeric-index operations             |
| `NUMBER(18,2)` money    | `float`                   | Agent-friendly for ranges and sums. Minor-unit integers are exact but read in fils everywhere              |

### Swapping the model

`src/domain/` defines one interface. A different domain is a directory implementing `DomainModel`, meaning entities, a key prefix, result schemas, a record generator, a subject field and any internal tools, plus one line in the registry and `DEMO_DOMAIN` pointing at it.

Provisioning, seeding, retrieval and the tool bridge read only the interface, and the access tag that scopes the agent key is derived from your own ACL mapping rather than assumed. Three things are not free, and pretending otherwise would waste your afternoon. The agent's system prompt in `src/agent/bridge.ts` is written for retail banking, and its rules about currency and settled status are domain knowledge that has to be rewritten. The benchmark question set in `src/agent/questions.ts` and the suggestions in the web interface name transactions. And `npm run guardrails` and `npm run compose` are scripted against these two entities by design, because each demonstrates a specific claim about this model. Treat them as worked examples to adapt rather than as generic commands.

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

## Two planes, two credentials

`control-plane` and `data-plane` are separate directories with no import between them. They speak different protocols and take different credentials, and the SDK documents mixing them up as the usual cause of a puzzling 401. Keeping them apart makes holding the wrong credential structurally impossible rather than something to remember.

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

**The demo authenticates nobody.** The signed-in customer comes from configuration. In production that value comes from a validated token, and the shape of the code is the same.

### What a turn actually costs

`npm run bench -- --repeat 3` runs the committed questions in `src/compare/scenarios.ts` and reports tokens, model calls, retrieval calls and latency for each. Two of the seven are questions this surface cannot answer, because a benchmark of only the flattering cases reports a figure nobody will reproduce.

Retrieval is not where the time goes, and that is worth stating plainly rather than burying. Over one run of 21 turns against a locally running service, retrieval took a median of 11.4 ms across the 40 individual calls, while a whole turn took a median of 11.71 seconds. The command computes retrieval's share within each turn and then takes the median of those, rather than dividing one median by another, and it comes to a tenth of one per cent.

So the model is the latency budget, and the useful claim is not that retrieval is fast enough. It is that the number of model round trips an answer takes is the only lever that moves, and the tool surface is what decides it. One saved round trip is worth roughly a thousand times the entire retrieval cost of a question, which is why `npm run bench` reports model calls per question next to milliseconds.

The same measurement undercuts a distinction this command was built to draw. The first turn of a process pays for the MCP connection and the first tool discovery, so it should be the expensive one. It is not reliably either: across runs it has landed on both sides of the median for every turn after it, because one cold sample cannot outweigh how much the model itself varies. The command still reports the comparison, and the honest reading is that a connection paid once per process disappears into the noise. It would not disappear for a deployment that opened a session per request, which is the mistake `src/data-plane/session.ts` exists to avoid.

Run it with `--repeat 3` or more before quoting anything from it. The command reports which questions took a different retrieval plan across repeats, and on most runs two or three of them do. A single run of a model-driven question set is a sample of one.

## Compared against text-to-SQL

The alternative to a governed tool surface is to let the agent write SQL. `npm run compare` runs both over identical records and reports what each costs and what each read.

```bash
docker compose up -d
npm run sql:seed
npm run compare -- --repeat 3
```

The baseline queries one wide table of 31 columns, carrying every field of both entities joined along the declared relationship. That is the shape worth comparing against: an agent with a connection to one transactions table. It hands the baseline a real advantage, deliberately. This surface normalises the same records into two entities, so a question about a counterparty's name costs it a second call, and the wide table removes that cost.

Postgres, not Oracle. The mechanisms transfer; the magnitudes do not. Oracle's dialect is harder to generate against, so a baseline running there would do worse than this one rather than better. Don't quote a figure from here as an Oracle figure.

### The baseline is hand-written, and that needs a reason

TypeScript has no canonical text-to-SQL toolkit. `SqlDatabase` and `SqlToolkit` were moved out of `langchain` into `@langchain/classic`, whose npm description is "Old abstractions from LangChain.js", and LangChain's current JavaScript SQL-agent guide doesn't use them. It hand-writes an `execute_sql` tool with `tool()` and Zod. So the baseline here is four tools in that idiom: `list_tables`, `get_schema`, `check_query` and `run_sql`. That is closer to current guidance than importing the legacy classes, and a comparison against a weakened baseline is not evidence.

`get_schema` embeds three sample rows, because that is the documented default of the thing being copied: `sample_rows_in_table_info = 3` in Python, `sampleRowsInTableInfo = 3` in `@langchain/classic`. Departing from it in either direction would be the larger error. Run `--sample-rows 0` to see what it costs.

### Only the tools differ, and it is enforced rather than promised

Four mechanisms, because a fairness claim asserted in a README is exactly the evidence standard this comparison exists to beat.

- `src/agent/turn.ts` is the only code that calls a model. The shipped agent and both arms go through it, so a figure from `npm run bench` and a figure from `npm run compare` are the same kind of figure.
- The `Arm` interface in `src/compare/arm.ts` has no member for a model, a prompt or a step budget. An arm cannot differ on any of them because there is nowhere to say so.
- ESLint bars `src/compare/arms/**` from importing the model provider or the configuration, so an arm cannot reach around that interface.
- Both loaders write a fingerprint of the records, and `compare` recomputes it and refuses to run on a mismatch. Identical data is a precondition, not a claim.

The shared prompt carries the business, the rules and the definitions, and each arm adds one block about its own tools. `tests/compare-fairness.test.ts` strips those two blocks and asserts that what remains is identical.

Two things follow from taking that seriously. "Spend" is defined in the shared brief as the gross sum over every type and status, because the word has two defensible readings that give different numbers, and gross is the one both arms can compute exactly. Defining it narrowly would make it unanswerable for the aggregate tools and score a capability gap as a wrong answer. And the identity and clock tools go to both arms, added by the runner rather than by an arm: without them the baseline had no way to learn which customer it was serving and asked the user for their customer ID, which measures a missing capability and reports it as governance.

### What it measures

Governance and cost lead. Accuracy is reported and does not lead: eight questions cannot separate two approaches on correctness, and a headline resting on a sample this size would not survive anyone re-running it. It is still reported, for two reasons. A comparison that omits correctness invites the question, and answering with a figure beats answering with a paragraph. And without it, an arm that answered "I cannot determine that" to everything would win every other column at once.

The command is new and the agent loop it measures is still being tuned, so treat the output as a measurement harness rather than as a published result.

The governance verdict on each generated statement is `scoped`, `unscoped` or `cannot tell`. The third is not a hedge and is never folded into either of the others. `src/compare/judge.ts` recognises one predicate form, a single-quoted equality against the declared subject column, and declines everything else, so an `IN` list, a bind parameter or an `OR` chain lands in `cannot tell` by design and the report prints how much it would not vouch for.

It lexes before it matches, which matters more than it sounds. A regex over raw SQL clears both of these, and neither reaches the planner:

```sql
select * from bank_transaction -- customer_id = 'CUST001'
select * from bank_transaction where remarks = 'paid by customer_id = ''CUST001'''
```

Doubt resolves in the baseline's favour throughout. A statement reading only tables that carry no subject column is never asked for a scoping predicate, and the report prints how many statements that rule cleared. With one wide table it is zero, and it says so, because a rule that leaves no trace when it fires is a rule nobody can check.

### Reading the output

No figures are quoted here, deliberately. The agent loop is still being tuned, and a number published before that work is done would be read as a characterisation of the product rather than as a snapshot of an unfinished one. Run the command and read your own.

What to look at, and in what order. The session block first, because no single per-question row is true on its own. Then the hidden-cost block, which explains why: a tool schema is charged on every model call whether a tool is used or not, while schema inspection is charged once and again on each later call in the same turn. One arm's cost is therefore fixed per call and the other's grows with calls, and the sign of the difference can change between one question and the next.

That is also where the lever is. Only tag- and numeric-indexed fields become filter parameters, and every indexed field's description is folded into a tool description re-sent every turn, so the index set is what moves the figure. It is the same conclusion the tool surface section reaches from the other direction.

Then the governance block, and read its denominators. Whether a model-mediated guardrail holds is a property of the day: the same question has produced a scoped statement on one run of this command and a cross-customer read on another, against the same code and the same records. That is why every governance figure carries how many repeats produced it, and why a single repeat is not worth quoting.

Accuracy comes last and is the weakest thing in the report. A handful of scored turns cannot separate two approaches, so read a difference there as neither arm being obviously wrong on this data rather than as a result.

## Known limitations

- Answers are only as good as the model. Every path here has been run against a live model, and the agent's own reasoning is the least predictable part of it: the same question can produce a different tool plan on consecutive turns. Retrieval latency does not vary that way, which is the point of showing both in the trace.
- Semantic and hybrid search are out of scope. No entity carries a vector, which is why no embedding provider is needed. Adding one is additive: a `list[float]` field with a `sourceField` coupling to a text-indexed field.
- Schema inference, activity logs, and any deployment automation are out of scope.
- The comparison's baseline runs on Postgres and its judge understands one predicate form. Both are stated where they are used, and both err towards the baseline. Nothing here says anything about how either side scales: the dataset is 400 rows on one node, and both stores are on loopback, which is what makes the latency figures comparable and also what makes them useless for sizing.
- `summarize_<entity>` and `count_<entity>` take no condition parameters, and `group_by` takes a single field, so there is no filtered SUM. A filtered aggregate is expressed by grouping and then selecting in the caller, as `npm run compose` does. Two consequences are worth knowing before you design questions around it. Grouping a sum by anything other than `currency_code` adds different currencies together and returns a number that means nothing. And a `group_by` is only useful while the field's distinct values fit under the hundred-group ceiling, which rules out encoding a composite slice key as a tag: on this dataset a code-currency-month key already has ninety-five distinct values and would grow by a dozen a month.
- Counting a filtered set is the exception, and it is exact. `filter_*` and `search_*` results carry `total_count`, the server-side match count for the conditions, independent of `limit`. Asking with `limit: 1` buys an exact count for one record transferred, which is why the agent is told to count that way rather than by measuring a result array.

## Development

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

All four pass on a clean checkout with nothing configured, so reviewing this repository costs nothing. That is a property worth keeping rather than a happy accident: no test reaches a service, a credential or the network, and the Vitest config sets `DEMO_SKIP_DOTENV` so the suite behaves the same on a configured machine as on a fresh clone. Anything that needs a live deployment is a command under `npm run`, not a test.

The four are what CI runs, in that order, so a first contribution that passes locally passes there too.

The compiler options are stricter than usual on purpose, and two are load-bearing. `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature` match the SDK's own repository, so its snippets paste in unchanged. `erasableSyntaxOnly` rejects syntax Node cannot strip, which is what makes running TypeScript without a transpiler safe.

Linting is type-aware, chosen for one rule: `no-floating-promises`. This codebase is almost entirely async around a `close()` the SDK documents as able to throw, and an unawaited promise is the likeliest bug in it.

## Licence

MIT. See [LICENSE](LICENSE).
