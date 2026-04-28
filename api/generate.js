// api/generate.js
import sharp from 'sharp';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

// Returns the wooden floorplan with transparent background
async function buildTransparentFloorplan(floorplanBuffer) {
  return await sharp(floorplanBuffer)
    .ensureAlpha()
    .trim({ threshold: 15 })           // Fixed: now using object format
    .png({ 
      quality: 95, 
      compressionLevel: 9,
      adaptiveFiltering: true 
    })
    .toBuffer();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.XAI_API_KEY)
    return res.status(500).json({ error: 'API key missing' });

  try {
    const { image: imageDataUri } = req.body || {};
    if (!imageDataUri) return res.status(400).json({ error: 'No image provided' });

    const finalPrompt = `
You are the world's best architectural drafter and interior space planner, specializing in clean, minimal, laser-engraved wooden floorplan models.

Task: Add furniture to the uploaded floorplan using precise, logical, and practical placement.

------------------------------------------------------------------
🔒 CORE VISUAL RULE (HIGHEST PRIORITY)
------------------------------------------------------------------
This must look like a REAL laser-cut wooden architectural model:

- Walls are physical raised elements (3D).
- Furniture is NOT physical — it is engraved into the surface.

STRICT SEPARATION:
- Walls = 3D (slightly raised wooden pieces)
- Furniture = 100% flat engraved lines

If ANY furniture appears raised, shaded, filled, or 3D in any way, the output is WRONG.

------------------------------------------------------------------
🎨 STYLE REQUIREMENTS (STRICT)
------------------------------------------------------------------
- Top-down orthographic view ONLY (perfectly flat, no perspective).

- Floor:
  - Light natural wood tone (#E6C79C)
  - Very subtle, uniform grain (barely visible)
  - Flat and evenly lit (no gradients, no hotspots)

- Walls (ONLY ELEMENT WITH 3D EFFECT):
  - Slightly darker wood tone (#D8B58A) (same hue family)
  - Uniform thickness across entire floorplan
  - Clearly raised above the floor (visible height)
  - Clean vertical edges (like laser-cut wood pieces)
  - Subtle bevel allowed ONLY on top edges
  - Cast a soft, short, consistent shadow

  Shadow rules:
  - Single light source from top-left
  - Shadows must be soft, tight, and minimal
  - No long or dramatic shadows
  - All walls must have consistent shadow direction and intensity

- Furniture (CRITICAL - MUST REMAIN 2D):
  - Pure engraved line style ONLY
  - Dark brown lines (#4A2E1A)
  - Thin, crisp, uniform stroke weight
  - NO fill, NO shading, NO gradients
  - NO bevel, NO emboss
  - NO shadows
  - NO thickness or depth
  - Must look like laser-burned line art on wood

- Doors, arcs, and symbols:
  - Same thin engraved line style as furniture
  - No emphasis, no thickness difference

------------------------------------------------------------------
🧠 FURNITURE PLACEMENT RULES (STRICT & FUNCTIONAL)
------------------------------------------------------------------
- Ensure realistic layouts with proper walking space.

- Living room:
  - Sofa directly faces TV
  - TV must be placed flush against a wall (not floating)
  - Coffee table centered between sofa and TV

- Bedroom:
  - Bed headboard against a solid wall
  - Centered where possible
  - Max 2 bedside tables
  - Maintain walking clearance

- Dining:
  - Table centered
  - Chairs evenly and symmetrically arranged

- Kitchen:
  - Stove, sink, refrigerator follow work triangle
  - Clean alignment along walls

- Bathroom:
  - Max: 1 toilet, 1 sink, 1 shower/bathtub
  - Maintain usable clearance

- Never overcrowd spaces

------------------------------------------------------------------
⚠️ STRICT PROHIBITIONS
------------------------------------------------------------------
- DO NOT modify structural elements
- DO NOT apply any 3D effect to furniture
- DO NOT add shadows to furniture
- DO NOT use gradients anywhere
- DO NOT vary line thickness randomly
- DO NOT create inconsistent wall thickness
- DO NOT use dramatic lighting or deep shadows
- DO NOT let furniture resemble physical objects

------------------------------------------------------------------
🎯 LIGHTING & RENDER QUALITY
------------------------------------------------------------------
- Clean studio lighting (premium product render)
- Even illumination across entire image
- ONLY walls cast shadows
- Shadows are soft, subtle, and consistent
- No vignette, no uneven lighting

------------------------------------------------------------------
🧾 OUTPUT REQUIREMENTS
------------------------------------------------------------------
- Remove ALL text, labels, dimensions, numbers
- Background must be pure white (#FFFFFF)
- Preserve exact original aspect ratio
- Output must resemble a high-end physical wooden model product

------------------------------------------------------------------
✅ FINAL QUALITY CHECK (MANDATORY)
------------------------------------------------------------------
Before outputting, verify:

- Walls are clearly raised with consistent 3D effect
- Wall shadows are soft, short, and consistent direction
- Furniture is completely flat (zero depth, zero shadow, zero fill)
- No object except walls appears 3D
- Line weights are consistent everywhere
- Overall image is clean, minimal, and cohesive
`.trim();

    // Call Grok Image Generation
    const grokResponse = await fetch('https://api.x.ai/v1/images/edits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-imagine-image',
        prompt: finalPrompt,
        image: { url: imageDataUri, type: 'image_url' },
      }),
    });

    const grokData = await grokResponse.json();
    if (!grokResponse.ok)
      return res.status(500).json({ error: grokData.error?.message || 'Grok error', detail: grokData });

    const generatedUrl = grokData.data?.[0]?.url;
    if (!generatedUrl)
      return res.status(500).json({ error: 'No image URL from Grok', detail: grokData });

    // Download generated image
    const floorplanResp = await fetch(generatedUrl);
    if (!floorplanResp.ok)
      return res.status(500).json({ error: 'Failed to download floorplan' });

    const floorplanBuffer = Buffer.from(await floorplanResp.arrayBuffer());

    // Convert background to transparent
    const finalImage = await buildTransparentFloorplan(floorplanBuffer);

    res.status(200).json({
      success: true,
      imageUrl: `data:image/png;base64,${finalImage.toString('base64')}`,
    });
  } catch (error) {
    console.error('❌ Crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
