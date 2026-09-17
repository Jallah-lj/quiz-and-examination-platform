/** Compact inline icon set (stroke-based, 1.6px) — no icon-font dependency. */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 18, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: IconProps) => (
  <Base {...p}><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></Base>
);
export const IconExam = (p: IconProps) => (
  <Base {...p}><path d="M6 3h9l5 5v13H6z" /><path d="M15 3v5h5" /><path d="M9 13h6M9 17h4" /></Base>
);
export const IconQuiz = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8" /><path d="M12 17h.01" /></Base>
);
export const IconQuestions = (p: IconProps) => (
  <Base {...p}><path d="M4 5h16M4 10h16M4 15h10M4 20h7" /></Base>
);
export const IconBank = (p: IconProps) => (
  <Base {...p}><path d="M3 9l9-5 9 5v11H3z" /><path d="M8 20v-6h8v6" /></Base>
);
export const IconStudents = (p: IconProps) => (
  <Base {...p}><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M16 5.5a3 3 0 0 1 0 5.8M17 14c2.3.7 4 2.8 4 5.3" /></Base>
);
export const IconTeacher = (p: IconProps) => (
  <Base {...p}><path d="M3 7l9-4 9 4-9 4z" /><path d="M7 9.5V15c0 1.7 2.2 3 5 3s5-1.3 5-3V9.5" /></Base>
);
export const IconBuilding = (p: IconProps) => (
  <Base {...p}><path d="M4 21V5a1 1 0 0 1 1-1h7v17" /><path d="M12 9h6a1 1 0 0 1 1 1v11" /><path d="M7 8h2M7 12h2M7 16h2M15 13h1M15 17h1" /></Base>
);
export const IconLayers = (p: IconProps) => (
  <Base {...p}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></Base>
);
export const IconBook = (p: IconProps) => (
  <Base {...p}><path d="M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" /><path d="M17 7h2v13H8" /></Base>
);
export const IconGrade = (p: IconProps) => (
  <Base {...p}><path d="M4 20V6a1 1 0 0 1 1-1h9l5 5v10a1 1 0 0 1-1 1z" /><path d="M13 5v5h5" /><path d="M9 14l2 2 4-4" /></Base>
);
export const IconResults = (p: IconProps) => (
  <Base {...p}><path d="M4 20h16" /><rect x="5" y="11" width="3" height="6" /><rect x="10.5" y="7" width="3" height="10" /><rect x="16" y="13" width="3" height="4" /></Base>
);
export const IconReport = (p: IconProps) => (
  <Base {...p}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M9 12h6M9 16h6" /></Base>
);
export const IconAudit = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></Base>
);
export const IconSettings = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.4-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20 11a2 2 0 1 1 0 4z" /></Base>
);
export const IconBell = (p: IconProps) => (
  <Base {...p}><path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" /><path d="M10.5 20a2 2 0 0 0 3 0" /></Base>
);
export const IconUser = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5" /></Base>
);
export const IconLogout = (p: IconProps) => (
  <Base {...p}><path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" /><path d="M10 8l-4 4 4 4M6 12h9" /></Base>
);
export const IconSearch = (p: IconProps) => (
  <Base {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.3-4.3" /></Base>
);
export const IconPlus = (p: IconProps) => (<Base {...p}><path d="M12 5v14M5 12h14" /></Base>);
export const IconEdit = (p: IconProps) => (
  <Base {...p}><path d="M4 20h4l10-10-4-4L4 16z" /><path d="M14 6l4 4" /></Base>
);
export const IconTrash = (p: IconProps) => (
  <Base {...p}><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></Base>
);
export const IconCheck = (p: IconProps) => (<Base {...p}><path d="M5 13l4 4L19 7" /></Base>);
export const IconClose = (p: IconProps) => (<Base {...p}><path d="M6 6l12 12M18 6L6 18" /></Base>);
export const IconClock = (p: IconProps) => (<Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Base>);
export const IconFlag = (p: IconProps) => (
  <Base {...p}><path d="M5 3v18" /><path d="M5 4h11l-1.5 4L16 12H5z" /></Base>
);
export const IconChevronLeft = (p: IconProps) => (<Base {...p}><path d="M14 6l-6 6 6 6" /></Base>);
export const IconChevronRight = (p: IconProps) => (<Base {...p}><path d="M10 6l6 6-6 6" /></Base>);
export const IconDownload = (p: IconProps) => (
  <Base {...p}><path d="M12 4v11" /><path d="M8 11l4 4 4-4" /><path d="M5 19h14" /></Base>
);
export const IconEye = (p: IconProps) => (
  <Base {...p}><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.6" /></Base>
);
export const IconMenu = (p: IconProps) => (<Base {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Base>);
export const IconShield = (p: IconProps) => (
  <Base {...p}><path d="M12 3l7 3v6c0 4.4-3 8-7 9-4-1-7-4.6-7-9V6z" /><path d="M9.5 12l1.8 1.8 3.4-3.4" /></Base>
);
export const IconUsers = (p: IconProps) => (
  <Base {...p}><circle cx="8" cy="9" r="3" /><circle cx="16" cy="9" r="2.6" /><path d="M3 19c0-2.8 2.2-5 5-5s5 2.2 5 5" /><path d="M14 14.4c2.6.2 4.6 2.3 4.6 4.9" /></Base>
);
export const IconWarning = (p: IconProps) => (
  <Base {...p}><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" /></Base>
);
export const IconInfo = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Base>
);
export const IconInbox = (p: IconProps) => (
  <Base {...p}><path d="M4 13l2-8h12l2 8v6H4z" /><path d="M4 13h5l1 2h4l1-2h5" /></Base>
);
export const IconPrint = (p: IconProps) => (
  <Base {...p}><path d="M7 9V4h10v5" /><rect x="4" y="9" width="16" height="7" rx="1" /><path d="M7 16h10v4H7z" /></Base>
);
export const IconRefresh = (p: IconProps) => (
  <Base {...p}><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 5v4h-4" /></Base>
);
