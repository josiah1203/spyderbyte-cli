import type { Id, JsonValue, RuntimeCommand, TenantRef } from '@agentic-platform/runtime-contracts';
import type { SubscriptionPage } from '@agentic-platform/runtime-domain';

export type WebPanel =
  | 'workflows'
  | 'approvals'
  | 'artifacts'
  | 'jobs'
  | 'cost'
  | 'data'
  | 'models'
  | 'deployments'
  | 'connectors'
  | 'audit'
  | 'chat';

export const webPanelLabels: Readonly<Record<WebPanel, string>> = {
  workflows: 'Workflows',
  approvals: 'Approvals',
  artifacts: 'Artifacts',
  jobs: 'Jobs',
  cost: 'Cost',
  data: 'Data',
  models: 'Models',
  deployments: 'Deployments',
  connectors: 'Connectors',
  audit: 'Audit',
  chat: 'Chat',
};

export type WebLicenseStatus = 'valid' | 'missing' | 'invalid' | 'expired' | 'not_yet_valid';

export interface WebLicenseSnapshot {
  readonly status: WebLicenseStatus;
  readonly reason: string;
  readonly checkedAt: string;
  readonly edition?: string;
  readonly licenseId?: string;
  readonly expiresAt?: string;
  readonly features?: readonly string[];
}

export interface WebProjectionState {
  readonly tenant: TenantRef;
  readonly workspaces: readonly TenantRef[];
  readonly cursor: number;
  readonly connected: boolean;
  readonly stale: boolean;
  readonly license?: WebLicenseSnapshot;
  readonly pendingPlan?: JsonValue;
  readonly workflows: Readonly<Record<string, JsonValue>>;
  readonly artifacts: Readonly<Record<string, JsonValue>>;
  readonly approvals: Readonly<Record<string, JsonValue>>;
  readonly jobs: Readonly<Record<string, JsonValue>>;
  readonly cost: Readonly<Record<string, JsonValue>>;
  readonly data: Readonly<Record<string, JsonValue>>;
  readonly models: Readonly<Record<string, JsonValue>>;
  readonly deployments: Readonly<Record<string, JsonValue>>;
  readonly connectors: Readonly<Record<string, JsonValue>>;
  readonly audit: Readonly<Record<string, JsonValue>>;
  readonly chat: Readonly<Record<string, JsonValue>>;
  readonly optimisticConflict?: {
    readonly artifactId: Id;
    readonly expectedVersion: number;
    readonly currentVersion?: number;
    readonly message: string;
  };
  readonly lastError?: string;
}

export interface ProjectionApi {
  query<T>(path: string): Promise<T>;
  command(command: RuntimeCommand): Promise<JsonValue>;
}

export const projectionNamesByPanel: Readonly<Record<WebPanel, string>> = {
  workflows: 'workflow-summary',
  approvals: 'approval-queue',
  artifacts: 'artifact-catalog-lineage',
  jobs: 'invocation-jobs',
  cost: 'budget-cost',
  data: 'catalog-datasets',
  models: 'model-lifecycle',
  deployments: 'deployment-traffic',
  connectors: 'connector-governance',
  audit: 'audit-timeline',
  chat: 'chat-sessions',
};

type JsonRecord = { [key: string]: JsonValue };

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function workspaceKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function initialProjectionState(
  tenant: TenantRef,
  workspaces: readonly TenantRef[] = [tenant],
): WebProjectionState {
  return {
    tenant,
    workspaces: [...workspaces],
    cursor: 0,
    connected: false,
    stale: false,
    workflows: {},
    artifacts: {},
    approvals: {},
    jobs: {},
    cost: {},
    data: {},
    models: {},
    deployments: {},
    connectors: {},
    audit: {},
    chat: {},
  };
}

