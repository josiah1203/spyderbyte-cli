import { InMemoryStateStore } from '../src/index.js';
import { registerStateContractSuite } from './state-contract-suite.js';

registerStateContractSuite('InMemoryStateStore', () => new InMemoryStateStore());
