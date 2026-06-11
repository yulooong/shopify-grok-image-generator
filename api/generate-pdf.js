import { PDFDocument } from 'pdf-lib';
import cloudinary from 'cloudinary';

cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export default async function handler(req, res) {
  // Handle CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { imageUrl } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ success: false, error: 'imageUrl is required' });
  }

  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) throw new Error('Failed to fetch image');
    const imageBytes = await imageResponse.arrayBuffer();

    const pdfDoc = await PDFDocument.create();
    const A4_WIDTH  = 595.28;
    const A4_HEIGHT = 841.89;
    const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);

    let image;
    const contentType = imageResponse.headers.get('content-type') || '';
    if (contentType.includes('png')) {
      image = await pdfDoc.embedPng(imageBytes);
    } else {
      image = await pdfDoc.embedJpg(imageBytes);
    }

    const padding = 40;
    const maxW = A4_WIDTH  - padding * 2;
    const maxH = A4_HEIGHT - padding * 2;
    const scaled = image.scaleToFit(maxW, maxH);

    const x = (A4_WIDTH  - scaled.width)  / 2;
    const y = (A4_HEIGHT - scaled.height) / 2;

    page.drawImage(image, { x, y, width: scaled.width, height: scaled.height });

    const pdfBytes = await pdfDoc.save();

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.v2.uploader.upload_stream(
        {
          resource_type: 'raw',
          format: 'pdf',
          folder: 'hausframes-pdfs',
          flags: 'attachment',
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      const buffer = Buffer.from(pdfBytes);
      stream.end(buffer);
    });

    return res.status(200).json({ success: true, pdfUrl: uploadResult.secure_url });

  } catch (err) {
    console.error('generate-pdf error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