function asRecord(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function objectCollection(value: JsonValue | undefined): Record<string, JsonValue> {
  const record = asRecord(value);
  if (record !== undefined) return record;
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(
    value.map((entry, index) => {
      const entryRecord = asRecord(entry);
      const key =
        typeof entryRecord?.['eventId'] === 'string' ? entryRecord['eventId'] : String(index);
      return [key, entry];
    }),
  );
}

function projectionCollection(panel: WebPanel, response: JsonValue): Record<string, JsonValue> {
  const root = asRecord(response) ?? {};
  const state = asRecord(root['state']) ?? root;
  const stateKey =
    panel === 'workflows'
      ? 'workflows'
      : panel === 'approvals'
        ? 'queue'
        : panel === 'artifacts'
          ? 'artifacts'
          : panel === 'jobs'
            ? 'jobs'
            : panel === 'cost'
              ? undefined
              : panel === 'data'
                ? 'datasets'
                : panel === 'models'
                  ? 'models'
                  : panel === 'deployments'
                    ? 'deployments'
                    : panel === 'connectors'
                      ? 'connectors'
                      : panel === 'chat'
                        ? 'sessions'
                        : panel === 'audit'
                          ? 'entries'
                          : undefined;
  return objectCollection(stateKey === undefined ? state : state[stateKey]);
}

export class ProjectionDrivenInteractionModel {
  private state: WebProjectionState;

  constructor(tenant: TenantRef) {
    this.state = initialProjectionState(tenant);
  }

  setWorkspaces(workspaces: readonly TenantRef[]): void {
    const unique = [
      ...new Map(workspaces.map((workspace) => [workspaceKey(workspace), workspace])).values(),
    ];
    if (unique.length === 0) throw new TypeError('At least one workspace is required');
    const selected =
      unique.find((workspace) => sameTenant(workspace, this.state.tenant)) ?? unique[0];
    if (selected === undefined) throw new TypeError('Workspace selection failed');
    const license = this.state.license;
    this.state = {
      ...initialProjectionState(selected, unique),
      connected: this.state.connected,
      ...(license === undefined ? {} : { license }),
    };
  }

  selectWorkspace(tenant: TenantRef): boolean {
    const selected = this.state.workspaces.find((workspace) => sameTenant(workspace, tenant));
    if (selected === undefined) return false;
    if (sameTenant(selected, this.state.tenant)) return true;
    const license = this.state.license;
    this.state = {
      ...initialProjectionState(selected, this.state.workspaces),
      connected: this.state.connected,
      ...(license === undefined ? {} : { license }),
    };
    return true;
  }

  connect(): void {
    this.state = { ...this.state, connected: true };
  }

  setLicenseStatus(status: WebLicenseSnapshot): void {
    this.state = { ...this.state, license: structuredClone(status) };
  }

  setPendingPlan(plan: JsonValue): void {
    this.state = { ...this.state, pendingPlan: structuredClone(plan) };
  }

  setPendingApproval(approval: JsonValue): void {
    const pending = asRecord(this.state.pendingPlan);
    if (pending === undefined) return;
    this.state = {
      ...this.state,
      pendingPlan: { ...pending, approval: structuredClone(approval) },
    };
  }

  clearPendingPlan(): void {
    const next = { ...this.state };
    delete next.pendingPlan;
    this.state = next;
  }

  disconnect(error?: string): void {
    this.state = {
      ...this.state,
      connected: false,
      ...(error !== undefined ? { lastError: error } : {}),
    };
  }

  applySubscription(page: SubscriptionPage): void {
    if (page.gapDetected || page.refreshRequired) {
      this.state = { ...this.state, stale: true, cursor: page.cursor };
      return;
    }
    if (page.cursor < this.state.cursor) return;
    const workflows = { ...this.state.workflows };
    const artifacts = { ...this.state.artifacts };
    const approvals = { ...this.state.approvals };
    const jobs = { ...this.state.jobs };
    const cost = { ...this.state.cost };
    const data = { ...this.state.data };
    const models = { ...this.state.models };
    const deployments = { ...this.state.deployments };
    const connectors = { ...this.state.connectors };
    const audit = { ...this.state.audit };
    const chat = { ...this.state.chat };
    const next = {
      ...this.state,
      cursor: page.cursor,
      connected: true,
      stale: false,
      workflows,
      artifacts,
      approvals,
      jobs,
      cost,
      data,
      models,
      deployments,
      connectors,
      audit,
      chat,
    };
    for (const event of page.events) {
      if (
        event.tenant.tenantId !== this.state.tenant.tenantId ||
        event.tenant.workspaceId !== this.state.tenant.workspaceId
      )
        continue;
      if (event.aggregateType === 'workflow')
        next.workflows[event.aggregateId] = { eventName: event.eventName, state: event.payload };
      if (event.aggregateType === 'artifact')
        next.artifacts[event.aggregateId] = { eventName: event.eventName, state: event.payload };
      if (event.aggregateType === 'approval')
        next.approvals[event.aggregateId] = { eventName: event.eventName, state: event.payload };
      if (event.aggregateType === 'invocation' || event.aggregateType === 'job')
        next.jobs[event.aggregateId] = { eventName: event.eventName, state: event.payload };
      if (event.aggregateType === 'budget' || event.aggregateType === 'cost')
        next.cost[event.aggregateId] = { eventName: event.eventName, state: event.payload };
      if (event.aggregateType === 'dataset' || event.aggregateType === 'catalog')
        next.data[event.aggregateId] = { eventName: event.eventName, state: event.payload };
      if (event.aggregateType === 'model')
        next.models[event.aggregateId] = { eventName: event.eventName, state: event.payload };
      if (event.aggregateType === 'deployment')
        next.deployments[event.aggregateId] = { eventName: event.eventName, state: event.payload };
      if (event.aggregateType === 'connector' || event.aggregateType === 'governance')
        next.connectors[event.aggregateId] = { eventName: event.eventName, state: event.payload };
      if (event.aggregateType === 'chat' || event.aggregateType === 'session')
        next.chat[event.aggregateId] = { eventName: event.eventName, state: event.payload };
    }
    this.state = next;
  }

  reconcile<T extends JsonValue>(projection: T): T {
    this.state = { ...this.state, stale: false };
    return projection;
  }

  applyProjection(panel: WebPanel, projection: JsonValue): void {
    const root = asRecord(projection);
    const cursor =
      root !== undefined && typeof root['cursor'] === 'number' ? root['cursor'] : undefined;
    this.state = {
      ...this.state,
      [panel]: projectionCollection(panel, projection),
      connected: true,
      stale: root?.['stale'] === true,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(root?.['lastError'] !== undefined && typeof root['lastError'] === 'string'
        ? { lastError: root['lastError'] }
        : {}),
    };
  }

  async loadProjection(api: ProjectionApi, panel: WebPanel): Promise<boolean> {
    const projectionName = projectionNamesByPanel[panel];
    if (projectionName === undefined) return false;
    const response = await api.query<JsonValue>(`/v1/projections/${projectionName}`);
    this.applyProjection(panel, response);
    return true;
  }

  async submitCommand(api: ProjectionApi, command: RuntimeCommand): Promise<JsonValue> {
    try {
      return await api.command(command);
    } catch (error) {
      if (isConflictError(error)) {
        const payload = asRecord(command.payload);
        const artifactId = payload?.['artifactId'];
        const expectedVersion = payload?.['expectedVersion'];
        if (
          typeof artifactId === 'string' &&
          typeof expectedVersion === 'number' &&
          Number.isSafeInteger(expectedVersion) &&
          expectedVersion >= 0
        ) {
          const message = error instanceof Error ? error.message : String(error);
          const currentVersionMatch = /(?:actual|current version)\s+(\d+)/i.exec(message);
          this.noteOptimisticConflict({
            artifactId: artifactId as Id,
            expectedVersion,
            ...(currentVersionMatch?.[1] === undefined
              ? {}
              : { currentVersion: Number(currentVersionMatch[1]) }),
            message:
              'This artifact changed in another session. Review the current version before retrying.',
          });
        }
      }
      throw error;
    }
  }

  noteOptimisticConflict(input: {
    artifactId: Id;
    expectedVersion: number;
    currentVersion?: number;
    message?: string;
  }): void {
    this.state = {
      ...this.state,
      optimisticConflict: {
        artifactId: input.artifactId,
        expectedVersion: input.expectedVersion,
        ...(input.currentVersion !== undefined ? { currentVersion: input.currentVersion } : {}),
        message:
          input.message ??
          'This artifact changed in another session. Review the current version before retrying.',
      },
    };
  }

  clearOptimisticConflict(): void {
    const next = { ...this.state };
    delete next.optimisticConflict;
    this.state = next;
  }

  snapshot(): WebProjectionState {
    return structuredClone(this.state);
  }

  buildOptimisticEditCommand(input: {
    artifactId: Id;
    expectedVersion: number;
    content: JsonValue;
    commandId: Id;
    correlationId: Id;
    actor: RuntimeCommand['actor'];
    issuedAt: string;
    idempotencyKey: string;
  }): RuntimeCommand {
    return {
      schemaVersion: 1,
      commandId: input.commandId,
      commandType: 'ArtifactVersionCreate',
      tenant: this.state.tenant,
      actor: input.actor,
      issuedAt: input.issuedAt,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      payload: {
        artifactId: input.artifactId,
        expectedVersion: input.expectedVersion,
        content: input.content,
      },
    };
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}

function panelCount(snapshot: WebProjectionState | undefined, panel: WebPanel): number {
  return snapshot === undefined ? 0 : Object.keys(snapshot[panel]).length;
}

function panelPreview(snapshot: WebProjectionState | undefined, panel: WebPanel): string {
  if (snapshot === undefined) return 'No projection loaded yet.';
  const value = JSON.stringify(snapshot[panel]);
  return value === undefined ? 'No projection loaded yet.' : value;
}

function workspaceLabel(tenant: TenantRef): string {
  return `${tenant.tenantId} / ${tenant.workspaceId}`;
}

export interface WebShellActions {
  readonly workspaceExport?: boolean;
  readonly workspaceBackup?: boolean;
  readonly workspaceImport?: boolean;
  readonly runPlanned?: boolean;
  readonly approvePlan?: boolean;
  readonly rejectPlan?: boolean;
}

function workflowPlanReview(
  activePanel: WebPanel,
  snapshot: WebProjectionState | undefined,
  actions: WebShellActions,
): string {
  if (activePanel !== 'workflows' || snapshot?.pendingPlan === undefined) return '';
  const pending = asRecord(snapshot.pendingPlan);
  const workflowId = pending?.['workflowId'];
  const planVersion = pending?.['planVersion'];
  const plan = asRecord(pending?.['plan']);
  const steps = plan?.['steps'];
  if (
    typeof workflowId !== 'string' ||
    typeof planVersion !== 'number' ||
    !Number.isSafeInteger(planVersion) ||
    !Array.isArray(steps)
  )
    return '';
  const approval = asRecord(pending?.['approval']);
  const approvalId = approval?.['approvalId'];
  const approvalState = approval?.['state'];
  const approvalRequired =
    approval !== undefined || steps.some((step) => asRecord(step)?.['approvalRequired'] === true);
  const approved = !approvalRequired || approvalState === 'approved';
  const runDisabled = actions.runPlanned !== true || !approved ? ' disabled' : '';
  const approvalLabel = !approvalRequired
    ? 'Not required'
    : approvalState === 'approved'
      ? 'Approved'
      : approvalState === 'pending'
        ? 'Pending review'
        : approvalState === undefined
          ? 'Unavailable'
          : String(approvalState);
  const approvalButtons =
    typeof approvalId !== 'string' || approvalState !== 'pending'
      ? ''
      : `<div class="vibe-plan-actions"><button class="vibe-button tertiary" type="button" data-action="approve-plan"${actions.approvePlan === true ? '' : ' disabled'}>Approve plan</button><button class="vibe-button tertiary" type="button" data-action="reject-plan"${actions.rejectPlan === true ? '' : ' disabled'}>Reject plan</button></div>`;
  return `<section class="vibe-card vibe-plan-review" data-plan-review="${escapeHtml(workflowId)}"><div class="vibe-card-heading"><div><span class="vibe-overline">Typed plan ready</span><h3>Review before execution</h3></div><span class="vibe-badge ${approved ? 'positive' : 'warning'}">Plan v${planVersion}</span></div><dl class="vibe-definition-list"><div><dt>Workflow</dt><dd>${escapeHtml(workflowId)}</dd></div><div><dt>Governed steps</dt><dd>${steps.length}</dd></div><div><dt>Approval</dt><dd>${escapeHtml(approvalLabel)}</dd></div><div><dt>Execution state</dt><dd>${approvalState === 'approved' ? 'Ready to run' : 'Awaiting review'}</dd></div></dl>${approvalButtons}<button class="vibe-button primary" type="button" data-action="run-planned"${runDisabled}>Run approved plan</button><small class="vibe-form-help">The plan is authoritative and immutable for this workflow. Review the steps above before execution.</small></section>`;
}

function workspaceStorageControls(actions: WebShellActions): string {
  const exportDisabled = actions.workspaceExport === true ? '' : ' disabled';
  const backupDisabled = actions.workspaceBackup === true ? '' : ' disabled';
  const importDisabled = actions.workspaceImport === true ? '' : ' disabled';
  return `<section class="vibe-details-section vibe-storage-section"><span class="vibe-overline">Storage</span><p class="vibe-detail-value">Portable workspace</p><div class="vibe-storage-actions"><button class="vibe-button tertiary" type="button" data-action="export-workspace"${exportDisabled}>Export archive</button><button class="vibe-button tertiary" type="button" data-action="backup-workspace"${backupDisabled}>Back up</button><button class="vibe-button tertiary" type="button" data-action="import-workspace"${importDisabled}>Import archive</button></div><small>Archives are checksummed; backups create a durable snapshot, and restores are previewed before import.</small></section>`;
}

interface PrototypeUiState {
  readonly sidebarOpen: boolean;
  readonly drawerOpen: boolean;
  readonly workspaceOpen: boolean;
  readonly analyzeOpen: boolean;
  readonly activeFile: string;
  readonly resultTab: 'Results' | 'Chart';
  readonly query: string;
  readonly saved: boolean;
  readonly objectiveOpen: boolean;
  readonly settingsOpen: boolean;
  readonly activeSetting: string;
  readonly profileOpen: boolean;
  readonly runState: 'Ready' | 'Running' | 'Succeeded' | 'Failed';
  readonly toast: string | undefined;
}

function defaultPrototypeUiState(): PrototypeUiState {
  return {
    sidebarOpen: true,
    drawerOpen: true,
    workspaceOpen: true,
    analyzeOpen: true,
    activeFile: 'Churn investigation',
    resultTab: 'Results',
    query: '',
    saved: false,
    objectiveOpen: false,
    settingsOpen: false,
    activeSetting: 'General',
    profileOpen: false,
    runState: 'Ready',
    toast: undefined,
  };
}

const prototypeResultHeaders: ReadonlyArray<readonly [string, string]> = [
  ['customer_id', 'string'],
  ['tenure_months', 'int'],
  ['contract_type', 'string'],
  ['monthly_charges', 'decimal(10,2)'],
  ['total_charges', 'decimal(10,2)'],
  ['churn_flag', 'boolean'],
  ['churn_date', 'date'],
];

const prototypeResultRows: ReadonlyArray<readonly string[]> = [
  ['CUST0001', '14', 'Month-to-month', '89.99', '1,259.86', 'true', '2024-04-12'],
  ['CUST0002', '3', 'Month-to-month', '109.50', '328.50', 'true', '2024-04-15'],
  ['CUST0003', '22', 'One year', '74.00', '1,628.00', 'true', '2024-04-18'],
  ['CUST0004', '6', 'Month-to-month', '95.00', '570.00', 'true', '2024-04-20'],
  ['CUST0005', '18', 'Two year', '64.99', '1,169.82', 'true', '2024-04-22'],
  ['CUST0006', '1', 'Month-to-month', '120.00', '120.00', 'true', '2024-04-25'],
  ['CUST0007', '11', 'Month-to-month', '79.50', '874.50', 'true', '2024-04-27'],
  ['CUST0008', '24', 'One year', '69.00', '1,656.00', 'true', '2024-04-29'],
];

const prototypeSettingsGroups: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'Application',
    ['General', 'Import', 'Appearance', 'Voice', 'Keyboard shortcuts', 'App snapshots'],
  ],
  ['Personal', ['Profile', 'Personalization', 'Pets']],
  ['Extensions', ['Plugins & connectors', 'Hooks']],
  ['Development', ['Git', 'Environment', 'Worktrees', 'Configuration']],
  ['Account', ['Usage & billing', 'Account']],
];

