import sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function downloadBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

    // ✅ Download all images in parallel
    const [bgBuf, qtBuf, fpBuf] = await Promise.all([
      downloadBuffer(bgUrl),
      qtUrl ? downloadBuffer(qtUrl).catch(() => null) : Promise.resolve(null),
      fpUrl ? downloadBuffer(fpUrl).catch(() => null) : Promise.resolve(null),
    ]);

    // ✅ Use background image's NATURAL dimensions — preserves portrait aspect ratio
    const bgMeta = await sharp(bgBuf).metadata();
    const W = bgMeta.width;
    const H = bgMeta.height;

    // Base: background at natural size
    const base = await sharp(bgBuf).png().toBuffer();
    const composite = [];

    // Layer 1: Quote overlay — top:2%, left:12%, width:76%
    if (qtBuf) {
      try {
        const qtMeta = await sharp(qtBuf).metadata();
        const qW = Math.round(W * 0.76);
        const qH = Math.round(qtMeta.height * (qW / qtMeta.width));
        const safeQH = Math.min(qH, H - Math.round(H * 0.02));
        const qtResized = await sharp(qtBuf)
          .resize(qW, safeQH, { fit: 'inside' })
          .png()
          .toBuffer();
        composite.push({
          input: qtResized,
          top: Math.round(H * 0.02),
          left: Math.round(W * 0.12),
        });
      } catch(e) { console.warn('Quote layer failed:', e.message); }
    }

    // Layer 2: Floorplan — top:29%, left:16%, width:68%, height:44%
    if (fpBuf) {
      try {
        const fpMeta = await sharp(fpBuf).metadata();
        const boxW  = Math.round(W * 0.68);
        const boxH  = Math.round(H * 0.44);
        const scale = Math.min(boxW / fpMeta.width, boxH / fpMeta.height);
        const dW    = Math.min(Math.round(fpMeta.width  * scale), boxW);
        const dH    = Math.min(Math.round(fpMeta.height * scale), boxH);
        const fpResized = await sharp(fpBuf)
          .resize(dW, dH)
          .png()
          .toBuffer();
        const fpX = Math.round(W * 0.16 + (boxW - dW) / 2);
        const fpY = Math.round(H * 0.29 + (boxH - dH) / 2);
        composite.push({ input: fpResized, top: fpY, left: fpX });
      } catch(e) { console.warn('Floorplan layer failed:', e.message); }
    }

    // ✅ Layer 3: Names + date as SVG — sized to match exact canvas dimensions
    if (names || date) {
      const esc = (s) => String(s)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;');

      const namesY       = Math.round(H * 0.855);
      const lineY        = namesY + Math.round(H * 0.018);
      const dateY        = lineY  + Math.round(H * 0.022);
      const lineX1       = Math.round(W * 0.35);
      const lineX2       = Math.round(W * 0.65);
      const fontSize     = Math.round(H * 0.032);
      const dateFontSize = Math.round(H * 0.014);

      const parts = [];

      if (names) {
        parts.push(`<text
          x="${Math.round(W / 2)}"
          y="${namesY}"
          font-family="Arial,Helvetica,sans-serif"
          font-size="${fontSize}"
          fill="#000000"
          text-anchor="middle"
          dominant-baseline="auto"
        >${esc(names)}</text>`);

        parts.push(`<line
          x1="${lineX1}" y1="${lineY}"
          x2="${lineX2}" y2="${lineY}"
          stroke="#000000" stroke-opacity="0.35" stroke-width="1"
        />`);
      }

      if (date) {
        parts.push(`<text
          x="${Math.round(W / 2)}"
          y="${dateY}"
          font-family="Arial,Helvetica,sans-serif"
          font-size="${dateFontSize}"
          fill="#000000"
          text-anchor="middle"
          letter-spacing="2"
          dominant-baseline="auto"
        >${esc(date.toUpperCase())}</text>`);
      }

      // ✅ SVG must be W×H — same dimensions as base image
      const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        ${parts.join('\n')}
      </svg>`;

      composite.push({ input: Buffer.from(svg), top: 0, left: 0 });
    }

    // Composite all layers onto background
    const finalBuffer = await sharp(base)
      .composite(composite)
      .jpeg({ quality: 90 })
      .toBuffer();

    // Upload to Cloudinary
    const uploadedUrl = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'hausframes/previews', format: 'jpg', resource_type: 'image' },
        (error, result) => { if (error) reject(error); else resolve(result.secure_url); }
      );
      stream.end(finalBuffer);
    });

    console.log('✅ Preview uploaded:', uploadedUrl);
    res.status(200).json({ success: true, url: uploadedUrl });

  } catch (error) {
    console.error('❌ Preview error:', error.message);
    res.status(500).json({ error: 'Failed: ' + error.message });
  }
}
