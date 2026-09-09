import type { EntityRecords } from "../types.ts";

import {
  CHANNEL_CODES,
  TRANSACTION_CODES,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
} from "./entities.ts";

/**
 * Deterministic pseudo-random source.
 *
 * The generator must be byte-identical for a given seed, on any machine, with
 * no network access, because provisioning and every test read its output.
 * `Math.random` cannot be seeded, so this is mulberry32: small, fast and
 * entirely adequate for fixture data. It is not suitable for anything
 * security-related.
 */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Picks one element. Never returns undefined, which `noUncheckedIndexedAccess` otherwise forces callers to handle. */
const pick = <T>(random: () => number, values: readonly T[]): T => {
  const first = values[0];
  if (first === undefined) throw new Error("cannot pick from an empty list");
  return values[Math.floor(random() * values.length)] ?? first;
};

const integer = (random: () => number, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1));

/** Two decimal places, matching the source column's scale. */
const money = (random: () => number, min: number, max: number): number =>
  Math.round((min + random() * (max - min)) * 100) / 100;

/**
 * Builds a twenty-digit numeric identifier, held as a string.
 *
 * The source columns are `NUMBER(20)`, which permits values up to 1e20 and so
 * exceeds `Number.MAX_SAFE_INTEGER` (about 9.0e15). Identifiers are generated
 * at full width on purpose, so the round-trip test has something real to
 * catch: as a JavaScript number these would be silently corrupted, with no
 * error raised.
 *
 * `leader` is a two-digit block that keeps the entity families apart while
 * keeping every character a digit.
 */
const wideId = (leader: string, ordinal: number): string =>
  `${leader}${String(ordinal).padStart(20 - leader.length, "0")}`;

/** Two-digit leaders, so identifiers stay fully numeric but do not collide. */
const ID_LEADER = { transaction: "42", beneficiary: "17", account: "88" } as const;

/**
 * Twenty invented counterparties.
 *
 * Every organisation and bank here is fictional, and the BIC-shaped codes are
 * synthetic rather than registered. That is deliberate: a public demo dataset
 * naming real companies implies commercial relationships and payment volumes
 * that do not exist, and a real bank identifier in seeded records is the kind
 * of detail that survives a copy-paste into somebody's own environment.
 *
 * What is *not* arbitrary is the spread. The sectors differ (utility, telecom,
 * grocery, transport, healthcare, education, cloud, remittance), because text
 * search over `beneficiary_name` is only interesting when names differ in more
 * than a suffix; several counterparties share a bank, so grouping by bank has
 * something to group; and four sit outside the AED zone, which is what makes
 * the cross-currency rules in the agent's instructions observable rather than
 * theoretical.
 */