const prototypeFlowStages: ReadonlyArray<readonly [string, string]> = [
  ['workflows', 'Workspace'],
  ['connectors', 'Provider'],
  ['chat', 'Objective'],
  ['approvals', 'Plan review'],
  ['jobs', 'Live run'],
  ['artifacts', 'Artifacts'],
  ['data', 'Storage'],
  ['audit', 'Settings'],
];

function prototypeIcon(name: string): string {
  const glyphs: Readonly<Record<string, string>> = {
    arrow: '↘',
    chart: '⌁',
    check: '✓',
    columns: '▦',
    database: '▤',
    down: '⌄',
    file: '▱',
    folder: '▰',
    gear: '⚙',
    left: '‹',
    more: '•••',
    play: '▶',
    plus: '+',
    recent: '◷',
    right: '›',
    rows: '▥',
    search: '⌕',
    stack: '▥',
    star: '☆',
    x: '×',
  };
  return `<span class="ui-icon ui-icon-${escapeHtml(name)}" aria-hidden="true">${glyphs[name] ?? '•'}</span>`;
}

function prototypeStatusLabel(uiState: PrototypeUiState, snapshot?: WebProjectionState): string {
  if (uiState.runState === 'Running') return 'Running';
  if (uiState.runState === 'Succeeded') return 'Succeeded';
  if (uiState.runState === 'Failed') return 'Failed';
  if (Object.keys(snapshot?.jobs ?? {}).length > 0) return 'Synchronized';
  return 'Ready';
}

function prototypeRunId(snapshot?: WebProjectionState): string {
  const firstJob = Object.keys(snapshot?.jobs ?? {})[0];
  return firstJob === undefined ? 'Not started' : firstJob;
}

function prototypeLicenseMessage(license: WebLicenseSnapshot | undefined): string {
  if (license === undefined) return 'Checking license…';
  if (license.status === 'valid') {
    return license.expiresAt === undefined ? 'Licensed' : `Licensed until ${license.expiresAt}`;
  }
  return `License ${license.status.replaceAll('_', ' ')}`;
}

function prototypeWorkspacePicker(
  snapshot: WebProjectionState | undefined,
  workspaces: readonly TenantRef[],
): string {
  if (workspaces.length === 0) return '<span class="prototype-empty">No workspace selected</span>';
  return `<label class="vibe-field-label" for="workspace-selector">Workspace</label><select id="workspace-selector" data-action="select-workspace" aria-label="Select workspace">${workspaces
    .map(
      (workspace, index) =>
        `<option value="${index}"${snapshot !== undefined && sameTenant(workspace, snapshot.tenant) ? ' selected' : ''}>${escapeHtml(workspaceLabel(workspace))}</option>`,
    )
    .join('')}</select>`;
}

