import { PDFDocument } from 'pdf-lib';

// Photopea exports a high-quality JPEG for PDF composition. Embedding the
// original compressed JPEG avoids decoding a 500-DPI wraparound cover into a
// giant RGBA bitmap (which previously caused the 18-megapixel failure).
export async function composePdf(jpg, dpi) {
  if (!Number.isFinite(dpi) || dpi <= 0 || dpi > 2400) {
    throw new Error('Photopea did not report a valid document resolution.');
  }
  if (!Buffer.isBuffer(jpg) || jpg.length < 4 || jpg[0] !== 0xff || jpg[1] !== 0xd8) {
    throw new Error('Photopea did not return JPEG image data for PDF export.');
  }
  const doc = await PDFDocument.create();
  const image = await doc.embedJpg(jpg);
  if (!image.width || !image.height || image.width * image.height > 100_000_000) {
    throw new Error('PDF image dimensions exceed the 100-megapixel safety limit.');
  }
  const page = doc.addPage([72 * image.width / dpi, 72 * image.height / dpi]);
  page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  return Buffer.from(await doc.save());
}
