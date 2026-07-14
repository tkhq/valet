import { InMemoryWorkflowStore } from './memory-store.js';
import { describeOwnershipContract } from './conformance/index.js';

describeOwnershipContract(() => new InMemoryWorkflowStore());
