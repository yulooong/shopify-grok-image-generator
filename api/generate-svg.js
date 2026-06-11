import sharp from 'sharp';
import potrace from 'potrace';
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

function uploadSvgToCloudinary(svgString) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.from(svgString, 'utf8');
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'hausframes-svgs',
        resource_type: 'raw',
        format: 'svg',
        access_mode: 'public',
      },
      (error, result) => error ? reject(error) : resolve(result.secure_url)
    );
    stream.end(buffer);
  });
}

function traceToSvg(bitmapBuffer, options) {
  return new Promise((resolve, reject) => {
    potrace.trace(bitmapBuffer, options, (err, svg) => {
      if (err) reject(err);
      else resolve(svg);
    });
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ success: false });

  const { imageUrl } = req.body;
  if (!imageUrl) return res.status(400).json({ success: false, error: 'imageUrl is required' });

  try {
    // Step 1: Fetch the image
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) throw new Error('Failed to fetch image');
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    // Step 2: Convert to high-contrast greyscale bitmap for best trace quality
    const bitmapBuffer = await sharp(imageBuffer)
      .greyscale()
      .normalise()              // maximise contrast
      .threshold(128)           // convert to pure black & white
      .png()
      .toBuffer();

    // Step 3: Trace to SVG using potrace
    const svg = await traceToSvg(bitmapBuffer, {
      threshold: 128,
      turdSize: 10,             // remove specks smaller than this
      alphaMax: 1,              // corner smoothing (1 = sharp corners for CNC)
      optCurve: true,           // optimise curves
      optTolerance: 0.2,        // tighter = more accurate paths
      color: '#1a1a1a',
      background: 'transparent',
    });

    // Step 4: Upload SVG to Cloudinary
    const svgUrl = await uploadSvgToCloudinary(svg);

    return res.status(200).json({ success: true, svgUrl });

  } catch (err) {
    console.error('generate-svg error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
