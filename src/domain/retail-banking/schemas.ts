import { z } from "zod";

/**
 * Domain schemas for validating tool results.
 *
 * A tool result is data returned by a service over the network, sourced from
 * records in a Redis instance the application may not fully control. It is not
 * an instruction, and it is not trusted. Parsing it here converts `unknown`
 * into a domain type at a single boundary, so a shape change surfaces as a
 * validation failure with a field path rather than as `undefined` three call
 * frames later.
 *
 * Every field is optional except the key, because the generated tools support
 * field projection: a caller that asks for three fields gets three fields.
 * `passthrough` keeps fields the engine adds without failing the parse.
 */
export const transactionSchema = z
  .object({
    transaction_id: z.string(),
    customer_id: z.string().optional(),
    account_id: z.string().optional(),
    transaction_date: z.number().int().optional(),
    value_date: z.number().int().optional(),
    transaction_type: z.string().optional(),
    transaction_code: z.string().optional(),
    dr_cr_flag: z.string().optional(),
    amount: z.number().optional(),
    currency_code: z.string().optional(),
    balance_before: z.number().optional(),
    balance_after: z.number().optional(),
    reference_no: z.string().optional(),
    external_ref_no: z.string().optional(),
    channel_code: z.string().optional(),
    channel_name: z.string().optional(),
    device_id: z.string().optional(),
    terminal_id: z.string().optional(),
    beneficiary_id: z.string().optional(),
    payment_purpose: z.string().optional(),
    remarks: z.string().optional(),
    status: z.string().optional(),
    error_code: z.string().optional(),
    created_date: z.number().int().optional(),
    updated_date: z.number().int().optional(),
  })
  .loose();

export const beneficiarySchema = z
  .object({
    beneficiary_id: z.string(),
    beneficiary_name: z.string().optional(),
    beneficiary_bank: z.string().optional(),
    beneficiary_bank_code: z.string().optional(),
    beneficiary_country: z.string().optional(),
    beneficiary_account_masked: z.string().optional(),
    beneficiary_branch: z.string().optional(),
  })
  .loose();

export type Transaction = z.infer<typeof transactionSchema>;
export type Beneficiary = z.infer<typeof beneficiarySchema>;

export const resultSchemas = {
  transaction: transactionSchema,
  beneficiary: beneficiarySchema,
} as const;
