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
# FLOORPLAN TO WOODEN ARTWORK – IMAGE GENERATION PROMPT

Transform the uploaded floorplan into a premium, photorealistic wooden floorplan artwork suitable for laser cutting and engraving.

The uploaded floorplan is the **sole source of truth** for all architectural geometry and interior details. Reproduce it faithfully. Do not redesign, reinterpret, simplify or invent any structural elements or furniture.

## 1. ABSOLUTE PRIORITY: STRUCTURAL ACCURACY

Preserve the original floorplan's architectural structure as accurately as possible.

- Maintain the exact positions, lengths, orientations and relative thicknesses of all walls.
- Preserve all wall intersections, corners, partitions, doorways, openings and passages.
- Maintain the original room layout and proportions.
- Do not move, resize, straighten, merge, remove or invent walls.
- Do not modify the overall footprint or geometry of the house.
- Do not introduce architectural elements that are not present in the uploaded floorplan.

The priority hierarchy is:

1. Architectural and structural accuracy.
2. Accurate preservation of interior furniture and fixtures.
3. Correct distinction between raised wooden walls and engraved walls.
4. Accurate wooden materials and colours.
5. Overall visual aesthetics.

Never sacrifice structural accuracy for aesthetics.

## 2. INTERIOR ELEMENTS AND FURNITURE

Preserve all identifiable furniture, fittings and interior fixtures from the original floorplan.

Examples include:
- Beds, sofas, chairs and tables.
- Kitchen counters, cabinets and islands.
- Wardrobes and built-in storage.
- Toilets, sinks, bathtubs and shower areas.
- Other identifiable furniture and permanent fixtures.

Requirements:
- Preserve their original positions, shapes, orientations and proportions.
- Represent all furniture and interior fixtures as flat engraved details on the wooden base.
- Use the light birch colour for engraved furniture and fixtures.
- Maintain recognisable shapes and details without introducing unnecessary complexity.
- Do not remove, rearrange or replace existing furniture.

### STRICT FURNITURE PRESERVATION – DO NOT INVENT OR ADD FURNITURE

The uploaded floorplan is the sole source of truth for all furniture and interior fixtures.

- Only reproduce furniture, fixtures and fittings that are explicitly visible in the original uploaded floorplan.
- NEVER add new furniture, even if a room appears empty, unfinished or unusually spacious.
- Do not automatically furnish empty bedrooms, living rooms, dining rooms or other spaces.
- Do not assume what furniture a room should contain based on its room type or intended purpose.
- Do not add beds, sofas, chairs, tables, wardrobes, cabinets, kitchen appliances or decorative objects unless they are visibly present in the original floorplan.
- Do not fill empty spaces to improve visual balance or make the artwork look more aesthetically pleasing.
- Do not complete partially furnished rooms by guessing what might be missing.
- If a room is empty in the original floorplan, it MUST remain empty in the final artwork.

**IMPORTANT:** An empty room is an intentional and valid part of the original floorplan. Preserve empty spaces exactly as they appear. Architectural accuracy always takes priority over visual completeness or aesthetic enhancement.

Do not turn furniture into raised or three-dimensional objects.

## 3. WALL CLASSIFICATION AND MANUFACTURING RULES

This is a critical requirement. Distinguish between external perimeter walls, internal walls suitable for physical wooden pieces, and thin internal walls that should be engraved.

### A. EXTERNAL PERIMETER WALLS – ALWAYS RAISED

- Every wall forming the external boundary or perimeter of the house MUST be represented as a separate, raised wooden wall.
- This rule applies regardless of the wall's apparent thickness.
- External perimeter walls must NEVER be represented as flat engraved lines.
- Preserve their original geometry, positions, thicknesses, corners and connections.
- Do not classify any external perimeter wall as an engraved wall.

### B. INTERNAL WALLS – PHYSICAL THICKNESS CLASSIFICATION

The maximum finished physical dimensions of the wooden floorplan are:

- Maximum width: 170mm (17cm).
- Maximum height: 140mm (14cm).

Scale the original floorplan proportionally to fit within these maximum dimensions while preserving its original aspect ratio.

Classify internal walls according to their actual thickness in the final physical wooden product:

- Internal walls measuring **3mm or more** in the final physical product must be represented as separate, raised wooden walls.
- Internal walls measuring **less than 3mm** must be represented as flat, laser-engraved lines directly onto the birch base.
- Apply this rule based on actual final physical dimensions, not pixel dimensions or apparent thickness in the uploaded image.
- Do not artificially increase or decrease wall thickness to force a particular classification.
- If an internal wall is too thin or structurally unsuitable to be produced as a separate wooden piece, use laser engraving instead.
- When the thickness cannot be determined reliably, favour engraving rather than creating a narrow, fragile wooden piece.

**IMPORTANT:** The 3mm classification rule applies exclusively to internal walls. External perimeter walls must ALWAYS be raised, regardless of their thickness.

### C. VISUAL DISTINCTION

Use these exact colours:

