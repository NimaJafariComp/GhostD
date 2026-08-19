import type { AgentCapabilities, MaterializationStrategy } from '../core/materialization.js';

export interface TargetAdapter {
  readonly capabilities: AgentCapabilities;
}

export function chooseMaterializationStrategy(capabilities: AgentCapabilities): MaterializationStrategy {
  if (capabilities.supportsNativeFork) {
    return 'native_fork';
  }
  if (capabilities.supportsSessionResume) {
    return 'session_resume';
  }
  return 'context_replay';
}
