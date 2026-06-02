import sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to download: ' + url);
  return Buffer.from(await res.arrayBuffer());
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { bgUrl, fpUrl, qtUrl, names, date } = req.body || {};
    if (!bgUrl) return res.status(400).json({ error: 'bgUrl required' });

    const SIZE = 800;
    const composite = [];

    // Layer 1: Frame background
    const bgBuf = await downloadBuffer(bgUrl);
    const bgResized = await sharp(bgBuf).resize(SIZE, SIZE).png().toBuffer();
    composite.push({ input: bgResized, top: 0, left: 0 });

    // Layer 2: Quote overlay — top:2%, left:12%, width:76%
    if (qtUrl) {
      try {
        const qtBuf  = await downloadBuffer(qtUrl);
        const qtMeta = await sharp(qtBuf).metadata();
        const qW = Math.round(SIZE * 0.76);
        const qH = Math.round(qtMeta.height * (qW / qtMeta.width));
        const qtResized = await sharp(qtBuf).resize(qW, qH).png().toBuffer();
        composite.push({ input: qtResized, top: Math.round(SIZE * 0.02), left: Math.round(SIZE * 0.12) });
      } catch(e) { console.warn('Quote layer failed:', e.message); }
    }

    // Layer 3: Floorplan — top:29%, left:16%, width:68%, height:44% (object-fit:contain)
    if (fpUrl) {
      try {
        const fpBuf  = await downloadBuffer(fpUrl);
        const fpMeta = await sharp(fpBuf).metadata();
        const boxW   = Math.round(SIZE * 0.68);
        const boxH   = Math.round(SIZE * 0.44);
        const scale  = Math.min(boxW / fpMeta.width, boxH / fpMeta.height);
        const dW     = Math.round(fpMeta.width  * scale);
        const dH     = Math.round(fpMeta.height * scale);
        const fpResized = await sharp(fpBuf).resize(dW, dH).png().toBuffer();
        const fpX = Math.round(SIZE * 0.16 + (boxW - dW) / 2);
        const fpY = Math.round(SIZE * 0.29 + (boxH - dH) / 2);
        composite.push({ input: fpResized, top: fpY, left: fpX });
      } catch(e) { console.warn('Floorplan layer failed:', e.message); }
    }

    // Layer 4: Names + date as SVG text overlay
    if (names || date) {
      const esc = function(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      };
      const parts = [];
      if (names) {
        parts.push('<text x="400" y="690" font-family="Georgia,serif" font-size="30" fill="#000000" text-anchor="middle">' + esc(names) + '</text>');
        parts.push('<line x1="310" y1="697" x2="490" y2="697" stroke="rgba(0,0,0,0.35)" stroke-width="1"/>');
      }
      if (date) {
        parts.push('<text x="400" y="708" font-family="Arial,sans-serif" font-size="13" fill="#000000" text-anchor="middle" letter-spacing="2">' + esc(date.toUpperCase()) + '</text>');
      }
      const svg = '<svg width="' + SIZE + '" height="' + SIZE + '" xmlns="http://www.w3.org/2000/svg">' + parts.join('') + '</svg>';
      composite.push({ input: Buffer.from(svg), top: 0, left: 0 });
    }

    // Composite all layers onto white base
    const finalBuffer = await sharp({
      create: { width: SIZE, height: SIZE, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
    })
    .composite(composite)
    .jpeg({ quality: 88 })
    .toBuffer();

    // Upload to Cloudinary
    const uploadedUrl = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'hausframes/previews', format: 'jpg', resource_type: 'image' },
        (error, result) => { if (error) reject(error); else resolve(result.secure_url); }
      );
      stream.end(finalBuffer);
    });

    res.status(200).json({ success: true, url: uploadedUrl });
  } catch (error) {
    console.error('Preview error:', error);
    res.status(500).json({ error: 'Failed: ' + error.message });
  }
}
