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
# FLOORPLAN TO WOODEN ARTWORK – AUTO-FURNISHING IMAGE GENERATION PROMPT

### ROLE: PROFESSIONAL ARCHITECTURAL MODEL MAKER & INDUSTRIAL DESIGNER

Transform the uploaded floorplan into a premium, photorealistic wooden floorplan artwork suitable for laser cutting and engraving.

The uploaded floorplan is the absolute source of truth for all existing architectural structures, room geometry and existing furniture.

Your task is to faithfully reproduce the original floorplan, remove all non-physical annotations, and intelligently auto-populate empty or partially furnished rooms with appropriate 2D engraved furniture.

The final output must be a flat wooden floorplan artwork with selectively raised wooden walls, not a conventional 3D architectural model.

---

## 1. ABSOLUTE PRIORITY: STRUCTURAL INTEGRITY

The uploaded image is the sole source of truth for the architectural layout.

- Preserve the exact positions, lengths, orientations and relative thicknesses of all existing walls.
- Preserve all wall intersections, corners, partitions, doorways, openings and passages.
- Maintain the original room layout, proportions and spatial geometry.
- Do not remove, shift, resize, straighten, merge or modify existing wall structures.
- Never invent additional walls, partitions, doorways or architectural structures.
- Do not modify the overall footprint or exterior silhouette of the house.
- Do not alter the relative proportions of rooms.

**Structural accuracy always takes priority over furniture placement and aesthetic improvements.**

## 2. FLOORPLAN DIMENSIONS AND SCALING

The maximum finished physical dimensions of the wooden floorplan are:

- Maximum width: 170mm (17cm).
- Maximum height: 140mm (14cm).

Requirements:

- Scale the entire floorplan proportionally to fit within these maximum dimensions.
- Preserve the original aspect ratio.
- Do not stretch, distort or independently resize the horizontal and vertical dimensions.
- The final physical dimensions must not exceed either maximum.
- All wall thickness classifications must be based on their actual thickness in the final physical product, expressed in millimetres.
- Do not use image pixel dimensions as a substitute for physical measurements.

## 3. WALL CLASSIFICATION AND MANUFACTURING RULES

This is a critical manufacturing requirement. Correctly distinguish between external perimeter walls, raised internal walls and engraved internal walls.

### A. EXTERNAL PERIMETER WALLS – ALWAYS RAISED

- Every wall forming the external boundary or perimeter of the house MUST be represented as a separate, raised wooden wall.
- This rule applies regardless of the wall's apparent or actual thickness.
- External perimeter walls must NEVER be represented as flat engraved lines.
- Preserve their exact original geometry, positions, thicknesses, corners and connections.
- Never classify an external perimeter wall as an engraved wall.

### B. INTERNAL WALLS – PHYSICAL THICKNESS CLASSIFICATION

Classify internal walls according to their actual thickness in the final physical wooden product.

- Internal walls measuring 3mm or more must be represented as separate, raised wooden walls.
- Internal walls measuring less than 3mm must be represented as flat, laser-engraved lines directly onto the birch base.
- Apply this rule based on actual final physical dimensions, not the apparent thickness or pixel dimensions in the uploaded image.
- Do not artificially increase or decrease wall thickness to force a particular classification.
- If an internal wall is too thin or structurally unsuitable to be produced as a separate wooden piece, use laser engraving instead.
- When thickness cannot be determined reliably, favour engraving rather than creating narrow, fragile wooden pieces.

**IMPORTANT:** The 3mm classification rule applies exclusively to internal walls. External perimeter walls must ALWAYS be raised, regardless of their thickness.

### C. VISUAL WALL CLASSIFICATION

Use these exact colours:

