import { describe as group, expect, it } from "vitest";
import { z } from "zod";

import {
  isAggregate,
  parseRecords,
  payloadOf,
  summariseLatency,
} from "../src/data-plane/retrieve.ts";

/**
 * Tests for reading a tool result, which is where two live bugs came from.
 *
 * The engine does not populate `structuredContent`; it puts the JSON envelope
 * in a text block. Code that read only the structured field saw `undefined` and
 * reported no records against a service that had answered correctly. And a
 * plain-text error envelope, parsed as if it were a record, produced validation
 * problems that read as malformed data.
 */

const textResult = (text: string): Parameters<typeof payloadOf>[0] => ({
  content: [{ type: "text", text }],
});

group("finding the payload", () => {
  it("prefers structuredContent when the service populates it", () => {
    const result = {
      structuredContent: { total_count: 3 },
      content: [{ type: "text", text: '{"total_count":99}' }],
    } as Parameters<typeof payloadOf>[0];
    expect(payloadOf(result)).toEqual({ total_count: 3 });
  });

  it("parses JSON out of a text block, which is what this engine sends", () => {
    expect(payloadOf(textResult('{"total_count":8}'))).toEqual({ total_count: 8 });
  });

  it("hands back unparseable text rather than throwing", () => {
    // A tool-level error arrives as prose. Throwing here would turn a message
    // the caller wants to show into a stack trace.
    expect(payloadOf(textResult("value COMPLETED is not allowed"))).toBe(
      "value COMPLETED is not allowed",
    );
  });

  it("returns undefined for an empty result", () => {
    expect(payloadOf({ content: [] })).toBeUndefined();
  });

  it("joins multiple text blocks, newline separated", () => {
    const split = {
      content: [
        { type: "text", text: '{"a":1}' },
        { type: "text", text: "trailing note" },
      ],
    } as Parameters<typeof payloadOf>[0];
    // Joined and then parsed, so a result split across blocks is no longer
    // valid JSON and comes back as text. Worth pinning: it is the behaviour, and
    // a caller showing the text still shows something useful.
    expect(payloadOf(split)).toBe('{"a":1}\ntrailing note');
  });
});

const Row = z.object({ id: z.string() }).loose();

group("parsing records", () => {
  it("reads the results array and validates each row", () => {
    const { records, problems } = parseRecords({ results: [{ id: "1" }, { id: "2" }] }, Row);
    expect(records).toHaveLength(2);
    expect(problems).toEqual([]);
  });

  it("reports a problem naming the row and the field", () => {
    const { records, problems } = parseRecords({ results: [{ id: 7 }] }, Row);
    expect(records).toHaveLength(0);
    expect(problems[0]).toMatch(/record 0.*id/);
  });

  it("treats a bare object as one record", () => {
    expect(parseRecords({ id: "1" }, Row).records).toHaveLength(1);
  });

  it("reports neither records nor problems for a text payload", () => {
    // The trap: a plain-text error envelope counted as a malformed record makes
    // a refusal look like corrupt data.
    for (const payload of ["some error text", undefined, null]) {
      const { records, problems } = parseRecords(payload, Row);
      expect(records, String(payload)).toEqual([]);
      expect(problems, String(payload)).toEqual([]);
    }
  });
});

group("recognising an aggregate", () => {
  it("recognises the shapes the aggregate tools return", () => {
    expect(isAggregate({ value: 322 })).toBe(true);
    expect(isAggregate({ function: "count", value: 0 })).toBe(true);
    expect(isAggregate({ groups: [] })).toBe(true);
  });

  it("does not mistake a filter envelope for an aggregate", () => {
    expect(isAggregate({ results: [], total_count: 0, has_more: false })).toBe(false);
    expect(isAggregate(undefined)).toBe(false);
    expect(isAggregate("text")).toBe(false);
  });

  it("does mistake a record with a field named value, which is a known limit", () => {
    // Recorded rather than fixed: the check is structural and this domain has no
    // such field. A domain that does would need the tool name, not the payload.
    expect(isAggregate({ id: "1", value: "not an aggregate" })).toBe(true);
  });
});

group("summarising latency", () => {
  it("reports the middle and the tail, not just the mean", () => {
    const summary = summariseLatency([5, 1, 3, 2, 4]);
    expect(summary).toMatchObject({ samples: 5, medianMs: 3, minMs: 1, maxMs: 5 });
    expect(summary.p95Ms).toBeGreaterThanOrEqual(summary.medianMs);
  });

  it("returns zeros for no samples rather than dividing by zero", () => {
    expect(summariseLatency([])).toMatchObject({ samples: 0, medianMs: 0, p95Ms: 0 });
  });
});
