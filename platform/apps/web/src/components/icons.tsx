import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'home'
  | 'projects'
  | 'database'
  | 'terminal'
  | 'chart'
  | 'play'
  | 'automation'
  | 'link'
  | 'notebook'
  | 'code'
  | 'cube'
  | 'deploy'
  | 'monitor'
  | 'check'
  | 'box'
  | 'settings'
  | 'catalog'
  | 'repository'
  | 'flask'
  | 'pipeline'
  | 'grid'
  | 'warning'
  | 'shield'
  | 'document'
  | 'git-branch'
  | 'network'
  | 'search'
  | 'bell'
  | 'microphone'
  | 'plus'
  | 'close'
  | 'user'
  | 'sun'
  | 'moon'
  | 'system'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-up'
  | 'arrow-left'
  | 'arrow-right'
  | 'download'
  | 'upload'
  | 'info'
  | 'success'
  | 'danger'
  | 'clock'
  | 'filter'
  | 'refresh'
  | 'sliders'
  | 'archive'
  | 'external-link'
  | 'more'
  | 'cpu'
  | 'memory'
  | 'storage';

export type IconTone =
  | 'neutral'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'disabled'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'color'> {
  name: IconName;
  size?: number;
  tone?: IconTone;
  label?: string;
}

const iconPaths: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="m3 10 9-7 9 7" />
      <path d="M5 9v10h14V9" />
      <path d="M9 19v-6h6v6" />
    </>
  ),
  projects: (
    <>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="M8 6V4h8v2" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v9c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 9c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </>
  ),
  terminal: (
    <>
      <path d="m5 7 5 5-5 5" />
      <path d="M13 17h6" />
    </>
  ),
  chart: (
    <>
      <path d="M4 19V9" />
      <path d="M10 19V5" />
      <path d="M16 19v-7" />
      <path d="M22 19H2" />
    </>
  ),
  play: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8 6 4-6 4V8Z" />
    </>
  ),
  automation: (
    <>
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  link: (
    <>
      <circle cx="7" cy="12" r="3" />
      <circle cx="17" cy="12" r="3" />
      <path d="M10 12h4" />
    </>
  ),
  notebook: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  code: (
    <>
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />
    </>
  ),
  cube: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
    </>
  ),
  deploy: (
    <>
      <path d="M12 3v12M7 8l5-5 5 5M5 21h14" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  check: (
    <>
      <path d="m5 12 4 4L19 6" />
    </>
  ),
  box: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
    </>
  ),
  catalog: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 3v18" />
    </>
  ),
  repository: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="12" r="2" />
      <path d="M6 8v8M8 6h8M8 18h8" />
    </>
  ),
  flask: (
    <>
      <path d="M9 3h6M10 3v6l-6 10h16L14 9V3" />
      <path d="M7 15h10" />
    </>
  ),
  pipeline: (
    <>
      <rect x="3" y="9" width="4" height="4" rx="1" />
      <rect x="10" y="4" width="4" height="4" rx="1" />
      <rect x="10" y="16" width="4" height="4" rx="1" />
      <rect x="17" y="9" width="4" height="4" rx="1" />
      <path d="M7 11h3M14 6l3 5M14 18l3-5" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  warning: (
    <>
      <path d="m12 3 9 17H3L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 20 6v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  document: (
    <>
      <path d="M6 3h8l4 4v14H6V3Z" />
      <path d="M14 3v5h5M9 12h6M9 16h6" />
    </>
  ),
  'git-branch': (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="19" r="2" />
      <circle cx="18" cy="5" r="2" />
      <path d="M6 7v4c0 2.2 1.8 4 4 4h6M18 7v10" />
    </>
  ),
  network: (
    <>
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="19" cy="18" r="2" />
      <path d="m7 11 10-4M7 13l10 4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  bell: (
    <>
      <path d="M6 10a6 6 0 0 1 12 0c0 5 2 5 2 7H4c0-2 2-2 2-7ZM10 21h4" />
    </>
  ),
  microphone: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12M18 6 6 18" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </>
  ),
  moon: (
    <>
      <path d="M20 15.5A8 8 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />
    </>
  ),
  system: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-up': <path d="m6 15 6-6 6 6" />,
  'arrow-left': (
    <>
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </>
  ),
  'arrow-right': (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  success: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  danger: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  filter: (
    <>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14-4L4 9" />
      <path d="M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2" />
      <path d="M20 20v-5h-5" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="11" cy="18" r="2" />
    </>
  ),
  archive: (
    <>
      <path d="M4 7h16v13H4V7ZM3 4h18v3H3V4Z" />
      <path d="M9 12h6" />
    </>
  ),
  'external-link': (
    <>
      <path d="M14 5h5v5M19 5l-8 8" />
      <path d="M18 13v6H5V6h6" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 9h6v6H9V9ZM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </>
  ),
  memory: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h2M11 10h2M15 10h2M7 14h2M11 14h2M15 14h2" />
    </>
  ),
  storage: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v4c0 1.7 3.6 3 8 3s8-1.3 8-3v-4" />
    </>
  ),
};

export default function Icon({ name, size = 20, tone, label, className, ...props }: IconProps) {
  const ariaProps = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <svg
      {...props}
      {...ariaProps}
      className={className ? `ds-icon ${className}` : 'ds-icon'}
      data-tone={tone}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {iconPaths[name]}
    </svg>
  );
}
