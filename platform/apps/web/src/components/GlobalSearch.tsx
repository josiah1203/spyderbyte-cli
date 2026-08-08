import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PAGE_LABELS, PLATFORM_NAV_GROUPS, type Page } from '../data/profiles';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore, type ProjectView, type RunView } from '../runtime/store';
import Icon from './icons';
import { Badge, SearchInput } from './primitives';

interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
}

interface SearchResult {
  id: string;
  label: string;
  detail: string;
  kind: 'surface' | 'project' | 'run' | 'resource';
  path: string;
}

function routeForPage(page: Page): string {
  if (page === 'home') return '/';
  if (page === 'settings') return '/settings/workspace/general';
  if (page === 'project-detail') return '/projects';
  if (page === 'run-detail') return '/runs';
  return `/${page}`;
}

function projectionItems(
  state: Record<string, unknown> | undefined,
  keys: readonly string[],
): Array<{ id: string; label: string; detail: string }> {
  const collection = keys
    .map((key) => state?.[key])
    .find((value) => value !== null && typeof value === 'object' && !Array.isArray(value));
  if (collection === undefined || collection === null || typeof collection !== 'object') return [];
  return Object.values(collection as Record<string, unknown>).flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    const id = String(value.id ?? value.resourceId ?? value[keys[0] ?? 'id'] ?? '');
    const label = String(value.name ?? value.title ?? value.label ?? id);
    const detail = String(value.description ?? value.status ?? value.state ?? 'Resource');
    return id ? [{ id, label, detail }] : [];
  });
}

export default function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const results = useMemo<SearchResult[]>(() => {
    const normalized = query.trim().toLowerCase();
    const surfaces = [...new Set(PLATFORM_NAV_GROUPS.flatMap((group) => group.pages))].flatMap(
      (page) => {
        const label = PAGE_LABELS[page];
        if (!label) return [];
        return [
          {
            id: `surface:${page}`,
            label,
            detail: 'Platform surface',
            kind: 'surface' as const,
            path: routeForPage(page),
          },
        ];
      },
    );
    const projects = readCollection<ProjectView>(
      snapshot.projections.projects?.state,
      'projects',
    ).map((project) => ({
      id: `project:${project.projectId}`,
      label: project.name,
      detail: project.objective ?? 'Project',
      kind: 'project' as const,
      path: `/projects/${encodeURIComponent(project.projectId)}`,
    }));
    const runs = readCollection<RunView>(snapshot.projections.runs?.state, 'runs').map((run) => ({
      id: `run:${run.runId}`,
      label: run.name ?? run.runId,
      detail: `Run · ${run.status}`,
      kind: 'run' as const,
      path: `/runs/${encodeURIComponent(run.runId)}`,
    }));
    const resourceRoutes: Array<[string, Page, string[]]> = [
      ['connections', 'connections', ['connections']],
      ['datasets', 'data', ['datasets']],
      ['queries', 'sql', ['queries']],
      ['notebooks', 'notebooks', ['notebooks']],
      ['pipelines', 'pipelines', ['pipelines']],
      ['automations', 'automations', ['automations']],
      ['repositories', 'repositories', ['repositories']],
      ['visualizations', 'visualizations', ['visualizations']],
    ];
    const resources = resourceRoutes.flatMap(([projection, page, keys]) =>
      projectionItems(
        snapshot.projections[projection]?.state as Record<string, unknown> | undefined,
        keys,
      ).map((item) => ({
        id: `${projection}:${item.id}`,
        label: item.label,
        detail: `${PAGE_LABELS[page] ?? projection} · ${item.detail}`,
        kind: 'resource' as const,
        path: `${routeForPage(page)}?id=${encodeURIComponent(item.id)}`,
      })),
    );
    const all = [...surfaces, ...projects, ...runs, ...resources];
    if (!normalized) return all.slice(0, 24);
    return all
      .filter((result) => `${result.label} ${result.detail}`.toLowerCase().includes(normalized))
      .slice(0, 24);
  }, [query, snapshot.projections]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, Math.max(0, results.length - 1)));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
      } else if (event.key === 'Enter' && results[activeIndex]) {
        event.preventDefault();
        navigate(results[activeIndex].path);
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activeIndex, navigate, onClose, open, results]);

  if (!open) return null;

  return (
    <div className="global-search-scrim" role="presentation" onMouseDown={onClose}>
      <section
        className="global-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search everything"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="global-search-heading">
          <div>
            <span className="section-label">Workspace search</span>
            <h2>Search everything</h2>
          </div>
          <span className="ds-kbd">ESC</span>
        </div>
        <SearchInput
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          placeholder="Search surfaces, projects, runs, and resources…"
          aria-label="Search surfaces, projects, runs, and resources"
        />
        <div className="global-search-results" role="listbox" aria-label="Search results">
          {results.length === 0 ? (
            <div className="global-search-empty">
              <Icon name="search" size={18} tone="tertiary" aria-hidden="true" />
              <span>No matching platform items.</span>
            </div>
          ) : (
            results.map((result, index) => (
              <button
                key={result.id}
                id={`global-search-result-${index}`}
                type="button"
                className="global-search-result"
                data-active={index === activeIndex}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  navigate(result.path);
                  onClose();
                }}
              >
                <span className="global-search-result-icon">
                  <Icon
                    name={
                      result.kind === 'surface'
                        ? 'grid'
                        : result.kind === 'run'
                          ? 'play'
                          : 'document'
                    }
                    size={15}
                    tone="secondary"
                    aria-hidden="true"
                  />
                </span>
                <span className="global-search-result-copy">
                  <span className="global-search-result-label">{result.label}</span>
                  <span className="global-search-result-detail">{result.detail}</span>
                </span>
                <Badge color={result.kind === 'surface' ? 'blue' : 'gray'}>{result.kind}</Badge>
              </button>
            ))
          )}
        </div>
        <div className="global-search-footer">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </section>
    </div>
  );
}

function readCollection<T>(state: unknown, key: string): T[] {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return [];
  const collection = (state as Record<string, unknown>)[key];
  if (collection === null || typeof collection !== 'object' || Array.isArray(collection)) return [];
  return Object.values(collection).filter(
    (item): item is T => item !== null && typeof item === 'object',
  );
}
