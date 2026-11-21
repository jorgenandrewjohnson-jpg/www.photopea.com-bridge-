import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';

export async function composePdf(png, dpi) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width * height > 18_000_000) throw new Error('PDF export supports up to 18 megapixels. Use PSD/PNG or Photopea’s PDF export for larger files.');
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error('Photopea did not report a valid document resolution.');
  const { data } = PNG.sync.read(png);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha === 1) continue;
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] * alpha + 255 * (1 - alpha));
    data[i + 3] = 255;
  }
  const doc = await PDFDocument.create();
  const flattened = PNG.sync.write({ width, height, data }, { colorType: 2 });
  const image = await doc.embedPng(flattened);
  const page = doc.addPage([72 * width / dpi, 72 * height / dpi]);
  page.drawImage(image, page.getSize());
  return Buffer.from(await doc.save());
}
