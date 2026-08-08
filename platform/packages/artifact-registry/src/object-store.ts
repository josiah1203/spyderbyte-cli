import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { runtimeError } from '@agentic-platform/runtime-contracts';

export interface ArtifactObjectStore {
  put(objectKey: string, content: Uint8Array): Promise<void>;
  get(objectKey: string): Promise<Uint8Array | undefined>;
}

function contentAddressedKey(objectKey: string): void {
  if (!/^sha256\/[0-9a-f]{64}$/.test(objectKey)) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      `Invalid content-addressed object key: ${objectKey}`,
    );
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

export class InMemoryArtifactObjectStore implements ArtifactObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  async put(objectKey: string, content: Uint8Array): Promise<void> {
    contentAddressedKey(objectKey);
    const existing = this.objects.get(objectKey);
    if (existing && !sameBytes(existing, content)) {
      throw runtimeError(
        'ARTIFACT_IMMUTABLE',
        `Object ${objectKey} already contains different bytes`,
      );
    }
    if (!existing) this.objects.set(objectKey, new Uint8Array(content));
  }

  async get(objectKey: string): Promise<Uint8Array | undefined> {
    contentAddressedKey(objectKey);
    const content = this.objects.get(objectKey);
    return content ? new Uint8Array(content) : undefined;
  }
}

export class FileSystemArtifactObjectStore implements ArtifactObjectStore {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    if (!isAbsolute(rootDirectory)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Artifact object-store root must be absolute');
    }
    this.rootDirectory = resolve(rootDirectory);
  }

  private pathFor(objectKey: string): string {
    contentAddressedKey(objectKey);
    const target = resolve(this.rootDirectory, objectKey);
    if (target !== this.rootDirectory && !target.startsWith(`${this.rootDirectory}${sep}`)) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Artifact object key escapes the object-store root',
      );
    }
    return target;
  }

  async put(objectKey: string, content: Uint8Array): Promise<void> {
    const target = this.pathFor(objectKey);
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, content, { flag: 'wx' });
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const existing = await readFile(target);
      if (!sameBytes(existing, content)) {
        throw runtimeError(
          'ARTIFACT_IMMUTABLE',
          `Object ${objectKey} already contains different bytes`,
        );
      }
    }
  }

  async get(objectKey: string): Promise<Uint8Array | undefined> {
    const target = this.pathFor(objectKey);
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}
