import { useState } from 'react';
import { PAGE_LABELS, type Page } from '../data/profiles';
import { ORGANIZATION_ONLY_PAGES, type LayoutPreferences } from '../data/layout';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';
import { useTheme, type Theme } from '../contexts/ThemeContext';
import Icon, { type IconName } from './icons';
import { IconButton } from './primitives';
import {
  isPersonalLocalWorkspace,
  pageAvailability,
  pageDefinition,
} from '../runtime/page-registry';

const ICONS: Partial<Record<Page, IconName>> = {
  home: 'home',
  projects: 'projects',
  data: 'database',
  sql: 'terminal',
  visualizations: 'chart',
  media: 'microphone',
  runs: 'play',
  automations: 'automation',
  connections: 'link',
  notebooks: 'notebook',
  code: 'code',
  models: 'cube',
  deployments: 'deploy',
  environments: 'monitor',
  approvals: 'check',
  assets: 'box',
  machine: 'monitor',
  license: 'check',
  settings: 'settings',
  catalog: 'catalog',
  repositories: 'repository',
  experiments: 'flask',
  pipelines: 'pipeline',
  resources: 'grid',
  incidents: 'warning',
  governance: 'shield',
  usage: 'chart',
  audit: 'document',
  worktrees: 'git-branch',
};

const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: IconName }> = [
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'system', label: 'System', icon: 'system' },
];

interface SidebarProps {
  open: boolean;
  onToggle: () => void;
  activePage: Page;
  onNavigate: (page: Page) => void;
  layoutPreferences: LayoutPreferences;
  onLayoutChange: (next: LayoutPreferences) => void;
  onOpenSettings?: (tab?: string) => void;
}

