import { demoConfig, redisConfig } from "../../config/env.ts";
import { resolveDomain } from "../../domain/index.ts";
import { formatMs, timed } from "../../lib/errors.ts";
import { seedDomain } from "../../seed/seed.ts";

export const seed = async (options: { readonly flush: boolean }): Promise<void> => {
  const demo = demoConfig();
  const domain = resolveDomain(demo.domain);
  const { url } = redisConfig();

  console.log(`Seeding ${domain.name} into ${url} (seed ${String(demo.seed)})`);
  if (options.flush) console.log("  clearing existing keys under the domain prefix first");

  const { result: reports, ms } = await timed(() =>
    seedDomain(domain, {
      redisUrl: url,
      seed: demo.seed,
      primarySubjectValue: demo.customerId,
      flush: options.flush,
    }),
  );

  for (const report of reports) {
    console.log(`  ${report.entity}: ${String(report.written)} records`);
  }
  console.log(`Done in ${formatMs(ms)}.`);
  console.log("");
  console.log("Records are now in Redis at their natural keys, which is what lets a");
  console.log("surface index them and what would let `inferSchema` sample them.");
  console.log("Next: npm run provision");
};
