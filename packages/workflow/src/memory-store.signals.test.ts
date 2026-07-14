import { InMemoryWorkflowStore } from './memory-store.js';
import { describeSignalContract } from './conformance/index.js';

describeSignalContract(() => new InMemoryWorkflowStore());
