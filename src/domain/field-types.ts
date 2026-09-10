/**
 * The field types the Context Retriever engine accepts.
 *
 * `FieldDescription.type` is typed as a bare `string` in the SDK, so an invalid
 * value is a runtime rejection rather than a compile error. These seven names
 * are the engine's accepted set; several aliases (`string`, `integer`,
 * `vector`) are tolerated by the import validator but rejected by schema
 * inference, so they are deliberately absent.
 *
 * A vector index is only permitted on `FloatList`, never on a field declared
 * as some notional "vector" type.
 */
export const FieldType = {
  Str: "str",
  Int: "int",
  Float: "float",
  Bool: "bool",
  StrList: "list[str]",
  FloatList: "list[float]",
  Object: "object",
} as const;

export type FieldType = (typeof FieldType)[keyof typeof FieldType];
