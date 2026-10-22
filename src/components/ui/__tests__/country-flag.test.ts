import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CountryFlag, starPoints } from '../country-flag';

describe('CountryFlag', () => {
  it('draws an n-pointed star as 2n points, starting at the top', () => {
    const points = starPoints(10, 10, 5, 4, 2).split(' ');
    expect(points).toHaveLength(10);
    expect(points[0]).toBe('10.00,6.00');
  });

  it("draws Singapore's five stars and Malaysia's fourteen-pointed star", () => {
    const sg = renderToStaticMarkup(
      createElement(CountryFlag, { country: 'SG' }),
    );
    const my = renderToStaticMarkup(
      createElement(CountryFlag, { country: 'MY' }),
    );
    expect(sg.match(/<polygon/g)).toHaveLength(5);
    expect(my.match(/<polygon/g)).toHaveLength(1);
    expect(my.match(/points="([^"]+)"/)?.[1]?.split(' ')).toHaveLength(28);
  });

  it('draws USDT as the Tether mark in the same 3:2 box as Singapore', () => {
    const usdt = renderToStaticMarkup(
      createElement(CountryFlag, { country: 'USDT' }),
    );
    expect(usdt).toContain('viewBox="0 0 30 20"');
    expect(usdt).toContain('fill="#26A17B"');
    expect(usdt).not.toContain('<polygon');
  });

  it('is decoration: hidden from screen readers', () => {
    const html = renderToStaticMarkup(
      createElement(CountryFlag, { country: 'MY' }),
    );
    expect(html).toContain('aria-hidden="true"');
  });
});
