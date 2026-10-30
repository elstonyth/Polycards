// Mic, speaker and talk icons for voice (@medusajs/icons has none), drawn on
// the same 15px grid and stroke as its outline set.
type Props = { className?: string };

export function MicIcon({ className }: Props) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      aria-hidden
      className={className}
    >
      <rect
        x="5"
        y="1.5"
        width="5"
        height="8"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M2.75 7.25a4.75 4.75 0 0 0 9.5 0M7.5 12v1.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SpeakerIcon({ className }: Props) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M2 5.75h2.25L7.5 3v9L4.25 9.25H2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M10 5.25a3.25 3.25 0 0 1 0 4.5M11.75 3.5a5.75 5.75 0 0 1 0 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function WaveIcon({ className }: Props) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M1.75 6.5v2M4.6 4.5v6M7.5 2.25v10.5M10.4 4.5v6M13.25 6.5v2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
