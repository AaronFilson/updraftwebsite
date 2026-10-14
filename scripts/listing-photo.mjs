// Turns a shoot photo into a listing photo: a square crop centred on the piece, with the piece's longest
// side filling `fill` of the frame (the survey's sites show square product shots with the piece filling
// about 70-75%; the shop cards are square too), at most 2400 px. Without a box the whole photo is used.
// Boxes are [left, top, right, bottom] around the piece in the photo's pixels, measured on the upright
// photo, in the batch file's "crops".
import sharp from "sharp";

export async function listingJpeg(file, box, fill = 0.75) {
  if (!box) return sharp(file).rotate().resize({ width: 2400 }).jpeg({ quality: 85 }).toBuffer();
  const { width: W, height: H } = await sharp(file)
    .rotate()
    .toBuffer({ resolveWithObject: true })
    .then((r) => r.info);
  const [x0, y0, x1, y1] = box;
  const side = Math.min(W, H, Math.round(Math.max(x1 - x0, y1 - y0) / fill));
  const left = Math.round(Math.min(W - side, Math.max(0, (x0 + x1 - side) / 2)));
  const top = Math.round(Math.min(H - side, Math.max(0, (y0 + y1 - side) / 2)));
  return sharp(file)
    .rotate()
    .extract({ left, top, width: side, height: side })
    .resize({ width: Math.min(side, 2400) })
    .jpeg({ quality: 85 })
    .toBuffer();
}
