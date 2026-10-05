import sharp from 'sharp';
import { MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';
import { POSTER_H, POSTER_W } from './brand-poster';

// 1080x1350, the 4:5 portrait size Facebook and Instagram feeds show whole
// (taller is cropped in the feed). Every image the Growth desk posts is this
// size: posters are drawn at it; anything drawn taller (the challenge poster,
// the Telegram pull card) is fitted onto it here.
const INK = { r: 10, g: 10, b: 10, alpha: 1 };

/** An image as 1080x1350: scaled to fit whole and centred on the posters'
 *  ink stage. One already that size is returned as it is. */
export async function fitToFeed(image: Buffer): Promise<Buffer> {
  const meta = await sharp(image, {
    limitInputPixels: MAX_DECODE_PIXELS,
  }).metadata();
  if (meta.width === POSTER_W && meta.height === POSTER_H) return image;
  return sharp(image, { limitInputPixels: MAX_DECODE_PIXELS })
    .resize(POSTER_W, POSTER_H, { fit: 'contain', background: INK })
    .flatten({ background: INK })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
}
