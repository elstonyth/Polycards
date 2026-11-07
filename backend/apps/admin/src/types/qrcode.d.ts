// The one call the two-step setup page makes (routes/two-step-setup). The
// package ships no types of its own.
declare module 'qrcode' {
  export function toDataURL(
    text: string,
    options?: {
      margin?: number;
      width?: number;
      errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    },
  ): Promise<string>;
}
