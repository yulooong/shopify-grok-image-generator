import sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

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

// ✅ Uploads the original customer image to Cloudinary and returns its URL
async function uploadOriginalToCloudinary(imageDataUri) {
  const base64Data = imageDataUri.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'hausframes/originals', resource_type: 'image' },
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

  const extraPad = Math.round(Math.max(width, height) * 0.15);
  const size = Math.max(width, height) + extraPad * 2;

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
  return { paddedDataUri, originalWidth: width, originalHeight: height };
}

async function buildTransparentFloorplan(floorplanBuffer, originalWidth, originalHeight) {
  const { data, info } = await sharp(floorplanBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixels  = new Uint8Array(data);
  const visited = new Uint8Array(width * height);

  function isLightPixel(idx) {
    const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
    const isLight   = r > 220 && g > 220 && b > 220;
    const isNeutral = Math.abs(r - b) < 15 && Math.abs(r - g) < 15;
    return isLight && isNeutral;
  }

  const queue = [];
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
    pixels[idx + 3] = 0;

    const x = pos % width;
    const y = Math.floor(pos / width);
    if (x + 1 < width)  queue.push(pos + 1);
    if (x - 1 >= 0)     queue.push(pos - 1);
    if (y + 1 < height) queue.push(pos + width);
    if (y - 1 >= 0)     queue.push(pos - width);
  }

  const transparentBuffer = await sharp(pixels, { raw: { width, height, channels } })
    .png()
    .toBuffer();

  const trimmedBuffer = await sharp(transparentBuffer)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
    .png()
    .toBuffer();

  return await sharp(trimmedBuffer)
    .resize(originalWidth, originalHeight, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
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
  // form.append('model', 'gpt-image-2');
  form.append('model', 'gpt-image-2.5-sunburst');
  form.append('quality', 'medium');
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

    // ✅ Step 1: Upload original customer image to Cloudinary immediately
    // This URL will appear in the Shopify order after payment completes
    const originalUrl = await uploadOriginalToCloudinary(imageDataUri);

    // ✅ Step 2: Pad to square with 15% safety margin, record original dimensions
    const { paddedDataUri, originalWidth, originalHeight } =
      await padToSquare(imageDataUri);

    const finalPrompt = `
ROLE: Professional Architectural Model Maker, Industrial Designer and Precision Laser-Cutting Specialist.

Your task is to transform the uploaded floorplan into a premium, photorealistic 2D wooden floorplan artwork.

The final product should resemble a professionally manufactured, laser-cut and laser-engraved wooden floorplan, photographed directly from above.

# 1. ABSOLUTE PRIORITY: STRUCTURAL ACCURACY

THE UPLOADED IMAGE IS THE SOLE SOURCE OF TRUTH.

Treat the uploaded floorplan as a fixed architectural blueprint, NOT as a reference or creative inspiration.

Preserve the original geometry with the highest possible accuracy.

NON-NEGOTIABLE RULES:
- Do not add, remove, move, resize, rotate, merge or reinterpret any physical structural element.
- Preserve the exact positions, lengths, thicknesses and orientations of all walls.
- Preserve every wall intersection, corner, partition, doorway, opening and passage.
- Do not close existing openings or create new ones.
- Preserve the exact room layout, proportions and spatial relationships.
- Do not straighten, simplify, smooth or optimise the original architectural geometry.
- Never substitute an approximate reconstruction for an original detail.

The walls must follow the original floorplan lines as faithfully as possible.

PRIORITY HIERARCHY:
1. Structural and geometric accuracy.
2. Preservation of all original physical interior elements.
3. Correct distinction between solid-filled walls and engraved interior elements.
4. Material and colour accuracy.
5. Photographic realism and visual aesthetics.

If any artistic enhancement conflicts with structural accuracy, ALWAYS prioritise structural accuracy.

# 2. INTERIOR ELEMENTS & FURNITURE TRANSLATION

Faithfully translate every visible furniture item, fixture and physical interior detail into a flat 2D engraved representation.

Examples include:
- Beds, sofas, chairs and dining tables.
- Kitchen counters and cabinets.
- Toilets, sinks, bathtubs and shower areas.
- Wardrobes and storage units.
- Other furniture and fixtures visible in the original floorplan.

STRICT RULES:
- Every original physical furniture item must be retained.
- Preserve its original position, orientation, shape and relative proportions.
- All furniture and fixtures must remain completely flat.
- Represent furniture through engraved outlines and details on the birch surface.
- Never turn furniture into 3D miniature objects.
- Never create raised surfaces, additional wooden blocks or physical depth for interior elements.
- Do not automatically furnish empty rooms.
- If the original floorplan contains no furniture, leave those areas empty.

If an element is ambiguous, preserve its original shape and position rather than guessing its identity or inventing a replacement.

# 3. ARCHITECTURAL ANNOTATION & LINE CLEANUP

The final wooden floorplan must represent the actual physical architectural layout, NOT the technical drafting annotations of the original floorplan.

REMOVE all non-physical reference markings and drafting annotations, including:
- Dotted and dashed lines.
- Dashed measurement guides.
- Grid lines.
- Dimension extension lines.
- Construction guides.
- Leader lines and annotation pointers.
- Arrows, symbols and reference markings.
- Room labels and text annotations.
- Measurements and dimensions.
- Other non-structural drafting markings.

IMPORTANT DISTINCTION:

Do not automatically preserve every line simply because it appears in the original floorplan.

Retain actual physical architectural structures, walls, partitions, openings, furniture and fixtures that belong in the final wooden floorplan.

Remove decorative, projected, hidden, reference or annotation lines that do not represent physical elements in the final product.

Dotted or dashed lines must NOT be converted into solid walls or engraved furniture.

When a dotted or dashed line is ambiguous, exclude it rather than inventing a physical structure from it.

# 4. CAMERA & VIEWPOINT

VIEW: Strict 90-degree top-down orthographic projection.

LENS: Zero perspective distortion. No vanishing points. No tilted camera.

FRAMING:
- Centre the complete wooden floorplan.
- The floorplan should occupy approximately 85% of the image.
- Maintain the original floorplan's aspect ratio.
- Ensure the entire floorplan remains visible without cropping.
- Keep all walls and interior details sharp and clearly distinguishable.

The camera must look directly down onto the flat wooden surface.

# 5. MATERIAL & COLOUR SPECIFICATIONS

The entire floorplan must be completely FLAT and TWO-DIMENSIONAL.

BASE:
- One continuous flat sheet of light birch wood.
- Base colour: #F4E5CA.
- Subtle, natural birch wood grain.
- Smooth and consistent surface.
- Premium natural wooden appearance.
- No unnecessary patterns or decorative textures.

WALLS (2D SOLID-FILLED WOODEN DESIGN):
- Material appearance: Darker natural wood.
- Target colour: #C6935C.
- Represent all walls as solid-filled, flat wooden shapes directly on the birch base.
- Preserve the exact original wall positions, thicknesses, lengths and geometry.
- Walls must be completely flat and lie on the same plane as the base.
- No physical height, extrusion, elevation or depth.
- No vertical side faces.
- No bevels or raised edges.
- No 3D effects or cast shadows.

IMPORTANT: Walls must be visually prominent through their solid darker wooden colour and filled shapes, NOT through physical height or dimensional effects.

INTERIOR ELEMENTS (2D ENGRAVING):
- Material appearance: Light birch wood.
- Target colour: #F4E5CA.
- All furniture and fixtures must be represented as flat engraved outlines or details.
- Engraved details should be subtle, clean and precise.
- No physical elevation, extrusion or shadows.
- Preserve the original shapes, positions, orientations and proportions.

The contrast between the solid dark wooden walls and the light birch engraved interiors should make the architectural layout immediately recognisable.

# 6. LIGHTING & PHOTOGRAPHIC REALISM

Render the wooden floorplan as a real, professionally manufactured laser-cut and laser-engraved wooden product.

- Soft, natural studio lighting.
- Even illumination across the entire floorplan.
- Subtle natural wood grain and material characteristics.
- Realistic birch wood texture.
- Clean, precise laser-cut boundaries.
- Sharp and clearly defined engraved details.
- Natural, understated wooden finish.
- Avoid excessive contrast, artificial gloss or plastic-like surfaces.

The lighting should reveal the natural wooden material without introducing artificial depth.

STRICTLY AVOID:
- Directional shadows.
- Ambient occlusion.
- Contact shadows.
- Raised edges.
- 3D extrusion.
- Perspective depth.
- Artificial dimensional effects.

The final artwork must look like a flat wooden product, NOT a 3D architectural model, miniature building or physical diorama.

# 7. CLEANLINESS & OUTPUT PROTOCOL

REMOVE:
- All text and alphabetic characters.
- All room names and labels.
- All dimensions and measurements.
- All numerical characters.
- All grid lines and annotation markings.
- All dotted and dashed drafting lines.
- All unnecessary symbols, arrows and reference markings.

IMPORTANT: Remove textual and drafting annotations only. Do not mistake actual architectural lines, furniture outlines or structural details for unwanted markings.

BACKGROUND:
- Plain, pure white background.
- No visible surface, table or studio environment.
- No background patterns or textures.

NO ADDITIONAL ELEMENTS:
- No hands.
- No rulers.
- No tools.
- No decorative objects.
- No plants.
- No people.
- No additional architectural features.

# 8. FINAL NON-NEGOTIABLE GUARDRAILS

EVERY ELEMENT MUST BE TWO-DIMENSIONAL.

The base, walls, furniture and fixtures must all lie on the same flat plane.

WALLS:
Solid-filled, flat dark wooden shapes (#C6935C).

BASE:
Flat light birch wooden surface (#F4E5CA).

FURNITURE AND FIXTURES:
Flat engraved details in light birch.

The only visual distinction between the walls and the base should be their colour, material appearance and flat shape.

NO EXTRUSION.
NO ELEVATION.
NO RAISED SURFACES.
NO BEVELS.
NO 3D SHADOWS.
NO PERSPECTIVE.

Never invent.
Never omit.
Never reinterpret.
Never redesign.

Translate ONLY the actual physical elements represented in the uploaded floorplan into the specified flat wooden floorplan artwork.

FINAL OUTPUT:

A premium, photorealistic, completely flat 2D wooden floorplan with solid dark wooden walls, light birch engraved furniture and fixtures, precise architectural geometry, natural wood textures and a clean white background.

It must look like a real, professionally manufactured laser-cut and laser-engraved wooden floorplan, photographed directly from above.
    `.trim();

    // ✅ Step 3: Generate with padded square image
    let generatedUrl;
    if (API_PROVIDER === 'openai') {
      generatedUrl = await generateWithOpenAI(paddedDataUri, finalPrompt);
    } else {
      generatedUrl = await generateWithGrok(paddedDataUri, finalPrompt);
    }

    // ✅ Step 4: Download generated image
    let floorplanBuffer;
    if (generatedUrl.startsWith('data:')) {
      const base64Data = generatedUrl.replace(/^data:image\/\w+;base64,/, '');
      floorplanBuffer = Buffer.from(base64Data, 'base64');
    } else {
      const floorplanResp = await fetch(generatedUrl);
      if (!floorplanResp.ok) throw new Error('Failed to download generated image');
      floorplanBuffer = Buffer.from(await floorplanResp.arrayBuffer());
    }

    // ✅ Step 5: Remove background + trim + force-resize to exact original dimensions
    const finalImageBuffer = await buildTransparentFloorplan(
      floorplanBuffer, originalWidth, originalHeight
    );

    // ✅ Step 6: Upload processed AI image to Cloudinary
    const hostedUrl = await uploadToCloudinary(finalImageBuffer);

    // ✅ Both URLs returned — Shopify stores them as order properties after payment
    res.status(200).json({
      success: true,
      imageUrl: hostedUrl,      // AI-generated wooden floorplan
      originalUrl: originalUrl, // Customer's original uploaded floorplan
    });

  } catch (error) {
    console.error('❌ Crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