function prototypeTree(activePanel: WebPanel, uiState: PrototypeUiState): string {
  const workspaceBranch = uiState.workspaceOpen
    ? `<div class="tree-branch"><button class="tree-row" style="--tree-level:1" type="button" data-action="notify" data-message="Data catalog opened"><span class="ui-icon ui-icon-caret" aria-hidden="true">›</span>${prototypeIcon('database')}<span>Data</span></button><button class="tree-row" style="--tree-level:1" type="button" data-action="toggle-analyze" aria-expanded="${uiState.analyzeOpen}"><span class="ui-icon ui-icon-caret" aria-hidden="true">${uiState.analyzeOpen ? '⌄' : '›'}</span>${prototypeIcon('folder')}<span>Analyze</span></button>${uiState.analyzeOpen ? `<div class="tree-branch nested"><a class="tree-row${activePanel === 'workflows' && uiState.activeFile === 'Churn investigation' ? ' active' : ''}" style="--tree-level:2" href="#workflows" data-panel-link="workflows"><span class="tree-spacer"></span>${prototypeIcon('file')}<span>Churn investigation</span></a><a class="tree-row${activePanel === 'artifacts' ? ' active' : ''}" style="--tree-level:2" href="#artifacts" data-panel-link="artifacts"><span class="tree-spacer"></span>${prototypeIcon('file')}<span>Segment comparison</span></a></div>` : ''}<button class="tree-row" style="--tree-level:1" type="button" data-action="notify" data-message="Build view opened"><span class="ui-icon ui-icon-caret" aria-hidden="true">›</span>${prototypeIcon('stack')}<span>Build</span></button><button class="tree-row" style="--tree-level:1" type="button" data-action="notify" data-message="Deploy view opened"><span class="ui-icon ui-icon-caret" aria-hidden="true">›</span>${prototypeIcon('arrow')}<span>Deploy</span></button><button class="tree-row" style="--tree-level:1" type="button" data-action="notify" data-message="Monitor view opened"><span class="ui-icon ui-icon-caret" aria-hidden="true">›</span>${prototypeIcon('chart')}<span>Monitor</span></button></div>`
    : '';
  return `<button class="tree-row${uiState.workspaceOpen ? '' : ''}" type="button" data-action="toggle-workspace" aria-expanded="${uiState.workspaceOpen}"><span class="ui-icon ui-icon-caret" aria-hidden="true">${uiState.workspaceOpen ? '⌄' : '›'}</span>${prototypeIcon('database')}<span>Customer Churn</span></button>${workspaceBranch}<button class="tree-row" type="button" data-action="notify" data-message="Forecasting view opened"><span class="ui-icon ui-icon-caret" aria-hidden="true">›</span>${prototypeIcon('stack')}<span>Forecasting</span></button>`;
}

function prototypeNavigation(activePanel: WebPanel): string {
  return (Object.keys(webPanelLabels) as WebPanel[])
    .map(
      (panel) =>
        `<a href="#${panel}" class="${panel === activePanel ? 'active' : ''}" data-panel-link="${panel}" aria-current="${panel === activePanel ? 'page' : 'false'}">${prototypeIcon(panel === 'jobs' ? 'play' : panel === 'data' ? 'columns' : 'stack')}<span>${webPanelLabels[panel]}</span></a>`,
    )
    .join('');
}

function prototypeSql(): string {
  return `<span class="keyword">SELECT</span>\n    c.customer_id,\n    c.tenure_months,\n    c.contract_type,\n    c.monthly_charges,\n    c.total_charges,\n    c.churn_flag,\n    c.churn_date\n<span class="keyword">FROM</span>\n    dwh.customer_churn c\n<span class="keyword">WHERE</span>\n    c.churn_date &gt;= <span class="function">DATEADD</span>(month, -3, <span class="function">CURRENT_DATE</span>)`;
}

function prototypeResults(query: string): string {
  const term = query.trim().toLowerCase();
  const rows =
    term.length === 0
      ? prototypeResultRows
      : prototypeResultRows.filter((row) => row.some((cell) => cell.toLowerCase().includes(term)));
  const table =
    rows.length === 0
      ? '<div class="empty-state"><strong>No matching rows</strong><span>Try a different customer ID or contract type.</span></div>'
      : `<table class="prototype-results-table"><thead><tr>${prototypeResultHeaders.map(([label, type]) => `<th><strong>${label}</strong><small>${type}</small></th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return `<div class="results-toolbar"><span data-result-count>${term.length === 0 ? 'Preview · 1,000 rows' : `${rows.length} preview matches`}</span><label class="search-field">${prototypeIcon('search')}<input data-action="results-search" data-focus-key="results-search" value="${escapeHtml(query)}" placeholder="Search results..." aria-label="Search results" /></label><span class="toolbar-fill"></span><button type="button" data-action="notify" data-message="Export is available from the artifact view">${prototypeIcon('down')}Download</button><button type="button" data-action="notify" data-message="Column chooser opened">${prototypeIcon('columns')}Columns</button></div><div class="table-wrap" data-results-table>${table}</div><div class="pagination"><button type="button" disabled aria-label="Previous page">‹</button><button type="button" class="active">1</button><button type="button">2</button><button type="button">3</button><button type="button">4</button><button type="button">5</button><span aria-hidden="true">…</span><button type="button">50</button><button type="button" aria-label="Next page">›</button><span class="page-total">Preview rows · connect a provider for live results</span></div>`;
}

function prototypeChart(): string {
  return `<div class="chart-view"><div><strong>Churn by contract type</strong><span>Design preview · live provider execution is not connected yet</span></div><label><span>Month-to-month</span><meter min="0" max="100" value="78"></meter><strong>78%</strong></label><label><span>One year</span><meter min="0" max="100" value="42"></meter><strong>42%</strong></label><label><span>Two year</span><meter min="0" max="100" value="24"></meter><strong>24%</strong></label></div>`;
}

function prototypeFlowMap(activePanel: WebPanel): string {
  return `<nav class="prototype-flow-map" aria-label="Spyderbyte flow">${prototypeFlowStages.map(([panel, label]) => `<a href="#${panel}" class="${panel === activePanel ? 'active' : ''}" data-panel-link="${panel}">${label}</a>`).join('')}</nav>`;
}

function prototypeObjectiveComposer(snapshot: WebProjectionState | undefined): string {
  const disabled = snapshot?.license?.status === 'valid' ? '' : ' disabled';
  return `<form class="objective-card" data-action="run-dataset"><div><span class="vibe-overline">Objective → typed plan</span><h2>Start a governed local workflow</h2></div><label class="vibe-field-label" for="dataset-objective">Objective</label><textarea class="vibe-textarea" id="dataset-objective" name="objective" rows="3" placeholder="Describe what this dataset should be used for">Validate this dataset for local analysis</textarea><label class="vibe-field-label" for="dataset-file">Source dataset</label><input class="vibe-file-input vibe-file-input-visible" id="dataset-file" name="dataset" type="file" accept=".csv,text/csv" required /><div class="objective-actions"><button class="vibe-button primary" type="submit"${disabled}>Create validation plan</button><small class="vibe-form-help">The file is staged locally, published as an immutable artifact, and converted into a typed plan for review.</small></div></form>`;
}

