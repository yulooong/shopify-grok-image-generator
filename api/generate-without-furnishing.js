import sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

// ============================================================
// 🔀 PROVIDER TOGGLE — switch between 'grok' or 'openai'
// ============================================================
const API_PROVIDER = 'openai'; // 'grok' | 'openai'

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'hausframes', format: 'png', resource_type: 'image' },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

async function padToSquare(imageDataUri) {
  const base64Data = imageDataUri.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  const meta = await sharp(buffer).metadata();

  const { width, height } = meta;

  // ✅ Add 12% extra safety padding on each side so edge walls are never cropped
  const extraPad = Math.round(Math.max(width, height) * 0.12);
  const paddedWidth  = width  + extraPad * 2;
  const paddedHeight = height + extraPad * 2;
  const size = Math.max(paddedWidth, paddedHeight);

  const left = Math.floor((size - width)  / 2);
  const top  = Math.floor((size - height) / 2);

  const paddedBuffer = await sharp(buffer)
    .extend({
      top,
      bottom: size - height - top,
      left,
      right:  size - width  - left,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();

  const paddedDataUri = `data:image/png;base64,${paddedBuffer.toString('base64')}`;
  return { paddedDataUri, originalWidth: width, originalHeight: height, paddedSize: size, padLeft: left, padTop: top };
}

async function cropToOriginalRatio(buffer, originalWidth, originalHeight, paddedSize, padLeft, padTop) {
  const { width: outSize } = await sharp(buffer).metadata();
  const scale = outSize / paddedSize;

  const cropLeft   = Math.floor(padLeft * scale);
  const cropTop    = Math.floor(padTop  * scale);
  const cropWidth  = Math.min(Math.round(originalWidth  * scale), outSize - cropLeft);
  const cropHeight = Math.min(Math.round(originalHeight * scale), outSize - cropTop);

  return await sharp(buffer)
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .toBuffer();
}

async function buildTransparentFloorplan(floorplanBuffer) {
  const { data, info } = await sharp(floorplanBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixels  = new Uint8Array(data);
  const visited = new Uint8Array(width * height);

  function isLightPixel(idx) {
    const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
    // Must be very light
    const isLight = r > 220 && g > 220 && b > 220;
    // Must be neutral/grey — not warm wood tone
    // Wood: r-b ≈ 40+. White/grey background: r-b < 15
    const isNeutral = Math.abs(r - b) < 15 && Math.abs(r - g) < 15;
    return isLight && isNeutral;
  }

  const queue = [];
  // Seed from all four edges
  for (let x = 0; x < width; x++) {
    queue.push(0 * width + x);
    queue.push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    queue.push(y * width + 0);
    queue.push(y * width + (width - 1));
  }

  while (queue.length > 0) {
    const pos = queue.pop();
    if (visited[pos]) continue;
    const idx = pos * channels;
    if (!isLightPixel(idx)) continue;

    visited[pos] = 1;
    pixels[idx + 3] = 0; // make fully transparent

    const x = pos % width;
    const y = Math.floor(pos / width);
    if (x + 1 < width)  queue.push(pos + 1);
    if (x - 1 >= 0)     queue.push(pos - 1);
    if (y + 1 < height) queue.push(pos + width);
    if (y - 1 >= 0)     queue.push(pos - width);
  }

  return await sharp(pixels, { raw: { width, height, channels } })
    .png({ quality: 95, compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function generateWithGrok(imageDataUri, prompt) {
  if (!process.env.XAI_API_KEY) throw new Error('XAI_API_KEY is missing');

  const response = await fetch('https://api.x.ai/v1/images/edits', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'grok-imagine-image',
      prompt,
      image: { url: imageDataUri, type: 'image_url' },
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Grok API error');

  const url = data.data?.[0]?.url;
  if (!url) throw new Error('No image URL returned from Grok');
  return url;
}

async function generateWithOpenAI(imageDataUri, prompt) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');

  const base64Data = imageDataUri.replace(/^data:image\/\w+;base64,/, '');
  const rawBuffer = Buffer.from(base64Data, 'base64');
  const pngBuffer = await sharp(rawBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  const blob = new Blob([pngBuffer], { type: 'image/png' });
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('quality', 'low');
  form.append('prompt', prompt);
  form.append('image', blob, 'floorplan.png');

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenAI API error');

  const result = data.data?.[0];
  if (!result) throw new Error('No image returned from OpenAI');

  if (result.url) return result.url;
  if (result.b64_json) return `data:image/png;base64,${result.b64_json}`;

  throw new Error('Unexpected OpenAI response format');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { image: imageDataUri } = req.body || {};
    if (!imageDataUri) return res.status(400).json({ error: 'No image provided' });

    // ✅ Step 1: Pad to square with extra safety margin before sending to AI
    const { paddedDataUri, originalWidth, originalHeight, paddedSize, padLeft, padTop } =
      await padToSquare(imageDataUri);

    const finalPrompt = `
ROLE: Professional Architectural Model Maker & Industrial Designer
🛑 STRUCTURAL INTEGRITY (NON-NEGOTIABLE SOURCE OF TRUTH):
THE UPLOADED IMAGE IS THE ABSOLUTE BLUEPRINT.
DO NOT remove, shift, add, modify, or invent any structures, partitions, or interior elements.
The 3D walls must be a perfect 1:1 extrusion of the original lines.
Preserve the exact layout, room proportions, spatial geometry, and all interior elements of the uploaded file.

TASK:
Convert the uploaded floorplan into a high-fidelity 3D wooden "Site Model" photograph. Faithfully translate every element visible in the uploaded floorplan into the wooden material language defined below. Do not add, remove, or invent any elements.
FURNITURE TRANSLATION RULE:
If the uploaded floorplan contains furniture or interior outlines, translate every piece faithfully as a 2D engraved element.
If the uploaded floorplan contains no furniture, leave the interiors empty. Do not auto-populate or invent furniture.

CAMERA & VIEWPOINT:
View: Strict 90-degree Top-Down Orthographic Projection.
Lens: Zero perspective distortion, zero vanishing points.
Framing: The model must be centered and fill 85% of the frame.

MATERIAL & COLOR SPECS:
BASE: A single CNC-cut sheet of light birch wood (#F4E5CA).
WALLS (3D): Extruded 3D laser-cut wood blocks (#C6935C). 10mm height. Soft ambient occlusion shadows.
INTERIOR ELEMENTS (2D ENGRAVED): All furniture and fixtures as light birch wood engravings (#F4E5CA). 100% flat, no shadows.

CLEANLINESS & OUTPUT PROTOCOL:
REMOVAL: Wipe all text, room labels, dimensions, grid lines. No alphabetic or numeric characters.
BACKGROUND: Plain white background.
NO EXTRA ELEMENTS: No hands, rulers, tables, or studio props.

GUARDRAILS:
Walls must carry the shadow and 3D extruded effect.
Everything else must be strictly 2D, not raised, and cast no shadows.
Never invent. Never omit. Translate only what is shown.
    `.trim();

    // ✅ Step 2: Generate with padded square image
    let generatedUrl;
    if (API_PROVIDER === 'openai') {
      generatedUrl = await generateWithOpenAI(paddedDataUri, finalPrompt);
    } else {
      generatedUrl = await generateWithGrok(paddedDataUri, finalPrompt);
    }

    // ✅ Step 3: Download generated image
    let floorplanBuffer;
    if (generatedUrl.startsWith('data:')) {
      const base64Data = generatedUrl.replace(/^data:image\/\w+;base64,/, '');
      floorplanBuffer = Buffer.from(base64Data, 'base64');
    } else {
      const floorplanResp = await fetch(generatedUrl);
      if (!floorplanResp.ok) throw new Error('Failed to download generated image');
      floorplanBuffer = Buffer.from(await floorplanResp.arrayBuffer());
    }

    // ✅ Step 4: Crop back to original aspect ratio using exact pad offsets
    const croppedBuffer = await cropToOriginalRatio(
      floorplanBuffer, originalWidth, originalHeight, paddedSize, padLeft, padTop
    );

    // ✅ Step 5: Remove background, upload to Cloudinary
    const finalImageBuffer = await buildTransparentFloorplan(croppedBuffer);
    const hostedUrl = await uploadToCloudinary(finalImageBuffer);

    res.status(200).json({
      success: true,
      imageUrl: hostedUrl,
    });

  } catch (error) {
    console.error('❌ Crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
