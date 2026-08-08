import type { AgentTier } from '@agentic-platform/runtime-contracts';

export function mayInvoke(parentTier: AgentTier, childTier: AgentTier): boolean {
  if (parentTier === 0) return childTier === 1;
  if (parentTier === 1) return childTier === 2;
  return false;
}

export function allowedChildTiers(parentTier: AgentTier): readonly AgentTier[] {
  return parentTier === 0 ? [1] : parentTier === 1 ? [2] : [];
}
