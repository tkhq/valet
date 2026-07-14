import { InMemoryWorkflowStore } from './memory-store.js';
import { describeCheckpointContract } from './conformance/index.js';

describeCheckpointContract(() => new InMemoryWorkflowStore());