function prototypeFlowPanel(
  activePanel: WebPanel,
  snapshot: WebProjectionState | undefined,
  actions: WebShellActions,
  uiState: PrototypeUiState,
): string {
  const preview = escapeHtml(panelPreview(snapshot, activePanel));
  const titles: Readonly<Record<WebPanel, readonly [string, string]>> = {
    workflows: [
      'Workflow overview',
      'Objective, plan, approval, and local execution state converge here.',
    ],
    approvals: [
      'Plan review',
      'Review the exact typed plan and approval state before any effectful run.',
    ],
    artifacts: [
      'Artifacts and lineage',
      'Immutable local artifacts, versions, conflicts, and export remain authoritative.',
    ],
    jobs: [
      'Live runs',
      'Reconnectable projections report run state, logs, cost, and recovery status.',
    ],
    cost: [
      'Cost and budget',
      'Local usage and budget signals are shown without a hosted billing dependency.',
    ],
    data: [
      'Data and storage',
      'Catalog, workspace portability, backup, and restore are local-first flows.',
    ],
    models: [
      'Provider and model setup',
      'Provider execution is the remaining live-model gate; credentials belong in Keychain.',
    ],
    deployments: [
      'Deployments',
      'Promotion and rollout remain approval-gated and projection-backed.',
    ],
    connectors: [
      'Provider connections',
      'Connectors are configured through scoped local credentials, never raw model context.',
    ],
    audit: [
      'Diagnostics and audit',
      'Inspect cursor health, license checks, restart recovery, and append-only activity.',
    ],
    chat: [
      'Objective entry',
      'Capture the user objective and turn it into a typed, reviewable plan.',
    ],
  };
  const [title, description] = titles[activePanel];
  const planReview =
    activePanel === 'approvals' ? workflowPlanReview('workflows', snapshot, actions) : '';
  const objective =
    activePanel === 'chat' || (activePanel === 'workflows' && uiState.objectiveOpen)
      ? prototypeObjectiveComposer(snapshot)
      : '';
  const conflict =
    snapshot?.optimisticConflict === undefined
      ? ''
      : `<div class="prototype-alert" role="alert" data-optimistic-conflict="${escapeHtml(snapshot.optimisticConflict.artifactId)}"><strong>Version conflict.</strong><span>${escapeHtml(snapshot.optimisticConflict.message)} Expected version ${snapshot.optimisticConflict.expectedVersion}${snapshot.optimisticConflict.currentVersion === undefined ? '' : `; current version ${snapshot.optimisticConflict.currentVersion}`}. </span></div>`;
  return `${prototypeFlowMap(activePanel)}${objective}${planReview}${conflict}<section id="panel" class="prototype-panel" tabindex="-1" aria-labelledby="panel-title" aria-live="polite" data-panel="${activePanel}"><div class="prototype-panel-heading"><span class="vibe-overline">Spyderbyte flow</span><h2 id="panel-title">${title}</h2><p>${description}</p></div><div class="prototype-panel-grid"><article class="vibe-card"><div class="vibe-card-heading"><div><span class="vibe-overline">Authoritative projection</span><h3>${webPanelLabels[activePanel]}</h3></div><span class="vibe-badge ${snapshot?.stale ? 'warning' : 'positive'}">${snapshot?.stale ? 'Refresh required' : 'Projection'}</span></div><pre aria-label="${webPanelLabels[activePanel]} projection">${preview}</pre></article><article class="vibe-card"><span class="vibe-overline">Flow checkpoint</span><h3>${prototypeStatusLabel(uiState, snapshot)}</h3><dl class="vibe-definition-list"><div><dt>Connection</dt><dd>${snapshot?.stale ? 'Stale' : snapshot?.connected === false ? 'Disconnected' : 'Connected'}</dd></div><div><dt>Cursor</dt><dd>${snapshot?.cursor ?? 0}</dd></div><div><dt>Records</dt><dd>${panelCount(snapshot, activePanel)}</dd></div><div><dt>Execution</dt><dd>${activePanel === 'models' || activePanel === 'connectors' ? 'Provider pending' : 'Local'}</dd></div></dl></article></div></section>`;
}

function prototypeSettings(uiState: PrototypeUiState): string {
  if (!uiState.settingsOpen) return '';
  const groups = prototypeSettingsGroups
    .map(
      ([group, items]) =>
        `<div><h3>${group}</h3>${items.map((item) => `<button type="button" class="${uiState.activeSetting === item ? 'active' : ''}" data-action="settings-select" data-setting="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('')}</div>`,
    )
    .join('');
  return `<div class="modal-backdrop" data-action="settings-backdrop" role="presentation"><section class="settings-modal" role="dialog" aria-modal="true" aria-label="Settings"><header><div>${prototypeIcon('gear')}<h2>Settings</h2></div><button class="icon-button" type="button" aria-label="Close settings" data-action="settings-close">${prototypeIcon('x')}</button></header><div class="settings-layout"><nav aria-label="Settings sections">${groups}</nav><div class="settings-content"><span class="eyebrow">Settings / ${escapeHtml(uiState.activeSetting)}</span><h2>${escapeHtml(uiState.activeSetting)}</h2><p>Configure ${escapeHtml(uiState.activeSetting.toLowerCase())} for the Spyderbyte workspace.</p><div class="setting-form"><label><span>Default workspace</span><select><option>Customer Churn</option><option>Forecasting</option></select></label><label><span>License</span><span class="license-chip">Offline entitlement</span></label><label><span>Open links</span><select><option>Current window</option><option>New window</option></select></label><label class="switch-row"><span><strong>Restore recent work</strong><small>Reopen the last active workspace when the app starts.</small></span><input type="checkbox" checked /></label></div></div></div></section></div>`;
}

function prototypeWorkflowCanvas(
  snapshot: WebProjectionState | undefined,
  actions: WebShellActions,
  uiState: PrototypeUiState,
): string {
  const license = snapshot?.license;
  const licenseStatus = license?.status ?? 'unchecked';
  const licenseMessage = prototypeLicenseMessage(license);
  const licenseBanner =
    license !== undefined && license.status === 'valid'
      ? ''
      : `<div class="prototype-alert" role="alert" data-license-status="${licenseStatus}"><strong>Spyderbyte license required.</strong><span>${escapeHtml(licenseMessage)}${license === undefined ? '' : ` · ${escapeHtml(license.reason)}`}</span><button class="vibe-button tertiary" type="button" data-action="import-license">Import license</button><input class="vibe-file-input" type="file" accept="application/json,.json" data-action="import-license-file" aria-label="Choose a signed Spyderbyte license" /></div>`;
  const planReview = workflowPlanReview('workflows', snapshot, actions);
  const objective = uiState.objectiveOpen ? prototypeObjectiveComposer(snapshot) : '';
  return `${prototypeFlowMap('workflows')}${licenseBanner}${objective}${planReview}<section class="editor" aria-label="SQL preview"><div class="line-numbers" aria-hidden="true">${Array.from({ length: 11 }, (_, index) => `<span>${index + 1}</span>`).join('')}</div><pre class="sql-code"><code>${prototypeSql()}</code></pre><div class="editor-toolbar"><button type="button" data-action="notify" data-message="The SQL surface is read-only until query persistence and artifact versioning are connected">${prototypeIcon('database')}dwh${prototypeIcon('down')}</button><button type="button" data-action="notify" data-message="Result limits will be enabled with live provider execution">No limit${prototypeIcon('down')}</button><span></span><button type="button" data-action="notify" data-message="SQL formatting will be enabled with the persisted editor">Format <kbd>⌘⇧F</kbd></button><button class="icon-button" type="button" aria-label="Expand editor" data-action="notify" data-message="Editor expansion is planned for the persisted SQL surface">${prototypeIcon('arrow')}</button></div></section><section class="results-section"><div class="tabs" role="tablist"><button type="button" role="tab" aria-selected="${uiState.resultTab === 'Results'}" class="${uiState.resultTab === 'Results' ? 'active' : ''}" data-action="result-tab" data-result-tab="Results">Results</button><button type="button" role="tab" aria-selected="${uiState.resultTab === 'Chart'}" class="${uiState.resultTab === 'Chart' ? 'active' : ''}" data-action="result-tab" data-result-tab="Chart">Chart</button></div>${uiState.resultTab === 'Results' ? prototypeResults(uiState.query) : prototypeChart()}</section><div class="prototype-preview-note"><span class="vibe-badge warning">Preview only</span><span>This screen is the supplied wireframe target. Results are non-authoritative preview content; SQL execution is unavailable until persistence, provider execution, and artifact versioning are implemented.</span><button class="run-button" type="button" disabled aria-label="SQL execution unavailable">${prototypeIcon('play')}Run unavailable</button></div>`;
}