- Raised external and internal walls: solid dark walnut/brown (#C6935C).
- Engraved internal walls: solid black (#000000).
- Wooden base: light natural birch (#F4E5CA).

Raised walls must be solid-filled, not represented as thin outlines.

Engraved walls must appear as flat black lines directly on the birch base.

### D. STRUCTURAL CONSISTENCY

- Preserve all original wall positions, intersections, corners and openings.
- Never omit, merge, reposition or invent walls.
- Do not let the wall classification process alter the original floorplan geometry.
- Never turn an external perimeter wall into an engraved line.

## 4. EXISTING FURNITURE PRESERVATION

Preserve all identifiable furniture, fittings and interior fixtures already visible in the uploaded floorplan.

Examples include:
- Beds, sofas, chairs and tables.
- Kitchen counters, cabinets and islands.
- Wardrobes and built-in storage.
- Toilets, sinks, bathtubs and shower areas.
- Other identifiable furniture and permanent fixtures.

Requirements:

- Preserve the original furniture's positions, shapes, orientations and proportions.
- Retain all existing furniture and fixtures.
- Do not remove, rearrange, replace or duplicate existing furniture.
- Represent all furniture and interior fixtures as flat engraved details on the light birch base.
- Maintain recognisable shapes and details using clean, minimalist line-art.
- All furniture must remain completely flat, with 0mm physical height.
- Do not create raised furniture, extruded furniture or three-dimensional objects.

## 5. INTELLIGENT AUTO-POPULATION OF EMPTY ROOMS

Unlike a strictly preservation-based conversion, this version MUST automatically populate empty or partially furnished rooms with appropriate furniture.

Use the original floorplan's room layout, dimensions, architectural features and existing furniture to determine suitable furniture placement.

**IMPORTANT: Existing furniture must always be preserved. Only add furniture where additional furnishing is appropriate and there is sufficient available space. Never duplicate furniture that already exists.**

### A. LIVING ROOM

Where appropriate, add:
- A sectional sofa or three-seater sofa.
- A rectangular coffee table.
- A slim TV console.

Position the furniture logically while maintaining sufficient circulation space.

### B. KITCHEN

Where appropriate, add:
- Kitchen perimeter countertops.
- A double sink.
- A stovetop or hob.
- A refrigerator silhouette.
- Kitchen cabinets where appropriate.

Respect the existing kitchen layout and avoid obstructing doors or passages.

### C. DINING AREA

Where appropriate, add:
- A dining table.
- Four to six dining chairs, depending on available space.

Ensure chairs are proportionate to the table and fit naturally within the room.

### D. MASTER BEDROOM

Where appropriate, add:
- A king-sized bed.
- Two bedside tables or nightstands.
- A long wardrobe silhouette.

Maintain realistic proportions and sufficient walking clearance.

### E. OTHER BEDROOMS

Where appropriate, add:
- A queen-sized or twin bed depending on room dimensions.
- A small desk where space permits.
- A wardrobe where appropriate.

Do not overcrowd smaller bedrooms.

### F. BATHROOMS

Where appropriate, add:
- A walk-in shower area.
- A toilet.
- A vanity or sink.

Respect the original bathroom geometry and avoid obstructing doorways.

### G. OTHER SPACES

For spaces not explicitly covered above:

- Interpret their likely function using the original floorplan layout.
- Add only sensible, conventional furniture where appropriate.
- Do not introduce unnecessary decorative objects.
- Do not overcrowd rooms or obstruct circulation paths.
- Preserve the architectural structure.

### H. AUTO-FURNISHING PRIORITIES

Follow this hierarchy when populating rooms:

1. Preserve all existing furniture and fixtures.
2. Identify empty or partially furnished rooms.
3. Determine the most appropriate furniture based on the room's apparent function and available space.
4. Add only furniture that can fit naturally within the room.
5. Maintain realistic proportions and practical circulation space.
6. Avoid duplication, overcrowding and unnecessary objects.

An empty room may be furnished in this auto-furnishing version. However, furniture must never be added at the expense of architectural accuracy.

## 6. FURNITURE MATERIAL AND ENGRAVING SPECIFICATIONS

All furniture and interior fixtures must be represented as flat laser-engraved details.

- Material appearance: light natural birch (#F4E5CA).
- Furniture height: exactly 0mm.
- Use clean, minimalist and recognisable line-art silhouettes.
- Furniture must appear engraved directly onto the birch surface.
- No extrusion, raised edges or physical height.
- No shadows cast by furniture.
- No three-dimensional furniture rendering.
- No unnecessary decorative detailing.

Furniture should look like carefully laser-engraved representations rather than miniature physical objects.

## 7. BASE MATERIAL AND CUTOUT GEOMETRY

### A. BASE MATERIAL

- Use a single sheet of light natural birch wood.
- Target colour: #F4E5CA.
- Include subtle, realistic natural wood grain.
- Maintain a completely flat base surface.
- Do not introduce unnecessary textures, knots or distracting grain patterns.

### B. EXACT EXTERIOR SILHOUETTE CUTOUT

The wooden base must follow the EXACT exterior perimeter of the house.

- The base must match the actual exterior footprint of the floorplan.
- If the floorplan is L-shaped, the base must be L-shaped.
- If the floorplan is irregular or asymmetrical, the base must reproduce that exact silhouette.
- Do not create a rectangular or square bounding box.
- Do not add a rectangular backing plate or surrounding wooden frame.
- Do not extend the wooden base beyond the exterior footprint.
- Do not fill spaces outside the actual house footprint with wood.

The final product should look like an individually laser-cut wooden piece shaped precisely to the house's exterior outline.

### C. TRANSPARENT BACKGROUND

- All areas outside the wooden floorplan must be fully transparent.
- Output must be a PNG with a transparent background.
- Do not generate a white background as part of the final artwork.
- No background fill, rectangular canvas plate or surrounding frame.
- The wooden floorplan must be cleanly isolated and ready for compositing onto another background.

## 8. CAMERA AND VIEWPOINT

- Strict 90-degree top-down orthographic projection.
- Perfectly perpendicular view of the floorplan.
- Zero perspective distortion.
- Zero vanishing points.
- No isometric, angled or three-quarter view.
- Keep the entire floorplan visible.
- Centre the model in the canvas.
- The model should occupy approximately 85% of the frame.
- Do not crop any part of the floorplan.

## 9. REMOVE NON-PHYSICAL ANNOTATIONS

Permanently remove all original drafting annotations and reference markings that are not physical parts of the house.

Remove:
- All room names and text labels.
- All measurements and dimensions.
- All numerical and alphabetic characters.
- Dimension lines and extension lines.
- Grid lines and construction guides.
- Arrows, symbols, leader lines and reference markers.
- North indicators and directional symbols.
- Dotted or dashed drafting lines.
- Watermarks and other non-physical markings.

Important:
- Retain actual physical walls, partitions, openings, furniture and fixtures.
- Do not mistake genuine architectural structures for drafting annotations.
- If a dotted or dashed line cannot confidently be identified as a physical structure, exclude it rather than inventing a solid wall.

The final artwork must contain no text, labels, measurements or drafting annotations.

## 10. STRICT 2D BASE WITH SELECTIVE RAISED WALLS

The final artwork must be a flat wooden floorplan with selectively raised walls.

Only walls classified as raised wooden walls may have physical height.

The following elements must remain completely flat:
- Wooden base.
- Furniture.
- Interior fixtures.
- Engraved internal walls.
- Decorative and architectural details.

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

## 11. LIGHTING AND REALISM

Create a premium, realistic wooden product appearance.

- Use soft, natural illumination.
- Maintain accurate and consistent birch and walnut colours.
- Show subtle, believable natural wood grain.
- Use realistic material textures without excessive artificial gloss.
- Raised wooden walls may cast subtle, natural contact shadows onto the base.
- Shadows should be limited to raised walls only.
- Furniture and engraved details must not cast shadows.
- Avoid excessive ambient occlusion and exaggerated depth effects.
- Do not make flat engraved elements appear raised through lighting or shadows.

The final product should look like a real, carefully manufactured laser-cut and laser-engraved wooden artwork photographed directly from above.

## 12. FINAL OUTPUT REQUIREMENTS

The final output must be a premium wooden floorplan artwork with:

- A flat, light birch wooden base (#F4E5CA).
- An exact cutout silhouette matching the exterior perimeter of the house.
- Maximum physical dimensions of 170mm wide and 140mm high.
- Raised external perimeter walls, ALWAYS.
- Internal walls measuring 3mm or more represented as raised wooden walls.
- Internal walls below 3mm represented as flat black engraved lines.
- Raised walls in solid dark walnut/brown (#C6935C).
- Engraved internal walls in solid black (#000000).
- Existing furniture and fixtures faithfully preserved.
- Empty or partially furnished rooms intelligently auto-populated according to the room logic.
- All furniture and fixtures represented as flat, light-birch engravings.
- No raised or extruded furniture.
- All original architectural geometry preserved.
- All non-physical annotations and text removed.
- Strict 90-degree top-down orthographic view.
- Fully transparent background outside the wooden cutout.
- PNG output suitable for direct compositing.

### FINAL NON-NEGOTIABLE RULES

1. The uploaded floorplan is the absolute source of truth for existing architectural geometry.
2. External perimeter walls MUST ALWAYS be raised wooden walls.
3. Internal walls measuring 3mm or more MUST be raised; internal walls below 3mm MUST be laser-engraved.
4. Existing furniture must be preserved and must not be duplicated.
5. Empty or partially furnished rooms MUST be intelligently auto-populated according to their function and available space.
6. All furniture and interior fixtures MUST remain completely flat and engraved.
7. The wooden base MUST follow the exact exterior silhouette of the house.
8. The final physical dimensions MUST NOT exceed 170mm × 140mm.
9. The final output MUST have a transparent background.
10. Architectural accuracy and manufacturing suitability always take priority over artistic interpretation.

This is NOT a conventional 3D architectural model. It is a premium, flat wooden floorplan artwork with selectively raised physical walls and intelligently auto-populated, laser-engraved furniture.
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
      provider: API_PROVIDER,
      imageUrl: hostedUrl,      // AI-generated wooden floorplan
      originalUrl: originalUrl, // Customer's original uploaded floorplan
    });

  } catch (error) {
    console.error('❌ Crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
