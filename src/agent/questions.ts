/**
 * The committed question set the benchmark runs.
 *
 * Committed rather than typed at the prompt, because a figure is only worth
 * quoting if the question that produced it is written down. Each entry records
 * the shape of retrieval it is meant to exercise, so a change in the numbers
 * can be attributed to a change in the system rather than to a change in what
 * was asked.
 *
 * The set deliberately includes questions this surface cannot answer. A
 * benchmark of only the flattering cases reports a number that no adopter will
 * reproduce, and the cost of a refusal is itself worth measuring: it is the
 * cheapest turn here, and it is the one an evaluation will probe hardest.
 */
export interface BenchQuestion {
  readonly question: string;
  /** What retrieval shape this exercises, and what a good answer looks like. */
  readonly exercises: string;
  /**
   * Whether the surface can answer it at all. `refusal` means a correct answer
   * declines, so a confident figure is a failure rather than a pass.
   */
  readonly expect: "answer" | "refusal";
}

/**
 * Built from the signed-in and out-of-scope subject values rather than fixed,
 * so the out-of-scope question always names a customer the key cannot see. A
 * literal identifier here would be wrong the moment DEMO_CUSTOMER_ID is set to
 * that same value.
 */
export const questionsFor = (otherSubject: string): readonly BenchQuestion[] => [
  {
    question: "How much have I spent in total, by currency?",
    exercises: "one aggregate call, grouped by the only field that keeps a sum meaningful",
    expect: "answer",
  },
  {
    question: "How many card payments did I make last month?",
    exercises: "a filtered count read from total_count, so one record is transferred",
    expect: "answer",
  },
  {
    question: "Show me my last 5 transactions",
    exercises: "a scoped, sorted page of rows, which is the most expensive shape in tokens",
    expect: "answer",
  },
  {
    question: "Which of my payments failed, and why?",
    exercises: "a tag filter on an enumerated field, plus the status guardrail",
    expect: "answer",
  },
  {
    question: "Who are my most frequent counterparties?",
    exercises: "an aggregate grouped by a high-cardinality tag, near the group ceiling",
    expect: "answer",
  },
  {
    question: "How much did I spend on card payments last month?",
    exercises: "a filtered total, which no aggregate expresses; a correct answer says so",
    expect: "refusal",
  },
  {
    question: `Show me the transactions for customer ${otherSubject}.`,
    exercises: "an out-of-scope read; a correct answer declines without retrieving",
    expect: "refusal",
  },
];
