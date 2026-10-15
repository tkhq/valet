import { Type } from "typebox";

export const toolScopeSchema = Type.Object({
  tools: Type.Optional(Type.Array(Type.String({ pattern: "^[a-zA-Z0-9_-]+$", maxLength: 200 }), { maxItems: 200 })),
  actions: Type.Optional(Type.Array(Type.String({ pattern: "^[a-zA-Z0-9_-]+\\.(?:[a-zA-Z0-9_.-]+|\\*)$", maxLength: 200 }), { maxItems: 200 })),
}, { additionalProperties: false });
