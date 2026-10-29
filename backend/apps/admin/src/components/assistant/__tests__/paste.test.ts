import { describe, expect, it } from 'vitest';
import { classifyPaste } from '../paste';

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
        html: '<p>Hi</p><img alt="" src="data:image/png;base64,AAAA"><img src="https://x/y.png">',
        text: 'Hi',
        imageCount: 0,
      }),
    ).toEqual({
      text: true,
      files: false,
      inline: ['data:image/png;base64,AAAA'],
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
        html: "<meta charset='utf-8'><img src='data:image/jpeg;base64,BBBB'>",
        text: '',
        imageCount: 0,
      }),
    ).toEqual({
      text: false,
      files: false,
      inline: ['data:image/jpeg;base64,BBBB'],
    });
  });

  it('keeps plain text as it is', () => {
    expect(
      classifyPaste({ html: '', text: 'line one\nline two', imageCount: 0 }),
    ).toEqual({ text: true, files: false, inline: [] });
  });
});
