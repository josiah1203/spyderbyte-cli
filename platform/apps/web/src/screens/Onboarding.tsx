import { useEffect, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Notice,
  Select,
  SectionLabel,
  Switch,
} from '../components/primitives';
import { STARTER_LAYOUTS, type LayoutPreferences } from '../data/layout';
import { useTheme, type Theme } from '../contexts/ThemeContext';
import { useRuntime } from '../runtime/RuntimeProvider';
import type { JsonValue } from '../runtime/contracts';

const STEPS = ['Profile', 'Workspace', 'Layout', 'Appearance', 'Safety', 'Connect'];

type OnboardingChoice = 'local-model' | 'provider-key' | 'spyderbyte-cloud' | 'configure-later';
type SetupProviderType = 'openai' | 'anthropic' | 'openai-compatible' | 'ollama' | 'deterministic';

interface OnboardingModel {
  modelId: string;
  providerId: string;
  displayName?: string;
  state: string;
  local: boolean;
}

interface OnboardingEnvironment {
  project?: {
    rootPath?: string;
    projectName?: string;
    markers?: string[];
    likelyWorkloads?: string[];
  };
}

interface OnboardingResponse {
  onboarding?: {
    status?: 'not_started' | 'configured';
    choice?: OnboardingChoice;
    modelId?: string;
    environment?: OnboardingEnvironment;
  };
  firstQuestionReady: boolean;
  authenticationRequiredForFirstQuestion: false;
  choices?: Array<{ id: OnboardingChoice; label: string; requiresAuthentication: boolean }>;
  revision?: number;
}

