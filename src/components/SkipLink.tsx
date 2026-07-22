// Visually hidden until focused; first tab stop on every page. Tailwind's
// sr-only + focus:not-sr-only handles the reveal — no custom CSS needed.
// z-[60] clears the sticky header (z-50), which paints later in DOM order and
// would otherwise cover the first tab stop on every page.
export default function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-neutral-900"
    >
      Skip to content
    </a>
  );
}