function prototypeDetails(
  activePanel: WebPanel,
  snapshot: WebProjectionState | undefined,
  actions: WebShellActions,
  uiState: PrototypeUiState,
): string {
  const license = snapshot?.license;
  const licenseStatus = license?.status ?? 'unchecked';
  const licenseMessage = prototypeLicenseMessage(license);
  const runState = prototypeStatusLabel(uiState, snapshot);
  const statusTone =
    runState === 'Failed' ? 'negative' : runState === 'Running' ? 'running' : 'positive';
  const providerState =
    activePanel === 'models' || activePanel === 'connectors' ? 'Setup required' : 'Not configured';
  return `<aside class="details-drawer" aria-label="Run details"><div class="drawer-header"><button class="icon-button" type="button" aria-label="Collapse run details" data-action="collapse-drawer">${prototypeIcon('right')}</button><button class="icon-button" type="button" aria-label="Close run details" data-action="collapse-drawer">${prototypeIcon('x')}</button></div><section><h2>Run details</h2><dl><div><dt>Status</dt><dd><span class="status-dot ${statusTone}"></span>${runState}</dd></div><div><dt>Run ID</dt><dd class="mono">${escapeHtml(prototypeRunId(snapshot))}</dd></div><div><dt>Started</dt><dd>${runState === 'Ready' ? 'Not started' : 'Local session'}</dd></div><div><dt>Duration</dt><dd>${runState === 'Running' ? 'In progress' : runState === 'Succeeded' ? 'Authoritative' : '—'}</dd></div><div><dt>Rows returned</dt><dd>${runState === 'Succeeded' ? 'Projection-backed' : 'Preview'}</dd></div></dl></section><section><h2>Provider and model</h2><dl><div><dt>Provider</dt><dd>${providerState}</dd></div><div><dt>Credential</dt><dd>macOS Keychain</dd></div><div><dt>Execution</dt><dd>${activePanel === 'models' || activePanel === 'connectors' ? 'Pending' : 'Local runtime'}</dd></div></dl><small>Provider secrets never enter the webview or model context.</small></section><section><h2>Related datasets</h2><ul class="dataset-list"><li>${prototypeIcon('database')}<a href="#data" data-panel-link="data">dwh.customer_churn ↗</a></li><li>${prototypeIcon('database')}<a href="#data" data-panel-link="data">dwh.customers ↗</a></li><li>${prototypeIcon('database')}<a href="#data" data-panel-link="data">dwh.billing_history ↗</a></li></ul></section><section><div class="section-title-row"><h2>Recent runs</h2><button type="button" data-panel-link="jobs">View all</button></div><ul class="recent-runs"><li><span class="status-dot"></span><span>Projection ready</span><span>—</span><time>Local</time></li><li><span class="status-dot warning"></span><span>Provider pending</span><span>—</span><time>Next</time></li></ul></section><section><h2>Spyderbyte</h2><dl><div><dt>License</dt><dd data-license-detail="${licenseStatus}">${escapeHtml(licenseMessage)}</dd></div><div><dt>Workspace</dt><dd>${snapshot === undefined ? 'Not selected' : escapeHtml(workspaceLabel(snapshot.tenant))}</dd></div><div><dt>Cursor</dt><dd>${snapshot?.cursor ?? 0}</dd></div></dl><button class="vibe-button tertiary" type="button" data-action="import-license">Import license</button><input class="vibe-file-input" type="file" accept="application/json,.json" data-action="import-license-file" aria-label="Choose a signed Spyderbyte license" /></section>${workspaceStorageControls(actions)}<section><span class="vibe-overline">Flow map</span><p class="vibe-detail-value">First-run → provider → objective → plan → run → artifact</p><small>Settings, backup, and diagnostics are available from the workspace footer.</small></section></aside>`;
}

export function renderAccessibleShell(
  activePanel: WebPanel,
  snapshot?: WebProjectionState,
  actions: WebShellActions = {},
  uiState: PrototypeUiState = defaultPrototypeUiState(),
): string {
  const connection = snapshot?.stale
    ? 'Stale — refresh required'
    : snapshot?.connected === false
      ? 'Disconnected'
      : 'Connected';
  const workspaces = snapshot?.workspaces ?? (snapshot === undefined ? [] : [snapshot.tenant]);
  const license = snapshot?.license;
  const licenseStatus = license?.status ?? 'unchecked';
  const licenseMessage = prototypeLicenseMessage(license);
  const sidebar = `<aside class="sidebar" aria-label="Workspace navigation"><div class="sidebar-top"><div class="prototype-brand"><strong>Spyderbyte</strong><small>Spyderbyte</small></div><button class="icon-button" type="button" aria-label="Collapse sidebar" data-action="collapse-sidebar">${prototypeIcon('left')}</button></div><button class="new-button" type="button" data-action="new-analysis">${prototypeIcon('plus')}<span>New</span></button><nav class="primary-nav" aria-label="Primary"><button type="button" data-action="notify" data-message="Search is ready for the local workspace">${prototypeIcon('search')}<span>Search</span></button><button type="button" data-action="notify" data-message="Recent local work opened">${prototypeIcon('recent')}<span>Recents</span></button></nav><div class="rule"></div><div class="section-label"><span>Workspaces</span><button class="icon-button" type="button" aria-label="Add workspace" data-action="new-workspace">${prototypeIcon('plus')}</button></div><div class="workspace-selector">${prototypeWorkspacePicker(snapshot, workspaces)}</div><div class="tree">${prototypeTree(activePanel, uiState)}</div><div class="rule lower"></div><nav class="utility-nav" aria-label="Global resources"><a href="#jobs" data-panel-link="jobs">${prototypeIcon('play')}<span>Runs</span></a><a href="#data" data-panel-link="data">${prototypeIcon('columns')}<span>Catalog</span></a></nav><nav class="prototype-view-nav" aria-label="Primary navigation">${prototypeNavigation(activePanel)}</nav><div class="sidebar-footer"><button class="settings-link" type="button" data-action="settings-open">${prototypeIcon('gear')}<span>Settings</span></button><div class="runtime-chip"><span class="status-dot ${snapshot?.stale ? 'warning' : snapshot?.connected === false ? 'negative' : 'positive'}"></span><span role="status" aria-live="polite">${connection}</span></div><div class="profile-wrap"><button class="profile-button" type="button" data-action="profile-toggle" aria-expanded="${uiState.profileOpen}"><span class="avatar">A</span><span class="profile-copy"><strong>Spyderbyte user</strong><small>${escapeHtml(workspaceLabel(snapshot?.tenant ?? workspaces[0] ?? { tenantId: 'not-selected' as Id, workspaceId: 'not-selected' as Id }))}</small></span>${prototypeIcon('right')}</button>${uiState.profileOpen ? '<div class="profile-menu"><button type="button" data-action="settings-profile">Profile settings</button><button type="button" data-action="notify" data-message="Workspace switching is available from the workspace control">Switch workspace</button><button type="button" data-action="notify" data-message="Sign out is not available in offline Spyderbyte">Sign out</button></div>' : ''}</div><button class="vibe-button tertiary full-width" type="button" data-action="reconnect">Reconnect</button></div></aside>`;
  const content =
    activePanel === 'workflows'
      ? prototypeWorkflowCanvas(snapshot, actions, uiState)
      : prototypeFlowPanel(activePanel, snapshot, actions, uiState);
  const headerTitle =
    activePanel === 'workflows' ? uiState.activeFile : webPanelLabels[activePanel];
  const header = `<header class="workspace-header"><div class="breadcrumbs"><span>Customer Churn</span><span aria-hidden="true">›</span><span>${activePanel === 'workflows' ? 'Analyze' : 'Spyderbyte'}</span><span aria-hidden="true">›</span><span>${escapeHtml(headerTitle)}</span></div><div class="title-row"><div class="title-group"><h1>${escapeHtml(headerTitle)}</h1><button class="icon-button" type="button" aria-label="Favorite analysis" data-action="save-analysis">${prototypeIcon('star')}</button><button class="icon-button" type="button" aria-label="More analysis options" data-action="notify" data-message="More analysis options are available after persistence is connected">${prototypeIcon('more')}</button></div><div class="title-actions"><span class="license-chip${license?.status === 'valid' ? '' : ' warning'}" data-license-status="${licenseStatus}"><span class="status-dot ${license?.status === 'valid' ? 'positive' : 'warning'}"></span>${escapeHtml(licenseMessage)}</span><button class="secondary-button ${uiState.saved ? 'saved' : ''}" type="button" data-action="save-analysis">${uiState.saved ? 'Saved' : 'Save'}${prototypeIcon('down')}</button><button class="run-button" type="button" data-action="run-query"${activePanel === 'workflows' ? '' : ' disabled'}>${prototypeIcon('play')}Run${prototypeIcon('down')}</button></div></div></header>`;
  return `<main class="app-shell${uiState.sidebarOpen ? '' : ' sidebar-collapsed'}${uiState.drawerOpen ? '' : ' drawer-collapsed'}" aria-label="Spyderbyte"><a href="#panel" class="skip-link">Skip to content</a>${sidebar}${uiState.sidebarOpen ? '' : `<button class="icon-button expand-sidebar" type="button" aria-label="Expand sidebar" data-action="expand-sidebar">${prototypeIcon('right')}</button>`}<main class="workspace-main" aria-label="Local workspace">${header}${content}</main>${uiState.drawerOpen ? prototypeDetails(activePanel, snapshot, actions, uiState) : `<button class="icon-button open-drawer" type="button" aria-label="Open run details" data-action="open-drawer">${prototypeIcon('left')}</button>`}${prototypeSettings(uiState)}${uiState.toast === undefined ? '' : `<div class="toast" role="status"><span>${escapeHtml(uiState.toast)}</span><button type="button" aria-label="Dismiss notification" data-action="dismiss-toast">${prototypeIcon('x')}</button></div>`}</main>`;
}