interface ModelCatalogResponse {
  models?: OnboardingModel[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export default function Onboarding({
  layoutPreferences,
  onLayoutChange,
}: {
  layoutPreferences: LayoutPreferences;
  onLayoutChange: (next: LayoutPreferences) => void;
}): ReactElement {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [starter, setStarter] = useState<keyof typeof STARTER_LAYOUTS>('focus');
  const [density, setDensity] = useState<LayoutPreferences['density']>(layoutPreferences.density);
  const [safety, setSafety] = useState({
    confirmExternalNetwork: false,
    confirmExternalWrites: false,
    confirmDestructiveActions: false,
    confirmSecretUse: false,
  });
  const [profileRevision, setProfileRevision] = useState(0);
  const [userSettingsRevision, setUserSettingsRevision] = useState(0);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [onboarding, setOnboarding] = useState<OnboardingResponse>();
  const [models, setModels] = useState<OnboardingModel[]>([]);
  const [choice, setChoice] = useState<OnboardingChoice>('configure-later');
  const [modelId, setModelId] = useState('');
  const [providerType, setProviderType] = useState<SetupProviderType>('openai');
  const [providerName, setProviderName] = useState('');
  const [providerEndpoint, setProviderEndpoint] = useState('');
  const [providerModelId, setProviderModelId] = useState('');
  const [providerApiKey, setProviderApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const get = runtime.client.get;
    if (!get) return () => undefined;
    const load = async (): Promise<void> => {
      const [
        profileResult,
        workspaceResult,
        userSettingsResult,
        workspaceSettingsResult,
        onboardingResult,
        modelResult,
      ] = await Promise.allSettled([
        get<{
          profile?: { displayName?: string; onboardingComplete?: boolean };
          revision?: number;
        }>('/v1/profile'),
        get<{ manifest?: { name?: string } }>('/v1/workspace'),
        get<{ revision?: number; values?: Record<string, unknown> }>('/v1/settings?scope=user'),
        get<{ revision?: number; values?: Record<string, unknown> }>(
          '/v1/settings?scope=workspace',
        ),
        get<OnboardingResponse>('/v1/onboarding'),
        get<ModelCatalogResponse>('/v1/models/catalog'),
      ]);
      if (cancelled) return;
      if (profileResult.status === 'fulfilled') {
        const value = profileResult.value.profile;
        if (typeof value?.displayName === 'string' && value.displayName !== 'Local user') {
          setDisplayName(value.displayName);
        }
        setProfileRevision(profileResult.value.revision ?? 0);
      }
      if (workspaceResult.status === 'fulfilled') {
        const name = workspaceResult.value.manifest?.name;
        if (typeof name === 'string') setWorkspaceName(name);
      }
      if (userSettingsResult.status === 'fulfilled') {
        setUserSettingsRevision(userSettingsResult.value.revision ?? 0);
        const appearance = record(userSettingsResult.value.values?.appearance);
        if (appearance?.density === 'compact') setDensity('compact');
      }
      if (workspaceSettingsResult.status === 'fulfilled') {
        const values = workspaceSettingsResult.value.values ?? {};
        setWorkspaceRevision(workspaceSettingsResult.value.revision ?? 0);
        if (typeof values.name === 'string' && values.name.trim()) setWorkspaceName(values.name);
        setSafety((current) => ({
          confirmExternalNetwork:
            typeof values.confirmExternalNetwork === 'boolean'
              ? values.confirmExternalNetwork
              : current.confirmExternalNetwork,
          confirmExternalWrites:
            typeof values.confirmExternalWrites === 'boolean'
              ? values.confirmExternalWrites
              : current.confirmExternalWrites,
          confirmDestructiveActions:
            typeof values.confirmDestructiveActions === 'boolean'
              ? values.confirmDestructiveActions
              : current.confirmDestructiveActions,
          confirmSecretUse:
            typeof values.confirmSecretUse === 'boolean'
              ? values.confirmSecretUse
              : current.confirmSecretUse,
        }));
      }
      if (onboardingResult.status === 'fulfilled') {
        const result = onboardingResult.value;
        setOnboarding(result);
        if (result.onboarding?.choice !== undefined) setChoice(result.onboarding.choice);
        if (typeof result.onboarding?.modelId === 'string') setModelId(result.onboarding.modelId);
      }
      if (modelResult.status === 'fulfilled') {
        const readyLocalModels = (modelResult.value.models ?? []).filter(
          (model) => model.local && model.state === 'ready',
        );
        setModels(readyLocalModels);
        setModelId((current) => current || readyLocalModels[0]?.modelId || '');
      }
    };
    void load().catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [runtime]);

  function providerNeedsKey(): boolean {
    return providerType !== 'ollama' && providerType !== 'deterministic';
  }

  async function saveOnboardingChoice(): Promise<void> {
    if (!runtime.client.post) {
      throw new Error('The local onboarding service is not available yet.');
    }
    if (choice === 'local-model' && models.length === 0) {
      throw new Error('Install a ready local model or choose another first-run option.');
    }
    if (choice === 'provider-key') {
      if (!providerName.trim()) throw new Error('A provider display name is required.');
      if (providerNeedsKey() && !providerApiKey) {
        throw new Error('A provider key is required for this connection.');
      }
    }
    const provider =
      choice !== 'provider-key'
        ? undefined
        : {
            providerType,
            displayName: providerName.trim(),
            ...(providerEndpoint.trim() ? { endpoint: providerEndpoint.trim() } : {}),
            ...(providerModelId.trim() ? { defaultModelId: providerModelId.trim() } : {}),
            ...(providerApiKey ? { apiKey: providerApiKey } : {}),
          };
    const response = await runtime.client.post<OnboardingResponse>('/v1/onboarding', {
      choice,
      ...(choice === 'local-model' && modelId ? { modelId } : {}),
      ...(provider === undefined ? {} : { provider }),
    } as unknown as JsonValue);
    setOnboarding(response);
    setProviderApiKey('');
    setProviderName('');
    setProviderEndpoint('');
    setProviderModelId('');
  }

  async function finish(): Promise<void> {
    if (!displayName.trim()) {
      setStep(0);
      setError('A display name is required to finish setup.');
      return;
    }
    if (!runtime.client.put) {
      setError('The local settings service is not available yet.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const nextLayout = { ...STARTER_LAYOUTS[starter].layout, density };
      onLayoutChange(nextLayout);
      await saveOnboardingChoice();
      await runtime.client.put('/v1/profile', {
        displayName: displayName.trim(),
        onboardingComplete: true,
        expectedRevision: profileRevision,
      } as unknown as JsonValue);
      await runtime.client.put('/v1/settings', {
        scope: 'user',
        expectedRevision: userSettingsRevision,
        patch: {
          layout: nextLayout as unknown as JsonValue,
          appearance: { theme, density } as unknown as JsonValue,
        },
      } as unknown as JsonValue);
      await runtime.client.put('/v1/settings', {
        scope: 'workspace',
        expectedRevision: workspaceRevision,
        patch: {
          ...(workspaceName.trim() ? { name: workspaceName.trim() } : {}),
          ...safety,
        },
      } as unknown as JsonValue);
      await runtime.refresh();
      navigate('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function next(): void {
    if (step === 0 && !displayName.trim()) {
      setError('A display name is required.');
      return;
    }
    setError(undefined);
    if (step === STEPS.length - 1) {
      void finish();
      return;
    }
    setStep((value) => value + 1);
  }

  return (
    <div className="page-scroll onboarding-shell">
      <div className="page onboarding-page">
        <div className="onboarding-header">
          <div>
            <SectionLabel>First-run setup</SectionLabel>
            <h1>Make the platform yours</h1>
            <p className="page-subtitle">
              Create a local profile, choose a starting layout, and set the safety prompts that fit
              your workflow.
            </p>
          </div>
          <Badge color="green">Personal local workspace</Badge>
        </div>
        <div className="onboarding-progress" role="list" aria-label="Setup progress">
          {STEPS.map((label, index) => (
            <span
              key={label}
              role="listitem"
              data-active={index === step}
              data-complete={index < step}
            >
              {index + 1}. {label}
            </span>
          ))}
        </div>
        {error && (
          <div className="home-error" role="alert">
            {error}
          </div>
        )}
        <Card className="onboarding-card">
          {step === 0 && (
            <>
              <h2>How should we call you?</h2>
              <p className="settings-copy">
                This is shown in the sidebar and attached to local activity. You can change it
                later.
              </p>
              <Field label="Display name" required>
                <Input
                  id="onboarding-display-name"
                  autoFocus
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  placeholder="Your name"
                />
              </Field>
            </>
          )}
          {step === 1 && (
            <>
              <h2>Name your workspace</h2>
              <p className="settings-copy">
                The local workspace is your private project boundary. You can keep the suggested
                name or give it a more meaningful one.
              </p>
              <Field label="Workspace name">
                <Input
                  id="onboarding-workspace-name"
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="My local workspace"
                />
              </Field>
            </>
          )}
          {step === 2 && (
            <>
              <h2>Choose a starting layout</h2>
              <p className="settings-copy">
                These are templates, not roles. You can show, hide, reorder, rename, and regroup
                pages at any time.
              </p>
              <div className="settings-template-grid">
                {Object.entries(STARTER_LAYOUTS).map(([id, option]) => (
                  <button
                    key={id}
                    className="settings-template-card"
                    type="button"
                    data-active={starter === id}
                    onClick={() => setStarter(id as keyof typeof STARTER_LAYOUTS)}
                  >
                    <strong>{option.label}</strong>
                    <span>{option.description}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <h2>Set the feel</h2>
              <p className="settings-copy">
                You can change these preferences from Appearance later.
              </p>
              <div className="settings-form-grid settings-form-grid-two">
                <Field label="Theme">
                  <Select
                    id="onboarding-theme"
                    value={theme}
                    onChange={(event) => setTheme(event.target.value as Theme)}
                  >
                    <option value="system">System</option>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </Select>
                </Field>
                <Field label="Density">
                  <Select
                    id="onboarding-density"
                    value={density}
                    onChange={(event) =>
                      setDensity(event.target.value as LayoutPreferences['density'])
                    }
                  >
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </Select>
                </Field>
              </div>
            </>
          )}
          {step === 4 && (
            <>
              <h2>Choose local safety prompts</h2>
              <p className="settings-copy">
                These are optional confirmations on this device—not organization policy denials.
                Authority, secret protection, technical validation, and workspace boundaries remain
                enforced.
              </p>
              <Switch
                checked={safety.confirmExternalNetwork}
                label="Confirm external network access"
                onCheckedChange={(checked) =>
                  setSafety({ ...safety, confirmExternalNetwork: checked })
                }
              />
              <Switch
                checked={safety.confirmExternalWrites}
                label="Confirm external writes"
                onCheckedChange={(checked) =>
                  setSafety({ ...safety, confirmExternalWrites: checked })
                }
              />
              <Switch
                checked={safety.confirmDestructiveActions}
                label="Confirm destructive actions"
                onCheckedChange={(checked) =>
                  setSafety({ ...safety, confirmDestructiveActions: checked })
                }
              />
              <Switch
                checked={safety.confirmSecretUse}
                label="Confirm secret use"
                onCheckedChange={(checked) => setSafety({ ...safety, confirmSecretUse: checked })}
              />
            </>
          )}
          {step === 5 && (
            <>
              <h2>Choose how to start</h2>
              <p className="settings-copy">
                Choose the runtime for your first question. Local and BYOK choices stay behind the
                local runtime boundary; cloud authentication is never required just to finish setup.
              </p>
              <div
                className="settings-template-grid"
                role="radiogroup"
                aria-label="First-run runtime"
              >
                {(
                  onboarding?.choices ?? [
                    {
                      id: 'local-model' as const,
                      label: 'Use a local model',
                      requiresAuthentication: false,
                    },
                    {
                      id: 'provider-key' as const,
                      label: 'Use a provider key',
                      requiresAuthentication: true,
                    },
                    {
                      id: 'spyderbyte-cloud' as const,
                      label: 'Use Spyderbyte Cloud',
                      requiresAuthentication: true,
                    },
                    {
                      id: 'configure-later' as const,
                      label: 'Configure later',
                      requiresAuthentication: false,
                    },
                  ]
                ).map((option) => (
                  <button
                    key={option.id}
                    className="settings-template-card"
                    type="button"
                    role="radio"
                    aria-checked={choice === option.id}
                    data-active={choice === option.id}
                    onClick={() => setChoice(option.id)}
                  >
                    <strong>{option.label}</strong>
                    <span>
                      {option.id === 'local-model'
                        ? 'Run privately on this device.'
                        : option.id === 'provider-key'
                          ? 'Store the credential in the local vault.'
                          : option.id === 'spyderbyte-cloud'
                            ? 'Use managed execution when enabled.'
                            : 'Finish setup and connect later.'}
                    </span>
                  </button>
                ))}
              </div>
              {choice === 'local-model' && (
                <div className="stack">
                  <Field
                    label="Local model"
                    hint="Only installed and ready local models are selectable."
                  >
                    <Select
                      aria-label="Local model"
                      value={modelId}
                      onChange={(event) => setModelId(event.target.value)}
                      disabled={models.length === 0}
                    >
                      <option value="">
                        {models.length === 0
                          ? 'No ready local model found'
                          : 'Choose a local model'}
                      </option>
                      {models.map((model) => (
                        <option key={model.modelId} value={model.modelId}>
                          {model.displayName ?? model.modelId} · {model.providerId}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {models.length === 0 && (
                    <Notice tone="warning" icon="warning">
                      Install a local model from Models, or choose a provider key or Configure
                      later.
                    </Notice>
                  )}
                </div>
              )}
              {choice === 'provider-key' && (
                <div className="settings-form-grid settings-form-grid-two">
                  <Field label="Provider type">
                    <Select
                      aria-label="Onboarding provider type"
                      value={providerType}
                      onChange={(event) => setProviderType(event.target.value as SetupProviderType)}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="openai-compatible">OpenAI-compatible</option>
                      <option value="ollama">Ollama</option>
                      <option value="deterministic">Deterministic local fixture</option>
                    </Select>
                  </Field>
                  <Field label="Provider display name" required>
                    <Input
                      aria-label="Onboarding provider display name"
                      value={providerName}
                      onChange={(event) => setProviderName(event.target.value)}
                      placeholder="My model provider"
                    />
                  </Field>
                  <Field label="Endpoint" hint="Optional for the provider default.">
                    <Input
                      aria-label="Onboarding provider endpoint"
                      value={providerEndpoint}
                      onChange={(event) => setProviderEndpoint(event.target.value)}
                      placeholder="https://api.example.com/v1"
                      type="url"
                    />
                  </Field>
                  <Field label="Default model" hint="Optional until model discovery completes.">
                    <Input
                      aria-label="Onboarding default model"
                      value={providerModelId}
                      onChange={(event) => setProviderModelId(event.target.value)}
                      placeholder="model-name"
                    />
                  </Field>
                  <Field
                    label="Provider API key"
                    hint="Sent once to the local runtime and cleared after submission."
                  >
                    <Input
                      aria-label="Onboarding provider API key"
                      type="password"
                      autoComplete="new-password"
                      value={providerApiKey}
                      onChange={(event) => setProviderApiKey(event.target.value)}
                      placeholder={
                        providerNeedsKey() ? 'Enter once; never displayed' : 'Not required'
                      }
                    />
                  </Field>
                </div>
              )}
              {choice === 'spyderbyte-cloud' && (
                <Notice tone="info" icon="info">
                  Cloud execution can be enabled later. Setup records the choice without requiring a
                  cloud token or sending project data.
                </Notice>
              )}
              {choice === 'configure-later' && (
                <Notice tone="info" icon="info">
                  You can connect models, repositories, data sources, and runtimes after setup.
                </Notice>
              )}
              {onboarding?.onboarding?.environment?.project && (
                <div className="onboarding-optional-list">
                  <span>
                    Detected project:{' '}
                    {onboarding.onboarding.environment.project.projectName ?? 'Current workspace'}
                  </span>
                  <span>
                    Workloads:{' '}
                    {onboarding.onboarding.environment.project.likelyWorkloads?.join(', ') ||
                      'none detected'}
                  </span>
                  <span>
                    {onboarding.firstQuestionReady
                      ? 'A local first question is ready.'
                      : 'A model connection is still needed for the first question.'}
                  </span>
                </div>
              )}
            </>
          )}
        </Card>
        <div className="onboarding-actions">
          <Button
            variant="tertiary"
            disabled={step === 0 || busy}
            onClick={() => setStep((value) => Math.max(0, value - 1))}
          >
            Back
          </Button>
          <span className="onboarding-actions-spacer" />
          <Button variant="secondary" disabled={step === 0 || busy} onClick={() => navigate('/')}>
            Skip for now
          </Button>
          <Button loading={busy} onClick={next}>
            {step === STEPS.length - 1 ? 'Finish setup' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>
  );
}
