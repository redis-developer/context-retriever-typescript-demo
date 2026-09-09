# Running the demo

A script for showing this repository live, in about twenty minutes. The README explains the code; this explains the performance.

Read the two sentences under each step before you run it. They are what to say, not just what to type.

## Before anyone is watching

Work through this list first. Every item has failed at least once.

```bash
npm run doctor
```

You want ticks against all five configuration groups, a reachable control plane, and an accepted agent key. If the data plane fails but configuration is fine, the service is the problem rather than your credential, and `doctor` says which.

Then confirm the data is really there, because an empty result looks identical to a broken deployment:

```bash
npm run query
```

Ten rows, scoped to the signed-in customer. If you get zero rows with no error, the agent key's access tags do not match the seeded data. Reseed and reprovision rather than debugging the index.

Start the agent and leave it running:

```bash
npm run agent
```

Open `http://localhost:3100`. Ask it one throwaway question now, off-screen. The first turn of a process pays for the MCP connection and the first tool discovery, and you would rather spend that before anyone is looking.

Have two things ready: a terminal, and the browser. You will move between them twice.

## 1. Show the tool surface, not the code

```bash
npm run tools
```

Fourteen tools, none of them written by hand. Say that: the tool surface is generated from the data model, so the names and argument shapes were not known when this application was written, and nothing in the code hard-codes one.

Point at `filter_transaction` and say the thing most people miss. It does not take a parameter per field. Indexed fields appear as an enum inside a condition array, and the engine folds every indexed field's description into the tool description, which is re-sent to the model on every turn. That is why twelve of twenty-five fields are filterable and not all of them. Index curation is the lever on per-turn cost.

## 2. Show what the surface cannot do

```bash
npm run probe
```

This is the strongest thing in the repository and it takes four seconds. No model is called, so nothing here is a sample of one model's behaviour on the day.

Say what the two sections mean. Four reads are foreclosed structurally: nothing in the tool contract can express a filtered aggregate, a two-dimensional grouping, a mutation, or raw query syntax. Three more rules are held by a sentence in the system prompt. Both kinds look identical in a transcript, and only the first survives a jailbreak, a prompt edit, or a model upgrade.

Then stop on the executed section, which is the part to slow down for:

```
filter_transaction where customer_id = CUST001    total_count 322
filter_transaction where customer_id = CUST004    total_count 0
```

Same tool, same arguments, one string different. The request was well formed and accepted, and it was answered with nothing. There is no refusal for a prompt to argue past, and the agent cannot tell that result from an empty database. Scoping is a property of the deployment, not a behaviour of the model.

## 3. Show a guardrail refusing

```bash
npm run guardrails
```

Five guardrails, each shown biting rather than asserted. Section 1 is the one to read aloud, because the service refuses an invented status value and names the permitted set in the same breath:

```
invalid tag_conditions[0]: on "status": value "COMPLETED" is not allowed;
valid values: SUCCESS, FAILED, PENDING
```

Say where that came from. Nobody wrote it for the demo. The agent guessed `COMPLETED` unprompted, on roughly half its attempts, and corrected itself from the permitted set the refusal named. An intermittent mistake that the contract catches every time is the whole argument for putting a constraint in the schema rather than in an instruction.

The summary at the end matters too. Two of the five guardrails are the caller's job, not the platform's. Say so before anyone asks, because a demo that showed only the three the platform handles would mislead.

## 4. The agent, in the browser

Move to `http://localhost:3100`. Every tool call is listed with its arguments, its duration, and the token count for the turn.

Ask these in order. The fourth and fifth belong together and the order is not optional.

**"How much have I spent in total, by currency?"** One aggregate call. No rows come back at all — the engine computes the totals and returns a handful of numbers. Point at the trace: one retrieval call, about ten milliseconds.

**"Show me my last 5 transactions"** The expensive shape, for contrast. Rows come back, and the token count goes up because whole records are now in the model's context.

**"Which of my payments failed, and why?"** A tag filter on an enumerated field. Nineteen rows. Note that the agent describes them as failed rather than as payments, which is a prompt-held rule and not a schema-held one. Say which it is.

**"How many card payments did I make last month?"** Exact, and nearly free. Watch the trace: one `filter_transaction` with `limit: 1`, returning a single record. The count comes from `total_count`, which is the server's own match count for the conditions and is independent of how many records you asked for. One record transferred for an exact answer over a filtered set.

**"How much did I spend on card payments last month?"** The agent declines, and explains that no aggregate can be narrowed to a date range.

Stop here and make the point, because this is the moment the demo turns. The agent is not failing. It is refusing to do arithmetic it cannot do reliably, having established that no tool can answer the question exactly. The alternative is an agent that fetches the rows and adds them up itself, and when we tried that, the same model produced a different wrong total on all seven attempts, spread over about 1,800 dirhams on a four-number addition. In a bank, a confident wrong number is worse than a decline.

**"Who are my most frequent counterparties?"** One aggregate grouped by counterparty, then a bounded number of name lookups. Aggregates group by identifier, not by name, so this is the one question that needs a second step. It used to take eleven retrieval calls; instructing the agent to decide which few matter before looking any of them up took it to six.

## 5. The honest latency answer

You will be asked how fast it is. Give the real numbers, in this order.

Retrieval is a median of 11.5 ms per call. A whole turn is a median of 10.31 seconds. Retrieval is about a tenth of one per cent of the time a question takes.

Then say what follows from that, which is the useful part. The model is the entire latency budget, so the only lever that moves is how many model round trips an answer takes — and that is decided by the tool surface. One round trip saved is worth roughly a thousand times the entire retrieval cost of a question. That is why the trace shows model calls next to milliseconds.

If you want the figures printed rather than quoted:

```bash
npm run bench -- --repeat 3
```

It runs seven committed questions three times each, so allow about four minutes, and it calls a live model so it costs money. Do not run it while anyone is watching a clock.

## When it goes wrong

**The agent gives a different answer than last time.** Expected, and worth naming rather than hiding. Three of the seven benchmark questions take a different number of retrieval calls between runs. The model's plan varies; retrieval latency does not, which is exactly why the trace shows both.

**A question returns nothing.** Check whether it was scoped. An empty result and a denied result are indistinguishable by design, so `npm run doctor` and `npm run query` are the fast way to tell a deployment problem from a correct refusal.

**Port 3100 is in use.** The local engine stack publishes Grafana on 3000 and this defaults to 3100 to avoid it. If something else holds 3100, set `DEMO_AGENT_PORT`.

**A turn takes twenty seconds.** Reasoning effort is set to `low` deliberately. Do not lower it to `none` to speed things up: the agent stops chaining tool calls and answers "I cannot narrow that" to questions it otherwise answers correctly.

## What not to promise

Say these before someone infers them.

The demo authenticates nobody. The signed-in customer comes from configuration, and in production a validated token supplies it. The shape of the code does not change.

Scoping is enforced by the access tags on the agent key, so this shows one tenant properly isolated rather than a multi-tenant identity flow. Per-request identity is deferred.

The dataset is 400 records on one local node. The latency figures say the request is cheap. They say nothing about how the service scales, and anyone extrapolating from them should be stopped.

Filtered aggregates and multi-field grouping are not available in the version shown here. Both are known, and the refusal in step 4 is the honest consequence rather than a defect in this application.
