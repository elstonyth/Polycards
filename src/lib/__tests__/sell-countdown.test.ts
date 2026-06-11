import { describe, expect, it } from "vitest";
import {
  SELL_COUNTDOWN_SECS,
  SELL_HARD_CAP_MS,
  sellOfferDeadlineMs,
  sellSecondsLeft,
} from "../sell-countdown";

// The keep/sell offer at the pack reveal: 30s from when the card is shown,
// hard-capped at 75s from the open call so a user lingering on the tap-gated
// pre-card stages can never see a quote the server's 90s window won't honor.

const OPENED = 1_750_000_000_000;

describe("sellOfferDeadlineMs", () => {
  it("gives the full 30s countdown when the card is shown promptly", () => {
    const shownAt = OPENED + 5_000; // normal reveal animation time
    expect(sellOfferDeadlineMs(shownAt, OPENED)).toBe(
      shownAt + SELL_COUNTDOWN_SECS * 1000
    );
  });

  it("caps the deadline at 75s after the open when the user lingers pre-card", () => {
    const shownAt = OPENED + 60_000; // dawdled a minute on the tap-gated stages
    expect(sellOfferDeadlineMs(shownAt, OPENED)).toBe(OPENED + SELL_HARD_CAP_MS);
  });

  it("yields an already-expired deadline when the card is shown past the cap", () => {
    const shownAt = OPENED + 120_000;
    const deadline = sellOfferDeadlineMs(shownAt, OPENED);
    expect(sellSecondsLeft(deadline, shownAt)).toBe(0);
  });
});

describe("sellSecondsLeft", () => {
  it("rounds partial seconds up and never goes below zero", () => {
    const deadline = OPENED + 10_000;
    expect(sellSecondsLeft(deadline, OPENED)).toBe(10);
    expect(sellSecondsLeft(deadline, OPENED + 9_100)).toBe(1); // 0.9s left → 1
    expect(sellSecondsLeft(deadline, OPENED + 10_000)).toBe(0);
    expect(sellSecondsLeft(deadline, OPENED + 60_000)).toBe(0);
  });
});
