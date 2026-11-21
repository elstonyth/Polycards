import styles from './home-flow.module.css';

/** The paged part's spacers, in page order. */
const PAGED = ['row', 'band', 'lineup', 'exit'] as const;
/** After the free content: Return, then Last (its top is the wrap line). */
const END = ['return', 'last'] as const;

/**
 * Empty spacers that give the flow its scroll length. Zero height until the
 * flow chunk sets `data-flow-on` on the flow root (home-flow.module.css), so
 * without JavaScript, under reduced motion or before the chunk loads the page
 * is a plain document.
 */
export function FlowSpacers({ part }: { part: 'paged' | 'end' }) {
  return (part === 'paged' ? PAGED : END).map((name) => (
    <div
      key={name}
      aria-hidden
      data-flow-spacer={name}
      className={styles.spacer}
    />
  ));
}
