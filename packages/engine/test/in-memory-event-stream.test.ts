import { InMemoryEventStream } from "../src/index.js";
import { runEventStreamContract } from "../src/test-helpers/index.js";

runEventStreamContract("InMemoryEventStream", {
  factory: () => new InMemoryEventStream(),
});
