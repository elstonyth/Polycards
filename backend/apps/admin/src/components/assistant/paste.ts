// What a paste (or a drop) into the question box keeps: the text, the image
// files, or pictures lifted out of the HTML. Pure, so it is unit-tested.

export type PasteKeep = {
  /** Keep the text, tabs and line breaks as they are. */
  text: boolean;
  /** Attach the image files that came with it. */
  files: boolean;
  /** data: pictures from the HTML, when no image file came. */
  inline: string[];
};

// Office (Excel, PowerPoint, OneNote) and Google Sheets also put a picture of
// what was copied on the clipboard: their text is kept, never the picture.
const OFFICE = /urn:schemas-microsoft-com:office:|google-sheets-html-origin/i;
// Only data: sources: a remote <img> cannot be read (CORS). The space before
// src skips a lazy-load data-src, which holds a placeholder.
const DATA_IMG =
  /<img\b([^>]*?)\ssrc\s*=\s*["'](data:image\/[^"']+)["']([^>]*)/gi;
// A spacer or tracking pixel is not a picture anyone meant to send.
const onePx = (attrs: string) =>
  /\swidth\s*=\s*["']?1(?![\d.])/i.test(attrs) &&
  /\sheight\s*=\s*["']?1(?![\d.])/i.test(attrs);
// The name of an image file, which comes along as text with the file.
const FILE_NAME = /^[^\r\n]*\.(png|jpe?g|webp|gif|heic)$/i;

export function classifyPaste({
  html,
  text,
  imageCount,
}: {
  html: string;
  text: string;
  imageCount: number;
}): PasteKeep {
  const hasText = text.trim() !== '';
  // A bare <table> (another spreadsheet app) counts only without an <img>:
  // an email or web page keeps its real pictures.
  const sheet =
    OFFICE.test(html) ||
    (/[\t\n]/.test(text) && /<table/i.test(html) && !/<img/i.test(html));
  if (hasText && sheet) {
    return { text: true, files: false, inline: [] };
  }
  // An image file is the same picture as the HTML's: never both.
  const inline =
    imageCount > 0
      ? []
      : [...html.matchAll(DATA_IMG)]
          .filter(
            ([, before, url, after]) =>
              url.length >= 200 && !onePx(`${before}${after}`),
          )
          .map((m) => m[2]);
  const image = imageCount > 0 || inline.length > 0;
  return {
    text: hasText && !(image && FILE_NAME.test(text.trim())),
    files: imageCount > 0,
    inline,
  };
}
