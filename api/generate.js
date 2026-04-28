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
This must look like a REAL laser-engraved wooden board:
- Furniture is NOT physical objects.
- Furniture must look like thin lines engraved (burned) into wood.
- Absolutely NO visual depth for furniture.

If any furniture appears raised, shaded, filled, embossed, or 3D in any way, the output is WRONG.

------------------------------------------------------------------
🎨 STYLE REQUIREMENTS (STRICT)
------------------------------------------------------------------
- Top-down orthographic view ONLY (perfectly flat, no perspective).

- Floor:
  - Light natural wood tone (#E6C79C)
  - Very subtle, uniform grain (barely visible)
  - Flat lighting, no gradients, no hotspots

- Walls:
  - Slightly darker wood tone (#D8B58A) (same hue family, low contrast)
  - Uniform thickness throughout the entire floorplan
  - Slight elevation ONLY via a very soft, short, consistent shadow
  - Shadow direction must be consistent (top-left light source)
  - No harsh or long shadows

- Furniture (CRITICAL):
  - Pure 2D engraved line style ONLY
  - Color: dark brown (#4A2E1A)
  - Thin, crisp, uniform stroke weight
  - NO fill, NO shading, NO gradients
  - NO bevel, NO emboss, NO shadow
  - NO thickness or depth
  - Must look like vector line art etched into the wood

- Doors, arcs, and symbols:
  - Same thin stroke style as furniture
  - Do NOT appear darker or thicker than furniture

------------------------------------------------------------------
🧠 FURNITURE PLACEMENT RULES (STRICT & FUNCTIONAL)
------------------------------------------------------------------
- Ensure realistic, practical layouts with proper walking space.

- Living room:
  - Sofa directly faces TV
  - TV must be flush against a wall (not floating)
  - Coffee table centered between sofa and TV

- Bedroom:
  - Bed headboard against a solid wall
  - Centered where possible
  - Max 2 bedside tables
  - Maintain clear walking space on sides

- Dining:
  - Table centered
  - Chairs evenly and symmetrically spaced

- Kitchen:
  - Stove, sink, refrigerator follow work triangle logic
  - Aligned cleanly along walls

- Bathroom:
  - Max: 1 toilet, 1 sink, 1 shower/bathtub
  - Maintain usable clearance

- NEVER overcrowd any room

------------------------------------------------------------------
⚠️ STRICT PROHIBITIONS
------------------------------------------------------------------
- DO NOT modify walls, doors, or structure
- DO NOT add textures, noise, or heavy grain
- DO NOT use gradients anywhere
- DO NOT add shadows to furniture
- DO NOT vary line thickness randomly
- DO NOT allow inconsistent wall thickness
- DO NOT create uneven lighting
- DO NOT let any object appear 3D except walls (very subtle only)

------------------------------------------------------------------
🎯 LIGHTING & RENDER QUALITY
------------------------------------------------------------------
- Clean studio lighting (like product photography)
- Even illumination across entire floorplan
- Only walls cast a very soft, minimal shadow
- No vignetting, no dramatic lighting

------------------------------------------------------------------
🧾 OUTPUT REQUIREMENTS
------------------------------------------------------------------
- Remove ALL text, labels, dimensions, numbers
- Background must be pure white (#FFFFFF)
- Preserve exact original aspect ratio
- Output must feel like a premium physical wooden model product photo

------------------------------------------------------------------
✅ FINAL QUALITY CHECK (MANDATORY)
------------------------------------------------------------------
Before outputting, ensure:
- Furniture looks like engraved lines, NOT objects
- No shadows or fills exist on furniture
- Wall thickness is 100% consistent
- Shadows are soft, minimal, and consistent direction
- Entire image feels clean, minimal, and uniform

If any of the above fails, regenerate internally until correct.
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
