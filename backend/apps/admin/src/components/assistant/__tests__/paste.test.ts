import { describe, expect, it } from 'vitest';
import { classifyPaste } from '../paste';

// A real picture: placeholders under 200 characters are skipped.
const PNG = `data:image/png;base64,${'A'.repeat(200)}`;
const JPEG = `data:image/jpeg;base64,${'B'.repeat(200)}`;

describe('classifyPaste', () => {
  it('keeps an Excel range as text and skips the picture of its cells', () => {
    expect(
      classifyPaste({
        html: '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><table><tr><td>a</td></tr></table>',
        text: 'Card\tPrice\r\nMew\t12\r\n',
        imageCount: 1,
      }),
    ).toEqual({ text: true, files: false, inline: [] });
  });

  it('keeps a Google Sheets range as text', () => {
    expect(
      classifyPaste({
        html: '<google-sheets-html-origin><table><tr><td>a</td><td>b</td></tr></table>',
        text: 'a\tb',
        imageCount: 0,
      }),
    ).toEqual({ text: true, files: false, inline: [] });
  });

  it('keeps the text and attaches the image from a web page', () => {
    expect(
      classifyPaste({
        html: '<p>Look at this</p><img src="https://cdn.example/x.png">',
        text: 'Look at this',
        imageCount: 1,
      }),
    ).toEqual({ text: true, files: true, inline: [] });
  });

  it('lifts a data: picture from the HTML next to the text when no file came', () => {
    expect(
      classifyPaste({
        html: `<p>Hi</p><img alt="" src="${PNG}"><img src="https://x/y.png">`,
        text: 'Hi',
        imageCount: 0,
      }),
    ).toEqual({
      text: true,
      files: false,
      inline: [PNG],
    });
  });

  it('attaches an image only, with no text', () => {
    expect(
      classifyPaste({
        html: '<img src="https://cdn.example/x.png">',
        text: '',
        imageCount: 1,
      }),
    ).toEqual({ text: false, files: true, inline: [] });
    expect(
      classifyPaste({
        html: `<meta charset='utf-8'><img src='${JPEG}'>`,
        text: '',
        imageCount: 0,
      }),
    ).toEqual({
      text: false,
      files: false,
      inline: [JPEG],
    });
  });

  it('keeps both from an email table with a real picture', () => {
    expect(
      classifyPaste({
        html: '<table><tr><td>Total</td><td>RM 12</td></tr></table><img src="cid:x">',
        text: 'Total\tRM 12\n',
        imageCount: 1,
      }),
    ).toEqual({ text: true, files: true, inline: [] });
  });

  it('keeps one Office cell or slide as text without a tab', () => {
    expect(
      classifyPaste({
        html: '<html xmlns:o="urn:schemas-microsoft-com:office:office"><p>Mew</p>',
        text: 'Mew',
        imageCount: 1,
      }),
    ).toEqual({ text: true, files: false, inline: [] });
  });

  it("drops a file's name that comes along with its picture", () => {
    expect(
      classifyPaste({ html: '', text: 'Screenshot 2026.PNG', imageCount: 1 }),
    ).toEqual({ text: false, files: true, inline: [] });
    expect(
      classifyPaste({
        html: `<img src="${PNG}">`,
        text: 'a.webp',
        imageCount: 0,
      }),
    ).toEqual({ text: false, files: false, inline: [PNG] });
    // Text alone that only looks like a name stays.
    expect(classifyPaste({ html: '', text: 'a.png', imageCount: 0 })).toEqual({
      text: true,
      files: false,
      inline: [],
    });
  });

  it('ignores data-src, short placeholders and 1x1 pixels', () => {
    expect(
      classifyPaste({
        html: [
          `<img data-src="${PNG}" src="https://x/y.png">`,
          '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
          `<img width="1" height=1 src="${JPEG}">`,
        ].join(''),
        text: 'Hi',
        imageCount: 0,
      }),
    ).toEqual({ text: true, files: false, inline: [] });
  });

  it('keeps plain text as it is', () => {
    expect(
      classifyPaste({ html: '', text: 'line one\nline two', imageCount: 0 }),
    ).toEqual({ text: true, files: false, inline: [] });
  });
});
