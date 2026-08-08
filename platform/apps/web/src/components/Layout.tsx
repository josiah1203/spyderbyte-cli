import type { ReactNode } from 'react';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import type { Page } from '../data/profiles';
import type { LayoutPreferences } from '../data/layout';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

interface LayoutProps {
  page: Page;
  pageTitle?: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNavigate: (page: Page) => void;
  layoutPreferences: LayoutPreferences;
  onLayoutChange: (next: LayoutPreferences) => void;
  onOpenSettings?: (tab?: string) => void;
  children: ReactNode;
}

function connectionMessage(connection: string): string {
  if (connection === 'booting') return 'Connecting to the platform…';
  if (connection === 'stale') return 'Authoritative platform data is catching up.';
  if (connection === 'disconnected') return 'Platform connection disconnected.';
  if (connection === 'unauthorized') return 'Platform session authorization is required.';
  if (connection === 'unavailable') return 'Platform service is unavailable.';
  return 'Platform service error.';
}

export default function Layout({
  page,
  pageTitle,
  sidebarOpen,
  onToggleSidebar,
  onNavigate,
  layoutPreferences,
  onLayoutChange,
  onOpenSettings,
  children,
}: LayoutProps) {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const sessionId = snapshot.session?.sessionId;
  const sessionLabel = sessionId === undefined ? 'Unavailable' : sessionId.slice(0, 12);
  const platformLabel = 'Platform service';
  const statusLabel = snapshot.connection === 'connected' ? 'Connected' : snapshot.connection;
  const bannerTone =
    snapshot.connection === 'error' || snapshot.connection === 'unauthorized'
      ? 'danger'
      : 'warning';

  return (
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        onToggle={onToggleSidebar}
        activePage={page}
        onNavigate={onNavigate}
        layoutPreferences={layoutPreferences}
        onLayoutChange={onLayoutChange}
        onOpenSettings={onOpenSettings}
      />

      <div className="app-main">
        <TopBar
          page={page}
          title={pageTitle}
          onNavigate={onNavigate}
          onCta={page === 'home' || page === 'projects' ? () => onNavigate('projects') : undefined}
        />
        {snapshot.connection !== 'connected' && (
          <div className="runtime-banner" data-tone={bannerTone} role="status">
            <strong>{connectionMessage(snapshot.connection)}</strong>
            {snapshot.lastError && (
              <span className="runtime-banner-copy">{snapshot.lastError}</span>
            )}
            <span className="runtime-banner-spacer" />
            {snapshot.connection !== 'booting' && (
              <button className="runtime-retry" type="button" onClick={() => void runtime.retry()}>
                Retry
              </button>
            )}
          </div>
        )}
        <main className="app-content">{children}</main>

        <footer className="app-footer">
          {[
            ['PLATFORM', platformLabel],
            ['SESSION', sessionLabel],
            ['STATUS', statusLabel],
          ].map(([key, value]) => (
            <span key={key} className="app-footer-item">
              <span className="app-footer-key">{key}:</span>
              <span className="app-footer-value">{value}</span>
            </span>
          ))}
          <span className="app-footer-spacer" />
          <span>© 2026 SPYDERBYTE · PLATFORM</span>
        </footer>
      </div>
    </div>
  );
}
