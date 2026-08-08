import type { ReactElement } from 'react';
import { Badge, Card, EmptyState, SectionLabel } from '../components/primitives';
import type { IconName } from '../components/icons';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

interface CapabilityUnavailableProps {
  title: string;
  projection: string;
  description?: string;
}

const CAPABILITY_ICONS: Record<string, IconName> = {
  Approvals: 'check',
  Automations: 'automation',
  Audit: 'document',
  Catalog: 'catalog',
  Code: 'code',
  Connections: 'link',
  Data: 'database',
  Deployments: 'deploy',
  Environments: 'monitor',
  Experiments: 'flask',
  Governance: 'shield',
  Incidents: 'warning',
  Models: 'cube',
  Notebooks: 'notebook',
  Pipelines: 'pipeline',
  Repositories: 'repository',
  Resources: 'grid',
  Settings: 'settings',
  SQL: 'terminal',
  Visualizations: 'chart',
  Worktrees: 'git-branch',
};

export default function CapabilityUnavailable({
  title,
  projection,
  description,
}: CapabilityUnavailableProps): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const descriptor = snapshot.capabilities?.capabilities[projection];
  const enabled = descriptor?.enabled === true;
  return (
    <div className="page-scroll">
      <div className="page page-narrow">
        <SectionLabel>{title}</SectionLabel>
        <Card className="capability-card">
          <div className="capability-header">
            <Badge color={snapshot.connection === 'connected' && enabled ? 'amber' : 'gray'}>
              {snapshot.connection === 'booting' ? 'Loading capability' : 'Unavailable'}
            </Badge>
            <span className="capability-projection">Platform setup</span>
          </div>
          <EmptyState
            icon={CAPABILITY_ICONS[title] ?? (enabled ? 'info' : 'box')}
            title={description ?? `${title} is not enabled for the current platform configuration.`}
            description="This screen will remain empty until the platform capability is enabled. Complete platform setup, then retry."
          />
        </Card>
      </div>
    </div>
  );
}
