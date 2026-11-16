import type { SVGProps } from "react";

const STROKE = 1.5;
/** A filled part's fine edge is drawn for a 2-unit stroke and thins in step with the lamp's. */
const edge = (width: number) => (width * STROKE) / 2;

/**
 * The agent's lamp with three stars: the drawing in `assets/1001/lamp.svg`, on lucide's 24-unit
 * grid. It shares its box with its stars, so beside 16px icons it wants 18 to 20px, and the 1.5
 * stroke keeps the handle's loop open there. Replace this file to change the icon everywhere.
 */
export function LampIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0.5 0.5 23 23"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* Bowl and spout as one filled curve, the lid's finial, the open handle, the foot. */}
      <path
        fill="currentColor"
        d="M5.5 15.6C5.5 13.2 7.6 11.7 10.2 11.7C12.6 11.7 13.9 13.5 15.9 13.9C17.7 14.2 19.5 14 20.3 12.9C20.86 12.13 21.15 11.5 21.2 10.8C21.8 14.3 18.8 19.5 10.6 19.5C7.6 19.5 5.5 17.8 5.5 15.6Z"
      />
      <path
        fill="currentColor"
        strokeWidth={edge(0.7)}
        d="M8.4 11.8C9.4 11.6 9.55 10.82 9.55 10.25A.65 .65 0 0 1 10.85 10.25C10.85 10.82 11 11.6 12 11.8Z"
      />
      <path d="M6.3 13.1C4.2 12.4 2 13.4 2 15.3C2 17.2 3.9 18.1 6 17.5" />
      <path d="M7.9 21.5h5.4" />
      <g fill="currentColor">
        <path
          strokeWidth={edge(0.6)}
          d="M11.4 2.15Q11.7 3 12.55 3.3Q11.7 3.6 11.4 4.45Q11.1 3.6 10.25 3.3Q11.1 3 11.4 2.15Z"
        />
        <path
          strokeWidth={edge(0.7)}
          d="M14.5 5.2Q14.91 6.49 16.2 6.9Q14.91 7.31 14.5 8.6Q14.09 7.31 12.8 6.9Q14.09 6.49 14.5 5.2Z"
        />
        <path
          strokeWidth={edge(0.9)}
          d="M19.5 1.8Q20.08 4.12 22.4 4.7Q20.08 5.28 19.5 7.6Q18.92 5.28 16.6 4.7Q18.92 4.12 19.5 1.8Z"
        />
      </g>
    </svg>
  );
}
