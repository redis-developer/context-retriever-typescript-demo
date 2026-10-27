import { dataPlaneConfig, demoConfig, redisConfig, sqlConfig } from "../../config/env.ts";
import { resolveDomain } from "../../domain/index.ts";
import { SurfaceSession } from "../../data-plane/session.ts";
import { governedArm } from "../../compare/arms/governed.ts";
import { sqlArm } from "../../compare/arms/sql.ts";
import { compare as aggregate, type Observation } from "../../compare/metrics.ts";
import { fingerprintOf, parityMismatch } from "../../compare/parity.ts";
import { render } from "../../compare/report.ts";
import { runArm } from "../../compare/run.ts";
import { scenariosFor } from "../../compare/scenarios.ts";
import type { Arm } from "../../compare/arm.ts";
import { createReader } from "../../sql-plane/client.ts";
import { storedFingerprint } from "../../sql-plane/load.ts";
import { storedRedisFingerprint } from "../../seed/seed.ts";
import { wideTableOf } from "../../sql-plane/schema.ts";

/**
 * The comparison. The deliverable of this half of the repository.
 *
 * Calls a live model once per question per arm per repeat, so it costs money.
 * Only this and `npm run bench` do.
 */
export const compare = async (options: {
  readonly repeat: number;
  readonly arm: string;
  readonly dropGuardrail: boolean;
  readonly sampleRows: number;
}): Promise<void> => {
  const demo = demoConfig();
  const domain = resolveDomain(demo.domain);
  const scenarios = scenariosFor(domain, demo.customerId, demo.seed);
  const table = wideTableOf(domain);
  const sql = sqlConfig();

  // Checked before a model is called, because every figure below is
  // meaningless if the two stores hold different records, and nothing else
  // would fail if they did.
  const expected = fingerprintOf(domain.generate(demo.seed, demo.customerId));
  for (const store of [
    { name: "Postgres", read: async () => storedFingerprint(sql.adminUrl) },
    {
      name: "Redis   ",
      read: async () => storedRedisFingerprint(domain, redisConfig().url),
    },
  ]) {
    const found = await store.read();
    if (found !== expected) {
      throw parityMismatch({
        expected,
        found: found ?? "(nothing loaded)",
        store: store.name.trim(),
      });
    }
  }

  const { mcpUrl, agentApiKey } = dataPlaneConfig();
  const session = new SurfaceSession({ mcpUrl, agentApiKey });
  const reader = createReader({ url: sql.readerUrl, statementTimeoutMs: sql.statementTimeoutMs });

  const all: Arm[] = [
    governedArm({ session, domain }),
    sqlArm({ reader, table, sampleRows: options.sampleRows }),
  ];
  const arms = options.arm === "both" ? all : all.filter(one => one.id === options.arm);
  if (arms.length === 0) {
    throw new Error(`Unknown arm ${JSON.stringify(options.arm)}. Use governed, sql or both.`);
  }

  // The guardrail toggle runs both arms twice, not just the baseline. Removing
  // the sentence from one side only would measure the sentence's effect on
  // that side and call it a comparison, and the governed arm's row being
  // unchanged is the finding worth having.
  const guardrailStates = options.dropGuardrail ? [true, false] : [true];
  const turns = scenarios.length * arms.length * guardrailStates.length * options.repeat;

  console.log(
    `${String(scenarios.length)} question(s) x ${String(options.repeat)} repeat(s) x ` +
      `${String(arms.length)} arm(s)${options.dropGuardrail ? " x 2 guardrail states" : ""} = ` +
      `${String(turns)} model turn(s) against ${demo.chatModel}.`,
  );
  console.log("This calls a live model and therefore costs money.");
  console.log(`Records match on both stores: ${expected}`);

  const observations: Observation[] = [];
  const caller = { id: demo.customerId, name: demo.customerName };

  try {
    for (let round = 1; round <= options.repeat; round += 1) {
      for (const guardrail of guardrailStates) {
        for (const scenario of scenarios) {
          // Sequential, and the arms within a question too. Asking both at
          // once makes them contend and their latencies converge, which is
          // how a comparison reports a tie it did not measure.
          for (const arm of arms) {
            observations.push(await runArm({ arm, scenario, domain, caller, guardrail }));
            process.stdout.write(".");
          }
        }
      }
    }
    console.log("");

    for (const line of render(aggregate(observations))) console.log(line);
  } finally {
    for (const arm of arms) await arm.close();
    await session.close();
  }
};
