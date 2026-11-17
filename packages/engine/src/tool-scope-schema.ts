import { Type } from "typebox";

export const toolScopeSchema = Type.Object({
  tools: Type.Optional(Type.Array(Type.String({ pattern: "^[a-zA-Z0-9_-]+$", maxLength: 200 }), {
    maxItems: 200,
    description: "Native tool names the child may use, such as read, edit, bash. Not integration services. Omit to keep every tool.",
  })),
  actions: Type.Optional(Type.Array(Type.String({ pattern: "^[a-zA-Z0-9_-]+\\.(?:[a-zA-Z0-9_.-]+|\\*)$", maxLength: 200 }), {
    maxItems: 200,
    description: "Integration actions the child may call, such as github.create_pull_request or github.*. Omit to keep every action.",
  })),
}, { additionalProperties: false });