- Raised wooden walls: solid dark walnut/brown (#C6935C).
- Engraved internal walls: solid black (#000000).
- Wooden base: light natural birch (#F4E5CA).

Raised walls must be solid-filled with the dark walnut/brown colour, not represented as thin outlines.

Engraved walls must appear as flat black lines directly on the birch surface.

### D. STRUCTURAL CONSISTENCY

- Preserve all original wall positions, intersections, corners and openings.
- Never omit, merge, reposition or invent walls.
- Never turn a raised external wall into an engraved line.
- Do not let the classification process alter the original floorplan geometry.

## 4. REMOVE NON-PHYSICAL ANNOTATIONS

Remove all drafting annotations and reference markings that are not actual physical parts of the house.

Remove:
- Room names and labels.
- Measurements, dimensions and numerical annotations.
- Dimension lines and extension lines.
- Grid lines and construction guides.
- Arrows, symbols, leader lines and reference markers.
- North indicators and directional symbols.
- Dotted or dashed drafting lines.
- Other text or markings that do not represent physical architectural elements.

Important:
- Retain actual physical walls, partitions, openings, furniture and fixtures.
- Do not mistake genuine architectural structures for drafting annotations.
- If a dotted or dashed line cannot confidently be identified as a physical structure, exclude it rather than inventing a solid wall.

The final artwork must contain only the physical floorplan elements, without drafting information or text.

## 5. CAMERA AND COMPOSITION

- Use a perfectly straight 90-degree top-down orthographic view.
- No perspective, tilt, isometric angle or three-quarter view.
- Keep the entire floorplan centred and fully visible.
- Preserve the original aspect ratio.
- Do not crop any part of the floorplan.
- The floorplan should occupy approximately 85% of the available canvas, with a clean margin around it.

## 6. WOODEN MATERIALS AND APPEARANCE

### A. WOODEN BASE

- Use light natural birch wood.
- Target colour: #F4E5CA.
- The base must be a single, completely flat wooden surface.
- Include subtle, realistic natural wood grain.
- Avoid excessive grain patterns, knots or distracting textures.

### B. RAISED WOODEN WALLS

- Use a dark walnut/brown wooden appearance.
- Target colour: #C6935C.
- Walls must be solid-filled, with clearly defined edges.
- Represent raised walls as separate physical wooden pieces placed on the flat birch base.
- Maintain consistent wall material and appearance throughout the floorplan.

### C. ENGRAVED DETAILS

- Use the light birch base colour for furniture and interior fixtures.
- Use solid black (#000000) for internal walls classified as engraved.
- All engraved details must appear flush with the wooden base.
- They must look laser-engraved or laser-marked, not raised.

## 7. STRICT 2D BASE WITH SELECTIVE RAISED WALLS

The artwork must have a flat, two-dimensional floorplan layout, with only the classified raised walls having physical height.

The following elements must remain completely flat:
- Wooden base.
- Furniture.
- Interior fixtures.
- Engraved internal walls.
- Decorative and architectural details.

Only the walls classified as raised wooden walls may have physical height.

Do NOT introduce:
- Extruded furniture.
- Raised furniture or fixtures.
- Extruded floor surfaces.
- Unnecessary elevation changes.
- Bevelled edges.
- Three-dimensional architectural room models.
- Isometric or perspective views.
- Fake depth effects.
- Artificially thickened engraved lines.

The distinction between raised and engraved walls must come from their physical construction and colour, not exaggerated visual effects.

## 8. LIGHTING AND REALISM

Create a premium, realistic wooden product appearance.

- Use soft, natural studio illumination.
- Keep the birch and walnut colours accurate and consistent.
- Show subtle, believable wood grain.
- Maintain natural material texture without excessive artificial gloss.
- Avoid strong directional shadows.
- Avoid ambient occlusion, exaggerated contact shadows or artificial depth effects.
- Do not make flat engraved elements appear raised through lighting or shadows.

The final product should look like a real, carefully manufactured laser-cut and laser-engraved wooden artwork photographed from directly above.

## 9. CLEAN PRESENTATION

- Use a completely clean white background surrounding the artwork.
- No room settings or lifestyle scenes.
- No plants, decorations, furniture outside the floorplan, tools, hands or people.
- No labels, captions, watermarks, borders or additional graphic elements.
- No additional objects.

## 10. FINAL OUTPUT REQUIREMENTS

The final output must be a premium wooden floorplan artwork with:

- A flat, light birch wooden base (#F4E5CA).
- Raised external perimeter walls, ALWAYS.
- Internal walls classified using the 3mm physical thickness threshold.
- Raised internal walls in dark walnut/brown (#C6935C) when they are 3mm or thicker.
- Thin internal walls laser-engraved in black (#000000) when below 3mm.
- Furniture and fixtures represented as flat engraved details.
- No invented or automatically added furniture.
- Empty rooms preserved exactly as they appear in the original.
- All original architectural geometry and interior arrangements faithfully preserved.
- All non-physical annotations and text removed.
- A perfectly straight top-down orthographic view.
- Final physical dimensions not exceeding 170mm × 140mm, with the original aspect ratio preserved.

**FINAL NON-NEGOTIABLE RULE:**

This is NOT a 3D architectural model.

It is a flat wooden floorplan artwork with selectively raised wooden walls.

The external perimeter walls must ALWAYS be raised. Internal walls must be classified according to the 3mm physical thickness rule. All furniture and fixtures must come exclusively from the uploaded floorplan. Empty rooms must remain empty. All remaining details must be flat and engraved directly onto the birch base.

Prioritise manufacturing suitability and structural accuracy over artistic interpretation.
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
