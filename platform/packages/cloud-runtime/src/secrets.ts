import {
  HostedSecretBroker,
  type HostedSecretManagerClient,
  type SecretHandle,
} from '@agentic-platform/backends';

/** KMS-backed deployments implement the existing hosted secret-manager port. */
export type KmsSecretManagerClient = HostedSecretManagerClient;

export class KmsBackedSecretBroker extends HostedSecretBroker {}

export type CloudSecretHandle = SecretHandle;
