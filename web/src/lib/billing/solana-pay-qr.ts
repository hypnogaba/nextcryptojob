import qrcode from "qrcode-generator";

/**
 * QR для посилання Solana Pay (п.8): server-side SVG, без клієнтського JS і без стороннього
 * сервісу зображень (жодного мережевого запиту для показу QR). `qrcode-generator` без залежностей,
 * лише матриця й обгортка SVG (не canvas): безпечно і в Worker, і в збірці Next.
 */
export function solanaPayQrSvg(uri: string): string {
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
