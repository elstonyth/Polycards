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

// Excel and Google Sheets also put a picture of the copied cells on the
// clipboard: a range is kept as text only.
const SHEET =
  /urn:schemas-microsoft-com:office:excel|google-sheets-html-origin|<table/i;
// Only data: sources: a remote <img> cannot be read (CORS).
const DATA_IMG = /<img\b[^>]*?\bsrc\s*=\s*["'](data:image\/[^"']+)["']/gi;

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
  if (hasText && /[\t\n]/.test(text) && SHEET.test(html)) {
    return { text: true, files: false, inline: [] };
  }
  return {
    text: hasText,
    files: imageCount > 0,
    // An image file is the same picture as the HTML's: never both.
    inline: imageCount > 0 ? [] : [...html.matchAll(DATA_IMG)].map((m) => m[1]),
  };
}
