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

async function buildTransparentFloorplan(floorplanBuffer) {
  return await sharp(floorplanBuffer)
    .ensureAlpha()
    .trim({ threshold: 15 })
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

    const finalPrompt = `
### ROLE: Professional Architectural Model Maker & Industrial Designer
### 🛑 STRUCTURAL INTEGRITY (NON-NEGOTIABLE SOURCE OF TRUTH):
- THE UPLOADED IMAGE IS THE ABSOLUTE BLUEPRINT. 
- DO NOT remove, shift, add, or modify any existing wall structures or partitions. 
- The 3D walls must be a perfect 1:1 extrusion of the original lines. 
- Preserve the exact layout, room proportions, and spatial geometry of the uploaded file.
### TASK:
Convert the uploaded floorplan into a high-fidelity 3D wooden "Site Model" photograph. Interpret the layout and auto-populate it with 2D engraved furniture based on the logic below.
### CAMERA & VIEWPOINT:
- View: Strict 90-degree Top-Down Orthographic Projection.
- Lens: Zero perspective distortion, zero vanishing points.
- Framing: The model must be centered and fill 85% of the frame.
### MATERIAL & COLOR SPECS:
1. BASE: A single CNC-cut sheet of light birch wood (#F4E5CA). The base must follow the exact exterior perimeter of the house.
2. WALLS (3D): Extruded 3D laser-cut wood blocks (#C6935C). Render walls with physical thickness and 10mm height. Add soft ambient occlusion shadows where walls meet the floor.
3. FURNITURE (2D ENGRAVED): All interior elements must be light birch wood engravings (#F4E5CA).
   - Furniture must be 100% flat (0mm height).
   - No shadows on furniture.
   - Use clean, minimalist line-art for furniture silhouettes.
### AUTO-POPULATION ROOM LOGIC:
- LIVING ROOM: A sectional or 3-seater sofa, a rectangular coffee table, and a slim TV console.
- KITCHEN: Perimeter countertops, a double sink, a stovetop/hob, and a refrigerator silhouette.
- DINING AREA: A dining table with 4 to 6 chairs tucked in.
- MASTER BEDROOM: A King-sized bed, two nightstands, and a long wardrobe silhouette.
- OTHER BEDROOMS: A Queen or Twin bed and a small desk.
- BATHROOMS: A walk-in shower area, a toilet, and a vanity/sink.
### CLEANLINESS & OUTPUT PROTOCOL:
- REMOVAL: Permanently wipe all original text, room names, dimensions, and grid lines. No alphabetic or numeric characters.
- BACKGROUND: Place the model on a white background.
- NO EXTRA ELEMENTS: No hands, no rulers, no tables, no studio props.
### GUARDRAILS:
- Walls must have shadow and 3D effect. Everything else MUST BE 2D, NOT RAISED, AND CAST NO SHADOWS.

### CUTOUT & SILHOUETTE PROTOCOL:
- The final wooden model must be a CUTOUT — the base shape must follow the EXACT exterior perimeter of the floorplan with NO rectangular or square bounding box.
- If the floorplan is L-shaped, the wooden base must be L-shaped. If it is irregular or odd-shaped, the wooden base must match that exact silhouette.
- There must be NO background fill, NO rectangular base plate, and NO square frame surrounding the model.
- Think of the final output as a laser-cut wooden piece lifted off a table — only the wood exists, shaped precisely to the floorplan outline.
- TRANSPARENCY: All areas outside the exterior walls must be fully transparent (alpha = 0). The output must be a PNG with a transparent background, not white.
- The wooden model must be isolatable — as if it were a sticker or a cutout PNG ready to be composited onto any background.
    `.trim();

    let generatedUrl;
    if (API_PROVIDER === 'openai') {
      generatedUrl = await generateWithOpenAI(imageDataUri, finalPrompt);
    } else {
      generatedUrl = await generateWithGrok(imageDataUri, finalPrompt);
    }

    let floorplanBuffer;
    if (generatedUrl.startsWith('data:')) {
      const base64Data = generatedUrl.replace(/^data:image\/\w+;base64,/, '');
      floorplanBuffer = Buffer.from(base64Data, 'base64');
    } else {
      const floorplanResp = await fetch(generatedUrl);
      if (!floorplanResp.ok) throw new Error('Failed to download generated image');
      floorplanBuffer = Buffer.from(await floorplanResp.arrayBuffer());
    }

    const finalImageBuffer = await buildTransparentFloorplan(floorplanBuffer);

    // ✅ Upload to Cloudinary — returns a short URL instead of base64
    const hostedUrl = await uploadToCloudinary(finalImageBuffer);

    res.status(200).json({
      success: true,
      provider: API_PROVIDER,
      imageUrl: hostedUrl, // ✅ short CDN URL, safe for Shopify cart properties
    });

  } catch (error) {
    console.error('❌ Crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
