import type { SVGProps } from "react";

/**
 * A placeholder until the final glyph is ready: an oil lamp in profile with three stars leaving
 * its spout, on lucide's 24px grid so it sits beside the app's other icons. Replace this file to
 * change the icon everywhere the feature shows it.
 */
export function LampIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* The bowl's underside, running on into the spout, and its domed lid. */}
      <path d="M6.5 14.5C6.5 17.5 8.5 19 11.5 19c5 0 9-3.5 10-10.5" />
      <path d="M6.5 14.5c0-3 2-4.5 4-4.5 3 0 3.5 3.4 9.5 3.4" />
      {/* Ear handle, finial, ring foot. */}
      <path d="M7 12.2C5 11 2 11.8 2 14.5s3 3.5 5 2.3" />
      <path d="M10.5 8.6v.4" />
      <path d="M8.5 22h6" />
      <g fill="currentColor" stroke="none">
        <path d="M19.5.6q.7 2.3 3 3-2.3.7-3 3-.7-2.3-3-3 2.3-.7 3-3Z" />
        <path d="M14.8 4.3q.45 1.45 1.9 1.9-1.45.45-1.9 1.9-.45-1.45-1.9-1.9 1.45-.45 1.9-1.9Z" />
        <path d="M11.8 1.1q.35 1.15 1.5 1.5-1.15.35-1.5 1.5-.35-1.15-1.5-1.5 1.15-.35 1.5-1.5Z" />
      </g>
    </svg>
  );
}