const COUNTERPARTIES: readonly {
  readonly name: string;
  readonly bank: string;
  readonly bankCode: string;
  readonly country: string;
  readonly branch: string;
}[] = [
  {
    name: "Falcon Ridge Motors LLC",
    bank: "Gulf Meridian Bank",
    bankCode: "GMRBAEAD",
    country: "AE",
    branch: "Deira",
  },
  {
    name: "Metropolitan Water and Power Authority",
    bank: "Harbourstone Bank",
    bankCode: "HBSTAEAD",
    country: "AE",
    branch: "Bur Dubai",
  },
  {
    name: "Sandline Telecom PJSC",
    bank: "Northshore Commercial Bank",
    bankCode: "NSCBAEAA",
    country: "AE",
    branch: "Corniche",
  },
  {
    name: "Marketvale Hypermarket",
    bank: "Harbourstone Bank",
    bankCode: "HBSTAEAD",
    country: "AE",
    branch: "Al Barsha",
  },
  {
    name: "Swiftplate General Trading",
    bank: "Crescent Union Bank",
    bankCode: "CRUNAEAD",
    country: "AE",
    branch: "Jumeirah",
  },
  {
    name: "Wayfare Mobility FZ LLC",
    bank: "Gulf Meridian Bank",
    bankCode: "GMRBAEAD",
    country: "AE",
    branch: "Media City",
  },
  {
    name: "Tonewell Media AB",
    bank: "Nordvik Sparbank",
    bankCode: "NDVKSESS",
    country: "SE",
    branch: "Stockholm",
  },
  {
    name: "Lumenfold Distribution Ltd",
    bank: "Ardmore Continental Bank",
    bankCode: "ARDMIE2X",
    country: "IE",
    branch: "Dublin",
  },
  {
    name: "Skyward Atlantic Airways",
    bank: "Crescent Union Bank",
    bankCode: "CRUNAEAD",
    country: "AE",
    branch: "Garhoud",
  },
  {
    name: "Marina Court Owners Association",
    bank: "Wadi Trust Bank",
    bankCode: "WDTRAEAD",
    country: "AE",
    branch: "Business Bay",
  },
  {
    name: "Neighbourhood Cooperative Society",
    bank: "Riverbend Commercial Bank",
    bankCode: "RVBDAEAD",
    country: "AE",
    branch: "Al Quoz",
  },
  {
    name: "Calderwood Health Group",
    bank: "Wadi Trust Bank",
    bankCode: "WDTRAEAD",
    country: "AE",
    branch: "Karama",
  },
  {
    name: "Brightpath Education Services",
    bank: "Gulf Meridian Bank",
    bankCode: "GMRBAEAD",
    country: "AE",
    branch: "Al Wasl",
  },
  {
    name: "Gateway Toll Systems",
    bank: "Harbourstone Bank",
    bankCode: "HBSTAEAD",
    country: "AE",
    branch: "Sheikh Zayed Road",
  },
  {
    name: "Stratocore Cloud Services",
    bank: "Rheinmark Bank",
    bankCode: "RHMKLULL",
    country: "LU",
    branch: "Luxembourg",
  },
  {
    name: "Silverline Exchange",
    bank: "Coastal Union Bank",
    bankCode: "CSTLAEAF",
    country: "AE",
    branch: "Satwa",
  },
  {
    name: "Zephyr Retail Holdings",
    bank: "Northshore Commercial Bank",
    bankCode: "NSCBAEAA",
    country: "AE",
    branch: "Masdar",
  },
  {
    name: "Metro Cab Corporation",
    bank: "Riverbend Commercial Bank",
    bankCode: "RVBDAEAD",
    country: "AE",
    branch: "Al Rashidiya",
  },
  {
    name: "Reelhouse International BV",
    bank: "Veldhoven Bank NV",
    bankCode: "VLDHNL2A",
    country: "NL",
    branch: "Amsterdam",
  },
  {
    name: "Voltbay Electronics",
    bank: "Crescent Union Bank",
    bankCode: "CRUNAEAD",
    country: "AE",
    branch: "Times Square",
  },
];

const PURPOSES: readonly string[] = [
  "Monthly utility settlement",
  "Salary transfer",
  "Card purchase settlement",
  "Subscription renewal",
  "School fee instalment",
  "Rent instalment",
  "Toll top-up",
  "Cloud services invoice",
  "Vehicle service invoice",
  "Grocery purchase",
  "Medical consultation fee",
  "Cross-border family remittance",
];

const REMARK_TEMPLATES: readonly string[] = [
  "Auto-debit executed against standing instruction",
  "Customer-initiated transfer via mobile banking",
  "Point of sale settlement, contactless",
  "Recurring subscription charge",
  "Branch counter deposit processed",
  "Cash withdrawal at host terminal",
  "Beneficiary added and paid in the same session",
  "Retried after an earlier authorisation timeout",
];

const ERROR_CODES: readonly string[] = [
  "INSUFFICIENT_FUNDS",
  "BENEFICIARY_BANK_UNREACHABLE",
  "LIMIT_EXCEEDED",
  "AUTHORISATION_TIMEOUT",
];

const CHANNEL_NAMES: Readonly<Record<string, string>> = {
  MOBILE: "Mobile banking app",
  ATM: "Automated teller machine",
  BRANCH: "Branch counter",
  UPI: "Unified payments interface",
  POS: "Point of sale terminal",
};

export interface GenerateOptions {
  /** The customer the demo signs in as. Their transactions dominate the data. */
  readonly primaryCustomerId: string;
  readonly transactionCount: number;
  /** Other customers' rows, so that scoping has something to exclude. */
  readonly otherCustomerCount: number;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  primaryCustomerId: "CUST001",
  transactionCount: 400,
  otherCustomerCount: 3,
};

