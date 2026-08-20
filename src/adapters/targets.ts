import type { AgentCapabilities, MaterializationStrategy } from '../core/materialization.js';

export interface TargetAdapter {
  readonly capabilities: AgentCapabilities;
}

export interface TargetRequest {
  system: string;
  prompt: string;
  responseFormat?: 'json';
}

export interface TargetResult {
  providerHandle?: string;
  model: string;
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ContextTargetAdapter extends TargetAdapter {
  readonly model: string;
  ask(request: TargetRequest): Promise<TargetResult>;
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