export default function Sidebar({
  open,
  onToggle,
  activePage,
  onNavigate,
  layoutPreferences,
  onLayoutChange,
  onOpenSettings,
}: SidebarProps) {
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const runtime = useRuntime();
  const runtimeSnapshot = useRuntimeStore(runtime);
  const { theme, setTheme } = useTheme();
  const personalLocal = isPersonalLocalWorkspace(runtimeSnapshot.capabilities);
  const actorName =
    runtimeSnapshot.session?.actor.displayName ??
    runtimeSnapshot.session?.actor.actorId ??
    'Session unavailable';
  const actorInitials =
    actorName === 'Session unavailable'
      ? '—'
      : actorName
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0]?.toUpperCase() ?? '')
          .join('') || 'ID';
  const activeRoot: Page = (
    activePage === 'project-detail' ? 'projects' : activePage === 'run-detail' ? 'runs' : activePage
  ) as Page;

  function NavBtn({ page }: { page: Page }) {
    const isActive = activeRoot === page;
    const definition = pageDefinition(page);
    const availability = pageAvailability(
      page,
      runtimeSnapshot.connection,
      runtimeSnapshot.capabilities,
    );
    const locked = availability.state === 'locked' || availability.state === 'unavailable';
    const title = locked
      ? `${definition.label} · ${availability.reason ?? 'Capability unavailable'}`
      : definition.label;
    return (
      <button
        className="sidebar-nav-item"
        type="button"
        aria-current={isActive ? 'page' : undefined}
        data-active={isActive}
        data-locked={locked}
        title={title}
        onClick={() => onNavigate(page)}
      >
        <Icon
          name={ICONS[page] ?? 'box'}
          size={20}
          tone={locked ? 'disabled' : isActive ? 'primary' : 'secondary'}
          aria-hidden="true"
        />
        {open && (
          <>
            <span>{PAGE_LABELS[page]}</span>
            {locked && layoutPreferences.showStatusText && (
              <span className="sidebar-nav-status">Unavailable</span>
            )}
          </>
        )}
      </button>
    );
  }

  return (
    <aside className="app-sidebar" data-open={open} aria-label="Primary navigation">
      <div className="sidebar-header">
        {open ? (
          <>
            <div className="sidebar-brand">
              <span className="sidebar-brand-mark">
                <Icon name="cube" size={18} tone="disabled" aria-hidden="true" />
              </span>
              <span className="sidebar-brand-name">Spyderbyte</span>
            </div>
            <IconButton
              className="sidebar-collapse"
              icon="chevron-left"
              label="Collapse navigation"
              variant="secondary"
              onClick={onToggle}
            />
          </>
        ) : (
          <button
            className="sidebar-brand-mark"
            type="button"
            title="Expand navigation"
            aria-label="Expand navigation"
            onClick={onToggle}
          >
            <Icon name="cube" size={18} tone="disabled" aria-hidden="true" />
          </button>
        )}
      </div>

      <nav className="sidebar-nav" aria-label="Platform navigation">
        {layoutPreferences.pinnedPages.filter(
          (page) =>
            layoutPreferences.visiblePages.includes(page) &&
            !(personalLocal && ORGANIZATION_ONLY_PAGES.includes(page)),
        ).length > 0 && (
          <div className="sidebar-nav-group sidebar-nav-favorites">
            {open && <div className="sidebar-nav-heading">Favorites</div>}
            {layoutPreferences.pinnedPages
              .filter(
                (page) =>
                  layoutPreferences.visiblePages.includes(page) &&
                  !(personalLocal && ORGANIZATION_ONLY_PAGES.includes(page)),
              )
              .map((page) => (
                <NavBtn key={`favorite-${page}`} page={page} />
              ))}
          </div>
        )}
        {layoutPreferences.navigationGroups.map((group) => (
          <div className="sidebar-nav-group" key={group.label}>
            {open && <div className="sidebar-nav-heading">{group.label}</div>}
            {group.pages
              .filter((page) => !(personalLocal && ORGANIZATION_ONLY_PAGES.includes(page)))
              .map((page) => (
                <NavBtn key={page} page={page} />
              ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        {profileMenuOpen && (
          <div className="sidebar-profile-menu" role="menu" aria-label="Profile and theme settings">
            <div className="sidebar-profile-menu-heading">Personalize workspace</div>
            <button
              className="sidebar-profile-option"
              type="button"
              role="menuitem"
              onClick={() => {
                onOpenSettings?.('navigation');
                setProfileMenuOpen(false);
              }}
            >
              <Icon name="settings" size={16} tone="primary" aria-hidden="true" />
              <span className="sidebar-profile-option-copy">
                <span>Customize navigation</span>
                <small>Choose pages, groups, and Home widgets</small>
              </span>
            </button>
            <button
              className="sidebar-profile-option"
              type="button"
              role="menuitem"
              onClick={() => {
                onLayoutChange({
                  ...layoutPreferences,
                  density: layoutPreferences.density === 'compact' ? 'comfortable' : 'compact',
                });
              }}
            >
              <Icon name="grid" size={16} tone="secondary" aria-hidden="true" />
              <span className="sidebar-profile-option-copy">
                <span>
                  {layoutPreferences.density === 'compact'
                    ? 'Use comfortable spacing'
                    : 'Use compact spacing'}
                </span>
                <small>Adjust control and page density</small>
              </span>
            </button>
            <div className="sidebar-menu-divider" />
            <div className="sidebar-profile-menu-heading">Theme</div>
            <div className="sidebar-theme-options" role="radiogroup" aria-label="Theme">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className="sidebar-theme-option"
                  type="button"
                  role="radio"
                  aria-checked={theme === option.value}
                  data-active={theme === option.value}
                  onClick={() => setTheme(option.value)}
                >
                  <Icon
                    name={option.icon}
                    size={16}
                    tone={theme === option.value ? 'primary' : 'tertiary'}
                    aria-hidden="true"
                  />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="sidebar-profile-row">
          <button
            className="sidebar-avatar"
            type="button"
            title="Open profile settings"
            aria-label="Open profile settings"
            onClick={() => {
              onOpenSettings?.('profile');
              if (!onOpenSettings) onNavigate('settings');
            }}
          >
            {actorInitials}
          </button>
          {open && (
            <>
              <div className="sidebar-profile-copy">
                <div className="sidebar-profile-name">{actorName}</div>
                <div className="sidebar-profile-meta">
                  {personalLocal ? 'Personal workspace' : 'Workspace member'}
                </div>
              </div>
              <button
                className="sidebar-profile-trigger"
                type="button"
                aria-label="Open profile menu"
                aria-expanded={profileMenuOpen}
                onClick={() => setProfileMenuOpen((value) => !value)}
              >
                <Icon name="chevron-up" size={16} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
