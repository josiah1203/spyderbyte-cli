import type { ReactNode, ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, SectionLabel } from './primitives';
import Icon from './icons';
import type { Page } from '../data/profiles';
import {
  isPersonalLocalWorkspace,
  pageAvailability,
  pageDefinition,
} from '../runtime/page-registry';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

const CAPABILITY_LABELS: Record<string, string> = {
  'connectors.catalog': 'Connector catalog',
  'connectors.auth': 'Connector authorization',
  'connectors.discover': 'Connector discovery',
  'connectors.execute': 'Connector execution',
  'queries.execute': 'SQL execution',
  'notebooks.execute': 'Notebook execution',
  'visualizations.render': 'Visualization rendering',
  'pipelines.execute': 'Pipeline execution',
  'automations.schedule': 'Automation scheduling',
  'repositories.sync': 'Repository sync',
  'models.train': 'Model training',
  'experiments.lifecycle': 'Experiment lifecycle',
  'models.registry': 'Model registry',
  'deployments.serve': 'Deployment serving',
  'deployments.observe': 'Deployment health evidence',
  'deployments.invoke': 'Deployment invocation',
  'deployments.approval': 'Deployment rollout approval',
  'oauth-connections': 'Connection setup',
  'model-runtime': 'Model providers',
  'catalog-datasets': 'Data catalog',
  'artifact-catalog-lineage': 'Artifact catalog',
  'deployment-traffic': 'Deployment operations',
  'machine-state': 'Compute status',
};

function capabilityLabel(value: string): string {
  return (
    CAPABILITY_LABELS[value] ??
    value.replace(/[-_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

interface CapabilityGateProps {
  page: Page;
  children: ReactNode;
}

export default function CapabilityGate({ page, children }: CapabilityGateProps): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const navigate = useNavigate();
  const definition = pageDefinition(page);
  const availability = pageAvailability(page, snapshot.connection, snapshot.capabilities);

  if (availability.state === 'ready') return <>{children}</>;

  const loading = availability.state === 'loading';
  const unavailable = availability.state === 'unavailable';
  const missing = availability.missing.map(capabilityLabel).join(', ');
  const firstMissing = availability.missing[0];
  const settingsPath = definition.settingsPath ?? '/settings/workspace/general';
  const organizationSurface =
    isPersonalLocalWorkspace(snapshot.capabilities) && definition.organizationOnly === true;

  return (
    <div className="page-scroll">
      <div className="page page-narrow">
        <SectionLabel>{definition.label}</SectionLabel>
        <Card className="capability-card" data-capability-state={availability.state}>
          <div className="capability-header">
            <Badge color={loading ? 'blue' : unavailable ? 'gray' : 'amber'}>
              {organizationSurface
                ? 'Organization surface'
                : loading
                  ? 'Loading capability'
                  : unavailable
                    ? 'Platform unavailable'
                    : 'Enable to use'}
            </Badge>
            <span className="capability-projection">
              {missing ||
                definition.capabilities?.map(capabilityLabel).join(', ') ||
                'Platform capability'}
            </span>
          </div>
          <EmptyState
            icon={unavailable ? 'warning' : 'info'}
            title={
              loading
                ? 'Checking platform support…'
                : unavailable
                  ? 'Connect to the platform service to continue.'
                  : 'This workspace has not enabled this capability.'
            }
            description={
              organizationSurface
                ? 'This surface is intentionally hidden in a personal local workspace. Connect an organization workspace when you need policies, roles, or approval queues.'
                : loading
                  ? 'The page will become available as soon as the platform capability manifest is loaded.'
                  : ((firstMissing === undefined
                      ? undefined
                      : snapshot.capabilities?.capabilities[firstMissing]?.reason) ??
                    availability.reason ??
                    'Complete platform setup and retry. No placeholder data or no-op actions are shown.')
            }
            action={
              loading ? undefined : (
                <div className="capability-actions">
                  <Button variant="secondary" onClick={() => navigate(settingsPath)}>
                    Open settings <Icon name="arrow-right" size={14} aria-hidden="true" />
                  </Button>
                  <Button onClick={() => void runtime.retry()}>
                    Retry <Icon name="refresh" size={14} aria-hidden="true" />
                  </Button>
                </div>
              )
            }
          />
        </Card>
      </div>
    </div>
  );
}
