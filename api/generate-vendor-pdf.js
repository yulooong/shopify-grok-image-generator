// api/generate-vendor-pdf.js
// Accepts a base64 PNG of the A4 paper insert (quote + names + date),
// wraps it in a PDF, uploads to Cloudinary, and returns the URL.
// Supports both portrait (default) and landscape via the "orientation" field.
const { PDFDocument } = require('pdf-lib');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, orientation } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });

    // Decode the base64 PNG sent from the browser canvas
    const imageBytes = Buffer.from(imageBase64, 'base64');

    // Create PDF page – landscape only when explicitly requested
    const isLandscape = orientation === 'landscape';
    const pageWidth  = isLandscape ? 841.89 : 595.28; // 297 mm or 210 mm
    const pageHeight = isLandscape ? 595.28 : 841.89; // 210 mm or 297 mm

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const { width, height } = page.getSize();

    // Embed the PNG and stretch it to fill the full A4 page
    const pngImage = await pdfDoc.embedPng(imageBytes);
    page.drawImage(pngImage, { x: 0, y: 0, width, height });

    const pdfBytes = await pdfDoc.save();

    // Upload the PDF to Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          folder: 'hausframes/vendor-pdfs',
          format: 'pdf',
          flags: 'attachment',
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      );
      const readable = new Readable();
      readable.push(Buffer.from(pdfBytes));
      readable.push(null);
      readable.pipe(stream);
    });

    return res.status(200).json({ success: true, pdfUrl: uploadResult.secure_url });
  } catch (err) {
    console.error('[generate-vendor-pdf] Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
