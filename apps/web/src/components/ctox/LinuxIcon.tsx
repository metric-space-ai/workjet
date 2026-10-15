import type { SVGProps } from "react";

/** Pinguin für Linux-Rechner (lucide hat kein Linux-Symbol; Terminal bleibt Harness). */
export function LinuxIcon({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M9 4.5C9 3 10.3 2 12 2s3 1 3 2.5V7c0 1.4.8 2.4 1.8 3.7C18 12.2 19 14.2 19 16.5c0 1.6-1 2.5-2.2 2.5H7.2C6 19 5 18.1 5 16.5c0-2.3 1-4.3 2.2-5.8C8.2 9.4 9 8.4 9 7Z" />
      <path d="M10 14.5c0-1.4.9-2.5 2-2.5s2 1.1 2 2.5-.9 2.5-2 2.5-2-1.1-2-2.5Z" />
      <path d="M6.5 19 4 22h5l-1-3M17.5 19l2.5 3h-5l1-3" />
      <path d="M11 7.5h2l-1 1Z" />
    </svg>
  );
}
