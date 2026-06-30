// Minimal inline icon set (stroke, currentColor) — kept inline so the app stays
// fully offline with no icon-font CDN dependency.
type P = { size?: number; className?: string }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
})

export const Mic = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M6 11a6 6 0 0 0 12 0" />
    <line x1="12" y1="17" x2="12" y2="21" />
    <line x1="8" y1="21" x2="16" y2="21" />
  </svg>
)

export const Stop = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </svg>
)

export const Play = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none" />
  </svg>
)

export const Pause = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
  </svg>
)

export const Search = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.5" y2="16.5" />
  </svg>
)

export const Copy = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </svg>
)

export const Download = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3v12" />
    <path d="M7 11l5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
)

export const Trash = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6 7l1 13h10l1-13" />
  </svg>
)

export const Close = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </svg>
)

export const Refresh = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 12a8 8 0 0 1 14-5.3L20 8" />
    <path d="M20 4v4h-4" />
    <path d="M20 12a8 8 0 0 1-14 5.3L4 16" />
    <path d="M4 20v-4h4" />
  </svg>
)

export const CloudCheck = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A3.5 3.5 0 0 1 17 18z" />
    <path d="M9 14l2 2 3-3.5" />
  </svg>
)

export const ArrowDown = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <path d="M6 13l6 6 6-6" />
  </svg>
)

export const Alert = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3l9 16H3z" />
    <line x1="12" y1="10" x2="12" y2="14" />
    <circle cx="12" cy="17" r="0.6" fill="currentColor" />
  </svg>
)

export const Ear = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M7 9a5 5 0 0 1 10 0c0 3-2.5 3.5-3.5 5S12 17 12 19a2.5 2.5 0 0 1-5 0" />
    <path d="M9.5 9a2.5 2.5 0 0 1 5 0" />
  </svg>
)

export const Cloud = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A3.5 3.5 0 0 1 17 18z" />
  </svg>
)

export const Cpu = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3" />
  </svg>
)

export const Key = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M17 6l2 2M14 9l2 2" />
  </svg>
)
