import { demoConfig, sqlConfig } from "../../config/env.ts";
import { resolveDomain } from "../../domain/index.ts";
import { formatMs, timed } from "../../lib/errors.ts";
import { loadSqlBaseline } from "../../sql-plane/load.ts";

/**
 * Loads the text-to-SQL baseline's copy of the records.
 *
 * Always rebuilds. There is no `--flush`: the schema is derived from the entity
 * model, so a reload after the model changed has to drop the table anyway, and
 * a flag that was safe to omit would be the one people omit.
 */
export const sqlSeed = async (): Promise<void> => {
  const demo = demoConfig();
  const domain = resolveDomain(demo.domain);
  const { adminUrl, readerUrl } = sqlConfig();

  console.log(`Loading ${domain.name} into Postgres (seed ${String(demo.seed)}).`);
  console.log("The table is dropped and rebuilt, so this is also the reload path.");

  const { result: report, ms } = await timed(() =>
    loadSqlBaseline(domain, {
      adminUrl,
      readerUrl,
      seed: demo.seed,
      primarySubjectValue: demo.customerId,
    }),
  );

  console.log("");
  console.log(`  ${report.table}: ${String(report.rows)} rows, ${String(report.columns)} columns`);
  console.log(`  fingerprint: ${report.fingerprint}`);
  if (report.roleCreated) {
    console.log(`  role ${report.role}: SELECT on every table, and nothing else`);
  } else {
    console.log(`  role ${report.role}: NOT created. Postgres refused, so create it by hand.`);
  }
  console.log(`Done in ${formatMs(ms)}.`);
  console.log("");
  console.log("One wide table, because that is what the baseline is being compared against:");
  console.log("an agent writing SQL over a single transactions table. The governed surface");
  console.log("splits the same records into two entities, which costs it a second call on");
  console.log("any question about a counterparty's name. Removing that cost from the");
  console.log("baseline is what makes the comparison the one being weighed.");
  console.log("");
  console.log("Next: npm run doctor, then npm run compare");
};
