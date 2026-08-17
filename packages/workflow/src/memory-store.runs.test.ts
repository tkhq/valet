import { InMemoryWorkflowStore } from './memory-store.js';
import { describeListRunsContract } from './conformance/index.js';

describeListRunsContract((clock) => new InMemoryWorkflowStore(clock));
