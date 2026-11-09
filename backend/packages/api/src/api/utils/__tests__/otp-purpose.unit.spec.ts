import { warmSignupProofClaims } from '../rate-limit';
import {
  dropPendingCode,
  forgetPurpose,
  holdStart,
  notePurposeSent,
  pendingCode,
  SEND_BY_MS,
  START_HOLD_MS,
} from '../otp-purpose';

// The real claim store the routes use: one start per number, and a code's
// flow recorded only under that start's hold.
const SID_A = 'VE' + 'a'.repeat(32);
const SID_B = 'VE' + 'b'.repeat(32);

describe('otp-purpose', () => {
  it('lets a start that was overtaken neither send nor record', async () => {
    const phone = '+60100000001';
    const signup = await holdStart(phone);
    expect(signup).not.toBeNull();
    expect(await holdStart(phone)).toBeNull();

    // Its hold runs out mid-start, and a reset start takes the number.
    await warmSignupProofClaims().release(`otp-start:${phone}`);
    const reset = await holdStart(phone);
    expect(reset).not.toBeNull();
    expect(await reset!.note('password-reset', SID_B)).toBe(true);

    // The stalled sign-up start resumes: no longer held, so it sends nothing,
    // and its record cannot replace the reset's.
    expect(await signup!.held()).toBe(false);
    expect(await signup!.note('signup', SID_A)).toBe(false);
    expect(await pendingCode(phone)).toEqual({
      purpose: 'password-reset',
      sid: SID_B,
    });

    // Its late release leaves the reset start's hold in place.
    await signup!.release();
    expect(await reset!.held()).toBe(true);
    await reset!.release();
    expect(await holdStart(phone)).not.toBeNull();
  });

  it('sends only while the hold is sure to outlive the send', async () => {
    // A send gives up after Twilio's 10 s; the hold must last past the latest
    // send that may start, so nothing can overtake a start mid-send.
    expect(START_HOLD_MS).toBeGreaterThanOrEqual(SEND_BY_MS + 10_000);
    const phone = '+60100000003';
    const now = jest.spyOn(Date, 'now');
    try {
      const t0 = 1_800_000_000_000;
      now.mockReturnValue(t0);
      const hold = await holdStart(phone);
      now.mockReturnValue(t0 + SEND_BY_MS - 1);
      expect(await hold!.held()).toBe(true);
      // Past the deadline it no longer counts as held, so it sends nothing.
      now.mockReturnValue(t0 + SEND_BY_MS);
      expect(await hold!.held()).toBe(false);
      await hold!.release();
    } finally {
      now.mockRestore();
    }
  });

  it('a check finds no flow for a code whose cancel was not confirmed', async () => {
    const phone = '+60100000004';
    await notePurposeSent(phone, 'password-reset', SID_B);
    await dropPendingCode(phone);
    expect(await pendingCode(phone)).toBeNull();
  });

  it('cleans up only the record a check read', async () => {
    const phone = '+60100000002';
    await notePurposeSent(phone, 'signup', SID_A);
    const read = await pendingCode(phone);
    // A newer start records its own code before the older check cleans up.
    await notePurposeSent(phone, 'password-reset', SID_B);
    await forgetPurpose(phone, read!);
    expect((await pendingCode(phone))?.purpose).toBe('password-reset');
    await forgetPurpose(phone, (await pendingCode(phone))!);
    expect(await pendingCode(phone)).toBeNull();
  });
});