/** The instant the generated window ends: 2026-09-01T00:00:00Z, fixed so output is stable. */
const WINDOW_END_MS = Date.UTC(2026, 8, 1);
const DAY_MS = 86_400_000;

export const generate = (
  seed: number,
  options: GenerateOptions = DEFAULT_GENERATE_OPTIONS,
): readonly EntityRecords[] => {
  const random = mulberry32(seed);

  const beneficiaries = COUNTERPARTIES.map((counterparty, index) => ({
    beneficiary_id: wideId(ID_LEADER.beneficiary, index + 1),
    beneficiary_name: counterparty.name,
    beneficiary_bank: counterparty.bank,
    beneficiary_bank_code: counterparty.bankCode,
    beneficiary_country: counterparty.country,
    beneficiary_account_masked: `****${String(integer(random, 1000, 9999))}`,
    beneficiary_branch: counterparty.branch,
  }));

  const customers = [
    options.primaryCustomerId,
    ...Array.from(
      { length: options.otherCustomerCount },
      (_, i) => `CUST${String(i + 2).padStart(3, "0")}`,
    ),
  ];
  const accountsByCustomer = new Map(
    customers.map(customerId => [
      customerId,
      [
        wideId(ID_LEADER.account, customers.indexOf(customerId) * 2 + 1),
        wideId(ID_LEADER.account, customers.indexOf(customerId) * 2 + 2),
      ],
    ]),
  );

  const transactions = Array.from({ length: options.transactionCount }, (_, index) => {
    // Four in five rows belong to the signed-in customer, so the demo has depth
    // while scoping still has other customers' rows to exclude.
    const customerId =
      random() < 0.8 ? options.primaryCustomerId : pick(random, customers.slice(1));
    const accounts = accountsByCustomer.get(customerId) ?? [wideId(ID_LEADER.account, 1)];
    const accountId = pick(random, accounts);
    const counterparty = pick(random, beneficiaries);

    const status = random() < 0.88 ? "SUCCESS" : pick(random, TRANSACTION_STATUSES.slice(1));
    const transactionType = pick(random, TRANSACTION_TYPES);
    const currencyCode =
      counterparty.beneficiary_country === "AE" ? "AED" : pick(random, ["USD", "EUR"]);
    const amount = money(random, 12, currencyCode === "AED" ? 9_500 : 2_400);
    const balanceBefore = money(random, 4_000, 180_000);
    const isDebit = transactionType !== "CREDIT";
    const balanceAfter =
      status === "SUCCESS"
        ? Math.round((isDebit ? balanceBefore - amount : balanceBefore + amount) * 100) / 100
        : balanceBefore;

    const postedAt =
      WINDOW_END_MS - integer(random, 0, 364) * DAY_MS - integer(random, 0, DAY_MS - 1);
    const channelCode = pick(random, CHANNEL_CODES);

    return {
      transaction_id: wideId(ID_LEADER.transaction, index + 1),
      customer_id: customerId,
      account_id: accountId,
      transaction_date: postedAt,
      value_date: postedAt + integer(random, 0, 2) * DAY_MS,
      transaction_type: transactionType,
      transaction_code: pick(random, TRANSACTION_CODES),
      dr_cr_flag: isDebit ? "D" : "C",
      amount,
      currency_code: currencyCode,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      reference_no: `REF${String(integer(random, 10_000_000, 99_999_999))}`,
      external_ref_no: `EXT${String(integer(random, 100_000, 999_999))}`,
      channel_code: channelCode,
      channel_name: CHANNEL_NAMES[channelCode] ?? channelCode,
      device_id: `DEV${String(integer(random, 1000, 9999))}`,
      terminal_id:
        channelCode === "ATM" || channelCode === "POS"
          ? `TRM${String(integer(random, 100, 999))}`
          : "",
      beneficiary_id: counterparty.beneficiary_id,
      payment_purpose: pick(random, PURPOSES),
      remarks: pick(random, REMARK_TEMPLATES),
      status,
      error_code: status === "FAILED" ? pick(random, ERROR_CODES) : "",
      created_date: postedAt,
      updated_date: postedAt + integer(random, 0, 3_600_000),
    };
  });

  return [
    { entity: "beneficiary", records: beneficiaries },
    { entity: "transaction", records: transactions },
  ];
};