export function renderWebDocument(activePanel: WebPanel = 'workflows'): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spyderbyte</title></head><body><div id="app">${renderAccessibleShell(activePanel)}</div><script type="module" src="/src/compat/legacy/browser.ts"></script></body></html>`;
}

export interface WebApplication {
  setWorkspaces(workspaces: readonly TenantRef[]): void;
  setLicenseStatus(status: WebLicenseSnapshot): void;
  setPendingPlan(plan: JsonValue): void;
  setPendingApproval(approval: JsonValue): void;
  clearPendingPlan(): void;
  selectWorkspace(tenant: TenantRef): boolean;
  navigate(panel: WebPanel): void;
  connect(): void;
  disconnect(error?: string): void;
  applySubscription(page: SubscriptionPage): void;
  loadProjection(api: ProjectionApi, panel: WebPanel): Promise<boolean>;
  submitCommand(api: ProjectionApi, command: RuntimeCommand): Promise<JsonValue>;
  recordConcurrencyConflict(input: {
    artifactId: Id;
    expectedVersion: number;
    currentVersion?: number;
    message?: string;
  }): void;
  reconcile<T extends JsonValue>(projection: T): T;
  snapshot(): WebProjectionState;
  destroy(): void;
}

export interface WebApplicationOptions {
  readonly onWorkspaceSelected?: (tenant: TenantRef) => void;
  readonly onRefresh?: () => void | Promise<void>;
  readonly onWorkspaceCreate?: () => void | Promise<void>;
  readonly onLicenseImport?: (file: File) => void | Promise<void>;
  readonly onRunDataset?: (file: File, intendedUse: string) => void | Promise<void>;
  readonly onRunPlanned?: (workflowId: Id) => void | Promise<void>;
  readonly onApprovePlan?: (approvalId: Id) => void | Promise<void>;
  readonly onRejectPlan?: (approvalId: Id) => void | Promise<void>;
  readonly onWorkspaceExport?: () => void | Promise<void>;
  readonly onWorkspaceBackup?: () => void | Promise<void>;
  readonly onWorkspaceImport?: () => void | Promise<void>;
}

export function mountWebApplication(
  root: HTMLElement,
  tenant: TenantRef,
  options: WebApplicationOptions = {},
): WebApplication {
  const model = new ProjectionDrivenInteractionModel(tenant);
  let activePanel: WebPanel = 'workflows';
  let uiState = defaultPrototypeUiState();
  let destroyed = false;

  const render = (focusPanel = false, preserveFocus = false): void => {
    const focused =
      preserveFocus && root.ownerDocument.activeElement instanceof HTMLInputElement
        ? root.ownerDocument.activeElement
        : undefined;
    const focusKey = focused?.dataset['focusKey'];
    const selectionStart = focused?.selectionStart;
    const selectionEnd = focused?.selectionEnd;
    root.innerHTML = renderAccessibleShell(
      activePanel,
      model.snapshot(),
      {
        workspaceExport: options.onWorkspaceExport !== undefined,
        workspaceBackup: options.onWorkspaceBackup !== undefined,
        workspaceImport: options.onWorkspaceImport !== undefined,
        runPlanned: options.onRunPlanned !== undefined,
        approvePlan: options.onApprovePlan !== undefined,
        rejectPlan: options.onRejectPlan !== undefined,
      },
      uiState,
    );
    if (focusPanel) root.querySelector<HTMLElement>('#panel')?.focus();
    if (focusKey !== undefined) {
      const next = root.querySelector<HTMLInputElement>(`[data-focus-key="${focusKey}"]`);
      next?.focus();
      if (
        selectionStart !== null &&
        selectionStart !== undefined &&
        selectionEnd !== null &&
        selectionEnd !== undefined
      ) {
        next?.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  };
  const notify = (message: string): void => {
    uiState = { ...uiState, toast: message };
    render();
  };
  const executePlannedWorkflow = (workflowId: Id): void => {
    if (options.onRunPlanned === undefined) return;
    uiState = { ...uiState, runState: 'Running', toast: undefined };
    render();
    void Promise.resolve(options.onRunPlanned(workflowId))
      .then(() => {
        uiState = {
          ...uiState,
          runState: 'Succeeded',
          toast: 'Workflow submitted to the local runtime',
        };
        render();
      })
      .catch((error: unknown) => {
        model.disconnect(error instanceof Error ? error.message : String(error));
        uiState = { ...uiState, runState: 'Failed', toast: 'Workflow submission failed' };
        render();
      });
  };
  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const panelLink = target.closest<HTMLElement>('[data-panel-link]');
    if (panelLink !== null) {
      event.preventDefault();
      const panel = panelLink.dataset['panelLink'] as WebPanel | undefined;
      if (panel !== undefined && panel in webPanelLabels) {
        activePanel = panel;
        render(true);
      }
      return;
    }
    const action = target.closest<HTMLElement>('[data-action]')?.dataset['action'];
    if (action === 'collapse-sidebar') {
      uiState = { ...uiState, sidebarOpen: false };
      render();
      return;
    }
    if (action === 'expand-sidebar') {
      uiState = { ...uiState, sidebarOpen: true };
      render();
      return;
    }
    if (action === 'collapse-drawer' || action === 'open-drawer') {
      uiState = { ...uiState, drawerOpen: action === 'open-drawer' };
      render();
      return;
    }
    if (action === 'toggle-workspace') {
      uiState = { ...uiState, workspaceOpen: !uiState.workspaceOpen };
      render();
      return;
    }
    if (action === 'toggle-analyze') {
      uiState = { ...uiState, analyzeOpen: !uiState.analyzeOpen };
      render();
      return;
    }
    if (action === 'new-analysis') {
      activePanel = 'workflows';
      uiState = { ...uiState, objectiveOpen: true, toast: undefined };
      render(true);
      return;
    }
    if (action === 'save-analysis') {
      const saved = !uiState.saved;
      uiState = {
        ...uiState,
        saved,
        toast: saved ? 'Analysis saved locally' : 'Analysis removed from saved',
      };
      render();
      return;
    }
    if (action === 'result-tab') {
      const resultTab = target.closest<HTMLElement>('[data-result-tab]')?.dataset['resultTab'];
      if (resultTab === 'Results' || resultTab === 'Chart') {
        uiState = { ...uiState, resultTab };
        render();
      }
      return;
    }
    if (action === 'run-query') {
      const workflowId = asRecord(model.snapshot().pendingPlan)?.['workflowId'];
      if (typeof workflowId === 'string') {
        notify('Review and approve the typed plan before running it');
      } else {
        uiState = {
          ...uiState,
          objectiveOpen: true,
          toast: 'Create a typed plan before running a workflow',
        };
        render();
      }
      return;
    }
    if (action === 'notify') {
      const message = target.closest<HTMLElement>('[data-message]')?.dataset['message'];
      notify(message ?? 'Action is available from the local runtime');
      return;
    }
    if (action === 'dismiss-toast') {
      uiState = { ...uiState, toast: undefined };
      render();
      return;
    }
    if (action === 'settings-open') {
      uiState = { ...uiState, settingsOpen: true };
      render();
      return;
    }
    if (
      action === 'settings-close' ||
      (action === 'settings-backdrop' &&
        target === target.closest('[data-action="settings-backdrop"]'))
    ) {
      uiState = { ...uiState, settingsOpen: false };
      render();
      return;
    }
    if (action === 'settings-select') {
      const setting = target.closest<HTMLElement>('[data-setting]')?.dataset['setting'];
      if (setting !== undefined) {
        uiState = { ...uiState, activeSetting: setting };
        render();
      }
      return;
    }
    if (action === 'settings-profile') {
      uiState = { ...uiState, activeSetting: 'Profile', settingsOpen: true, profileOpen: false };
      render();
      return;
    }
    if (action === 'profile-toggle') {
      uiState = { ...uiState, profileOpen: !uiState.profileOpen };
      render();
      return;
    }
    if (target.closest('[data-action="reconnect"]') !== null) {
      model.connect();
      render();
      if (options.onRefresh !== undefined) {
        void Promise.resolve(options.onRefresh()).catch((error: unknown) => {
          model.disconnect(error instanceof Error ? error.message : String(error));
          render();
        });
      }
      return;
    }
    if (target.closest('[data-action="new-workspace"]') !== null) {
      if (options.onWorkspaceCreate !== undefined) {
        void Promise.resolve(options.onWorkspaceCreate()).catch((error: unknown) => {
          model.disconnect(error instanceof Error ? error.message : String(error));
          render();
        });
      }
      return;
    }
    if (target.closest('[data-action="export-workspace"]') !== null) {
      if (options.onWorkspaceExport !== undefined) {
        void Promise.resolve(options.onWorkspaceExport()).catch((error: unknown) => {
          model.disconnect(error instanceof Error ? error.message : String(error));
          render();
        });
      }
      return;
    }
    if (target.closest('[data-action="backup-workspace"]') !== null) {
      if (options.onWorkspaceBackup !== undefined) {
        void Promise.resolve(options.onWorkspaceBackup()).catch((error: unknown) => {
          model.disconnect(error instanceof Error ? error.message : String(error));
          render();
        });
      }
      return;
    }
    if (target.closest('[data-action="import-workspace"]') !== null) {
      if (options.onWorkspaceImport !== undefined) {
        void Promise.resolve(options.onWorkspaceImport()).catch((error: unknown) => {
          model.disconnect(error instanceof Error ? error.message : String(error));
          render();
        });
      }
      return;
    }
    if (target.closest('[data-action="run-planned"]') !== null) {
      const workflowId = asRecord(model.snapshot().pendingPlan)?.['workflowId'];
      if (typeof workflowId !== 'string' || options.onRunPlanned === undefined) return;
      executePlannedWorkflow(workflowId as Id);
      return;
    }
    const pendingApproval = asRecord(asRecord(model.snapshot().pendingPlan)?.['approval']);
    const approvalId = pendingApproval?.['approvalId'];
    const approveAction = target.closest('[data-action="approve-plan"]');
    const rejectAction = target.closest('[data-action="reject-plan"]');
    if ((approveAction !== null || rejectAction !== null) && typeof approvalId === 'string') {
      const callback = approveAction !== null ? options.onApprovePlan : options.onRejectPlan;
      if (callback !== undefined) {
        void Promise.resolve(callback(approvalId as Id)).catch((error: unknown) => {
          model.disconnect(error instanceof Error ? error.message : String(error));
          render();
        });
      }
      return;
    }
    if (target.closest('[data-action="import-license"]') !== null) {
      root.querySelector<HTMLInputElement>('[data-action="import-license-file"]')?.click();
    }
  };
  const onSubmit = (event: SubmitEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLFormElement) || target.dataset['action'] !== 'run-dataset') return;
    event.preventDefault();
    const file = target.querySelector<HTMLInputElement>('input[name="dataset"]')?.files?.[0];
    const objective = target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
    if (file === undefined) {
      model.disconnect('Select a CSV dataset before running the workflow');
      render();
      return;
    }
    if (options.onRunDataset === undefined) return;
    void Promise.resolve(
      options.onRunDataset(
        file,
        objective?.value.trim() || 'Validate this dataset for local analysis',
      ),
    ).catch((error: unknown) => {
      model.disconnect(error instanceof Error ? error.message : String(error));
      render();
    });
  };
  const onChange = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset['action'] === 'import-license-file') {
      const file = target.files?.[0];
      target.value = '';
      if (file !== undefined) {
        void Promise.resolve(options.onLicenseImport?.(file)).catch((error: unknown) => {
          model.disconnect(error instanceof Error ? error.message : String(error));
          render();
        });
      }
      return;
    }
    if (target instanceof HTMLSelectElement && target.dataset['action'] === 'select-workspace') {
      const index = Number(target.value);
      const workspace = model.snapshot().workspaces[index];
      if (workspace !== undefined && model.selectWorkspace(workspace)) {
        options.onWorkspaceSelected?.(workspace);
        render(true);
      }
    }
  };
  const onInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.dataset['action'] !== 'results-search')
      return;
    uiState = { ...uiState, query: target.value };
    render(false, true);
  };

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('submit', onSubmit);
  model.connect();
  render();

  return {
    setWorkspaces(workspaces): void {
      if (destroyed) return;
      model.setWorkspaces(workspaces);
      render(true);
    },
    setLicenseStatus(status): void {
      if (destroyed) return;
      model.setLicenseStatus(status);
      render();
    },
    setPendingPlan(plan): void {
      if (destroyed) return;
      model.setPendingPlan(plan);
      render();
    },
    setPendingApproval(approval): void {
      if (destroyed) return;
      model.setPendingApproval(approval);
      render();
    },
    clearPendingPlan(): void {
      if (destroyed) return;
      model.clearPendingPlan();
      render();
    },
    selectWorkspace(selectedTenant): boolean {
      if (destroyed) return false;
      const selected = model.selectWorkspace(selectedTenant);
      if (selected) render(true);
      return selected;
    },
    navigate(panel): void {
      if (destroyed || !(panel in webPanelLabels)) return;
      activePanel = panel;
      render(true);
    },
    connect(): void {
      if (destroyed) return;
      model.connect();
      render();
    },
    disconnect(error?: string): void {
      if (destroyed) return;
      model.disconnect(error);
      render();
    },
    applySubscription(page): void {
      if (destroyed) return;
      model.applySubscription(page);
      render();
    },
    loadProjection(api, panel): Promise<boolean> {
      if (destroyed) return Promise.resolve(false);
      return model.loadProjection(api, panel).then((loaded) => {
        if (!destroyed && loaded) render();
        return loaded;
      });
    },
    submitCommand(api, command): Promise<JsonValue> {
      if (destroyed) return Promise.reject(new Error('Web application is destroyed'));
      return model
        .submitCommand(api, command)
        .then((result) => {
          if (!destroyed) render();
          return result;
        })
        .catch((error: unknown) => {
          if (!destroyed) render();
          throw error;
        });
    },
    recordConcurrencyConflict(input): void {
      if (destroyed) return;
      model.noteOptimisticConflict(input);
      render();
    },
    reconcile<T extends JsonValue>(projection: T): T {
      if (!destroyed) {
        const result = model.reconcile(projection);
        render();
        return result;
      }
      return projection;
    },
    snapshot(): WebProjectionState {
      return model.snapshot();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChange);
      root.removeEventListener('input', onInput);
      root.removeEventListener('submit', onSubmit);
      root.replaceChildren();
    },
  };
}

function isConflictError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409 || candidate.code === 'CONCURRENCY_STALE_VERSION';
}

export * from './client.js';
