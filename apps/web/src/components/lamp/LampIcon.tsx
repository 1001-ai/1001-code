import type { SVGProps } from "react";

/**
 * A placeholder oil lamp, drawn on lucide's 24px grid so it sits beside the app's other icons.
 * Replace this file to change the icon everywhere the feature shows it.
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
      <path d="M12 9V7.5" />
      <path d="M9.5 12a2.5 2.5 0 0 1 5 0" />
      <path d="M7 12h10c0 3.2-2 5.5-5 5.5-2 0-3.6-1-4.4-2.7C5.6 14.2 4.4 11.6 2 9.5c2 .3 3.6 1.2 5 2.5Z" />
      <path d="M17 12.6c1.8-1.7 4-1.2 4 .6 0 1.9-2.5 3-4.6 2.6" />
      <path d="M12 17.5V20" />
      <path d="M9 20h6" />
    </svg>
  );
}
