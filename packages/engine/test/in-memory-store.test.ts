import { InMemorySessionStore } from "../src/index.js";
import {
  runSessionStoreContract,
  runSubmissionLifecycleContract,
} from "../src/test-helpers/index.js";

runSessionStoreContract("InMemorySessionStore", {
  factory: () => new InMemorySessionStore(),
});

runSubmissionLifecycleContract("InMemorySessionStore", {
  factory: () => new InMemorySessionStore(),
});
