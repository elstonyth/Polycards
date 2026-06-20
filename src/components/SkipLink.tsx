// Visually hidden until focused; first tab stop on every page. Tailwind's
// sr-only + focus:not-sr-only handles the reveal — no custom CSS needed.
export default function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-neutral-900"
    >
      Skip to content
    </a>
  );
}
