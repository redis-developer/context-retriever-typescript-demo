/**
 * Estimated tokens, at four characters each.
 *
 * Crude on purpose, and deliberately shared. A real tokeniser would be a
 * dependency, would differ per model, and would be precise about a figure
 * nobody quotes on its own. What the comparison needs is that both arms are
 * measured with the same bias, and a fixed divisor guarantees that where a
 * tokeniser would not: the two arms send differently shaped text, so a
 * tokeniser's error is not the same on both sides.
 *
 * Every figure derived from this is labelled estimated wherever it is printed.
 */
export const tokensOf = (text: string): number => Math.ceil(text.length / 4);

/**
 * What a tool result cost the context window.
 *
 * Measured at the one point the two arms are identical: the value handed back
 * to the AI SDK. Not the driver's row count, not the envelope the service
 * sent, and not a regex over either. This is the string the model reads.
 */
export const resultTokensOf = (returned: unknown): number =>
  tokensOf(typeof returned === "string" ? returned : JSON.stringify(returned ?? null));
