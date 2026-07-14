// Fixture ValetPlugin manifest used by both the "registry-style static
// import" and "node_modules loader" sides of the loader-parity test in
// node-modules-loader.test.ts. Deliberately plain JS (no TypeBox schema
// import) so it can be dropped into a fixture node_modules dir unmodified.
export default {
  name: "sample-fixture",
  version: "1.2.3",
  actions: [
    {
      service: "sample-fixture",
      actions: [
        {
          id: "sample-fixture.do_thing",
          name: "Do Thing",
          description: "Does a thing.",
          riskLevel: "low",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ success: true }),
        },
      ],
    },
  ],
};
