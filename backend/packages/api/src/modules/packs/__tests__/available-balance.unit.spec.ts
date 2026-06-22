import { lockedCentsFromCommissions } from "../available-balance";

describe("lockedCentsFromCommissions", () => {
  const now = 1_000_000;
  it("locks only pending-and-immature or suspended commission", () => {
    const locked = lockedCentsFromCommissions(
      [
        { status: "available", matures_at_ms: now - 1, amount_cents: 500 }, // free (available is spendable)
        { status: "pending", matures_at_ms: now + 1, amount_cents: 300 }, // LOCKED (pending + not matured)
        { status: "pending", matures_at_ms: now - 1, amount_cents: 250 }, // free (pending but matured → read-time gate releases)
        { status: "suspended", matures_at_ms: now - 1, amount_cents: 100 }, // LOCKED (suspended)
        { status: "reversed", matures_at_ms: now - 1, amount_cents: 50 }, // free (reversal already nets in the balance)
        { status: "available", matures_at_ms: now + 1, amount_cents: 200 }, // free (available is authoritative, even if matures_at is future)
        { status: "pending", matures_at_ms: now + 1, amount_cents: -100 }, // would-be-locked but negative → clamped to 0 (never reduces locked)
      ],
      now,
    );
    expect(locked).toBe(300 + 100); // the negative row contributes 0, not -100
  });
  it("locks nothing when everything is available or matured", () => {
    expect(
      lockedCentsFromCommissions(
        [
          { status: "available", matures_at_ms: now - 10, amount_cents: 999 },
          { status: "pending", matures_at_ms: now - 10, amount_cents: 888 }, // matured → free
        ],
        now,
      ),
    ).toBe(0);
  });
});
