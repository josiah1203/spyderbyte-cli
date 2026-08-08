import { useEffect, useRef, useState } from 'react';
import { PAGE_CTA, PAGE_LABELS, type Page } from '../data/profiles';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useNotifications } from '../runtime/store';
import Icon from './icons';
import GlobalSearch from './GlobalSearch';
import { Button, IconButton } from './primitives';

interface TopBarProps {
  page: Page;
  title?: string;
  onCta?: () => void;
  onNavigate?: (page: Page) => void;
}

export default function TopBar({ page, title, onCta, onNavigate }: TopBarProps) {
  const displayTitle = title ?? PAGE_LABELS[page] ?? '';
  const cta = PAGE_CTA[page];
  const runtime = useRuntime();
  const { data: notifications, unreadCount, markRead, markAllRead } = useNotifications(runtime);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        drawerRef.current &&
        !drawerRef.current.contains(event.target as Node) &&
        bellRef.current &&
        !bellRef.current.contains(event.target as Node)
      ) {
        setNotificationsOpen(false);
      }
    }
    if (notificationsOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [notificationsOpen]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        setNotificationsOpen(false);
      }
      if (event.key === 'Escape') {
        setSearchOpen(false);
        setNotificationsOpen(false);
      }
    }
    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, []);

  function relativeTime(value: string): string {
    const elapsed = Math.max(0, Date.now() - Date.parse(value));
    if (!Number.isFinite(elapsed)) return value;
    const seconds = Math.round(elapsed / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  return (
    <>
      <header className="app-topbar">
        <span className="topbar-title">{displayTitle}</span>

        <button
          type="button"
          className="topbar-search"
          aria-label="Search everything"
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen(true);
            setNotificationsOpen(false);
          }}
        >
          <Icon name="search" size={16} tone="tertiary" aria-hidden="true" />
          <span className="topbar-search-text">Search everything…</span>
          <span className="ds-kbd">⌘K</span>
        </button>

        <div className="topbar-notification-wrap">
          <IconButton
            ref={bellRef}
            icon="bell"
            label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
            variant="secondary"
            aria-expanded={notificationsOpen}
            aria-controls="notifications-panel"
            onClick={() => {
              setNotificationsOpen((open) => !open);
              setSearchOpen(false);
            }}
          />
          {unreadCount > 0 && <span className="topbar-notification-count">{unreadCount}</span>}
          {notificationsOpen && (
            <div
              ref={drawerRef}
              id="notifications-panel"
              className="topbar-notification-panel"
              role="dialog"
              aria-label="Notifications"
            >
              <div className="topbar-notification-header">
                <div>
                  <span className="topbar-notification-title">Notifications</span>
                  <span className="topbar-notification-meta">
                    {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
                  </span>
                </div>
                {unreadCount > 0 && (
                  <button className="text-action" type="button" onClick={markAllRead}>
                    Mark all read
                  </button>
                )}
              </div>
              <div className="topbar-notification-list">
                {notifications.length === 0 ? (
                  <div className="topbar-notification-empty">
                    <Icon name="bell" size={18} tone="tertiary" aria-hidden="true" />
                    <span>
                      New run, approval, connector, and deployment events will appear here.
                    </span>
                  </div>
                ) : (
                  notifications.slice(0, 12).map((notification) => (
                    <button
                      key={notification.notificationId}
                      type="button"
                      className="topbar-notification-item"
                      data-read={notification.read}
                      data-tone={notification.tone}
                      onClick={() => {
                        markRead(notification.notificationId);
                        if (notification.page) onNavigate?.(notification.page);
                        setNotificationsOpen(false);
                      }}
                    >
                      <span className="topbar-notification-item-dot" aria-hidden="true" />
                      <span className="topbar-notification-item-copy">
                        <strong>{notification.title}</strong>
                        <span>{notification.message}</span>
                        <small>{relativeTime(notification.occurredAt)}</small>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {cta && onCta && (
          <Button variant="primary" className="topbar-cta" onClick={onCta}>
            <Icon name="plus" size={16} aria-hidden="true" />
            {cta}
          </Button>
        )}
      </header>
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
