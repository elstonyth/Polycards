'use client';

import { Component, type ReactNode } from 'react';

/**
 * The arena is an extra on whatever page is open. If its chunk fails to load (weak
 * data, a deploy since this tab opened) or it throws, the page must stay as it was:
 * the show just doesn't happen, and Results still has the draw.
 */
export class ArenaBoundary extends Component<
  { children: ReactNode; onFail: () => void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    this.props.onFail();
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
