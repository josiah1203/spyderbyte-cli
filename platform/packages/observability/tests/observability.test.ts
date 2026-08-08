import { describe, expect, it } from 'vitest';
import { newSortableId, type TenantRef } from '@agentic-platform/runtime-contracts';
import {
  AppendOnlyAuditLog,
  ConfigurableTelemetry,
  InMemoryStructuredLogger,
  InMemoryTelemetry,
  InMemoryTraceRecorder,
  SecretRedactor,
  createCorrelationContext,
} from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };

describe('observability primitives', () => {
  it('redacts structured secret fields and common secret values', () => {
    const redactor = new SecretRedactor();
    expect(redactor.redact({ apiKey: 'hidden', nested: 'Bearer abc.def' })).toEqual({
      apiKey: '[REDACTED]',
      nested: '[REDACTED]',
    });
    expect(redactor.redactText('dsn=postgres://user:pass@host/db', ['literal-secret'])).toContain(
      '[REDACTED]',
    );
    expect(
      redactor.redactText(
        'GET /v1/models?api_key=query-secret&keep=1 OPENAI_API_KEY=env-secret password="body-secret"',
      ),
    ).toBe(
      'GET /v1/models?api_key=[REDACTED]&keep=1 OPENAI_API_KEY=[REDACTED] password="[REDACTED]"',
    );
  });

  it('keeps an append-only tamper-evident audit chain and correlated metrics', () => {
    const context = createCorrelationContext({
      tenant,
      workspaceId: tenant.workspaceId,
      workflowId: newSortableId(),
    });
    const audit = new AppendOnlyAuditLog();
    audit.append({
      at: '2026-08-02T00:00:00.000Z',
      context,
      action: 'secret.read',
      target: 'fixture',
      decision: 'completed',
      details: { token: 'hidden' },
    });
    audit.append({
      at: '2026-08-02T00:00:01.000Z',
      context,
      action: 'workflow.step',
      target: 'fixture',
      decision: 'observed',
      details: { ok: true },
    });
    expect(audit.verify()).toBe(true);
    const records = audit.list();
    expect(records[0]?.details).toEqual({ token: '[REDACTED]' });
    const telemetry = new InMemoryTelemetry();
    telemetry.observe({
      name: 'workflow.duration_ms',
      value: 10,
      at: context.correlationId,
      context,
    });
    telemetry.observe({
      name: 'workflow.duration_ms',
      value: 20,
      at: context.correlationId,
      context,
    });
    expect(telemetry.summarize('workflow.duration_ms')).toEqual({
      count: 2,
      sum: 30,
      min: 10,
      max: 20,
    });
  });

  it('records correlated structured logs and trace spans with shared redaction', () => {
    const context = createCorrelationContext({
      tenant,
      workspaceId: tenant.workspaceId,
      correlationId: newSortableId(),
      workflowId: newSortableId(),
    });
    const logger = new InMemoryStructuredLogger();
    logger.emit(
      {
        at: '2026-08-07T00:00:00.000Z',
        level: 'info',
        message: 'provider request token=fixture-token',
        context,
        fields: { providerRequestId: 'provider-1', apiKey: 'hidden' },
      },
      ['fixture-token'],
    );
    expect(logger.list({ correlationId: context.correlationId })).toMatchObject([
      {
        message: 'provider request token=[REDACTED]',
        fields: { providerRequestId: 'provider-1', apiKey: '[REDACTED]' },
      },
    ]);

    const traces = new InMemoryTraceRecorder();
    const span = traces.start({
      name: 'model.invoke',
      context,
      startedAt: '2026-08-07T00:00:00.000Z',
      attributes: { model: 'fixture', password: 'hidden' },
    });
    const finished = traces.finish(span.spanId, {
      endedAt: '2026-08-07T00:00:01.000Z',
      status: 'completed',
      attributes: { providerRequestId: 'provider-1' },
    });
    expect(finished).toMatchObject({
      status: 'completed',
      endedAt: '2026-08-07T00:00:01.000Z',
      attributes: { providerRequestId: 'provider-1' },
    });
    expect(traces.list({ status: 'running' })).toHaveLength(0);
  });

  it('honors telemetry consent and keeps the product metric vocabulary explicit', () => {
    const context = createCorrelationContext({
      tenant,
      workspaceId: tenant.workspaceId,
    });
    const telemetry = new ConfigurableTelemetry();
    telemetry.productMetric({
      name: 'run.success',
      value: 1,
      at: '2026-08-07T00:00:00.000Z',
      context,
    });
    expect(telemetry.list()).toEqual([]);
    telemetry.configure({ mode: 'local', includeProductMetrics: true });
    telemetry.productMetric({
      name: 'run.success',
      value: 1,
      at: '2026-08-07T00:00:00.000Z',
      context,
    });
    expect(telemetry.summarize('run.success')).toMatchObject({ count: 1, sum: 1 });
    telemetry.configure({ mode: 'disabled', includeProductMetrics: true });
    telemetry.productMetric({
      name: 'artifact.reused',
      value: 1,
      at: '2026-08-07T00:00:01.000Z',
      context,
    });
    expect(telemetry.list()).toHaveLength(1);
  });
});
