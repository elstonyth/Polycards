import sharp from 'sharp';
import type { Access } from '../access';
import { brandImage, generateImage, ImageRefused } from '../images';
import { resolvePeriod } from '../periods';
import { systemPrompt } from '../prompt';

describe('brandImage', () => {
  it('fits any image to 1080x1350 with the logo on it', async () => {
    const square = await sharp({
      create: { width: 512, height: 512, channels: 3, background: '#3355ff' },
    })
      .png()
      .toBuffer();
    const out = await brandImage(square);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([
      1080,
      1350,
      'jpeg',
    ]);
  });
});

describe('generateImage', () => {
  const answer = (body: object, status = 200) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;

  it('decodes the image the model returns, with its cost', async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    const out = await generateImage({
      key: 'k',
      model: 'm',
      prompt: 'p',
      fetchImpl: answer({
        usage: { cost: 0.04 },
        choices: [
          {
            message: {
              images: [
                {
                  image_url: {
                    url: `data:image/png;base64,${png.toString('base64')}`,
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    expect(out.cost).toBe(0.04);
    expect(out.buffer.equals(png)).toBe(true);
  });

  it('passes the model refusal on in words', async () => {
    await expect(
      generateImage({
        key: 'k',
        model: 'm',
        prompt: 'p',
        fetchImpl: answer({
          choices: [{ message: { content: 'I cannot draw that.' } }],
        }),
      }),
    ).rejects.toThrow(
      new ImageRefused(
        'The image model returned no image: I cannot draw that.',
      ),
    );
  });

  it('passes a provider error on', async () => {
    await expect(
      generateImage({
        key: 'k',
        model: 'm',
        prompt: 'p',
        fetchImpl: answer({ error: { message: 'Insufficient credits' } }, 402),
      }),
    ).rejects.toThrow('Insufficient credits');
  });
});

describe('resolvePeriod (same as the desk tools)', () => {
  // Thursday 2026-10-29 12:00 Malaysia time.
  const now = Date.parse('2026-10-29T12:00:00+08:00');
  it('reads today, yesterday and this week in Malaysia time', () => {
    expect(resolvePeriod('today', {}, now)).toMatchObject({
      from: '2026-10-28T16:00:00.000Z',
      to: '2026-10-29T16:00:00.000Z',
    });
    expect(resolvePeriod('yesterday', {}, now).from).toBe(
      '2026-10-27T16:00:00.000Z',
    );
    expect(resolvePeriod('this_week', {}, now).from).toBe(
      '2026-10-25T16:00:00.000Z',
    );
  });
  it('includes the last day of a custom range and rejects bad dates', () => {
    expect(
      resolvePeriod('custom', { from: '2026-10-01', to: '2026-10-02' }, now),
    ).toMatchObject({
      from: '2026-09-30T16:00:00.000Z',
      to: '2026-10-02T16:00:00.000Z',
    });
    expect(() => resolvePeriod('custom', { from: '2026-02-30' }, now)).toThrow(
      'not a real date',
    );
    expect(() => resolvePeriod('fortnight', {}, now)).toThrow('Unknown period');
  });
  it('reads last week, both months and the rolling windows like the desks', () => {
    expect(resolvePeriod('last_week', {}, now)).toMatchObject({
      from: '2026-10-18T16:00:00.000Z',
      to: '2026-10-25T16:00:00.000Z',
    });
    expect(resolvePeriod('this_month', {}, now)).toMatchObject({
      from: '2026-09-30T16:00:00.000Z',
      to: '2026-10-31T16:00:00.000Z',
    });
    const jan = Date.parse('2026-01-15T12:00:00+08:00');
    expect(resolvePeriod('last_month', {}, jan)).toMatchObject({
      from: '2025-11-30T16:00:00.000Z',
      to: '2025-12-31T16:00:00.000Z',
    });
    expect(resolvePeriod('last_7_days', {}, now)).toMatchObject({
      from: new Date(now - 7 * 864e5).toISOString(),
      to: new Date(now).toISOString(),
    });
  });
  it('leaves all time open', () => {
    expect(resolvePeriod('all_time', {}, now)).toEqual({
      from: null,
      to: null,
      label: 'all time',
    });
  });
});

describe('systemPrompt', () => {
  const access = (superAdmin: boolean): Access => ({
    userId: 'u',
    authIdentityId: '',
    roles: [],
    superAdmin,
    can: async () => superAdmin,
  });
  it('tells a limited role exactly which tools it may be answered from', () => {
    const p = systemPrompt(
      access(false),
      ['order', 'low_stock'],
      new Date('2026-10-29T04:00:00Z'),
    );
    expect(p).toContain(
      'They can only be answered from these tools: order, low_stock.',
    );
    expect(p).toContain('Thursday 2026-10-29 12:00 Malaysia time');
    expect(p).toMatch(/no access/);
  });
  it('tells the model an admin has full access, and the default-group rule', () => {
    const p = systemPrompt(access(true), ['economy']);
    expect(p).toContain('full access');
    expect(p).toContain("pass group 'default'");
  });
});
