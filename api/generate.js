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
You are the world's best technical architectural illustrator specializing in laser-cut wooden architectural models.

Create a precise top-down wooden floorplan model based on the uploaded image with these strict rules:

**STYLE REQUIREMENTS (NON-NEGOTIABLE):**
- This is a flat laser-engraved wooden model, not a 3D render.
- Floor: warm amber honey-colored wood (#D4A96A) with fine, subtle horizontal wood grain texture.
- Walls: dark walnut brown (#5C3317), slightly raised with a very subtle bevel and faint drop shadow to give a minimal 3D erected effect.
- Furniture & all interior elements: Must be purely 2D laser-engraved style — only thin, crisp dark outlines (#3D1F0A). 
  Absolutely NO shading, NO bevel, NO drop shadow, NO depth, NO 3D extrusion, NO thickness, and NO perspective on any furniture.
- Furniture must look like it has been precisely laser-engraved flat onto the wooden floor.

**FURNITURE RULES:**
- Add appropriate furniture using only simple, clean, thin dark outlines.
- Living room: sofa, coffee table, TV stand
- Bedroom: bed, maximum 2 bedside tables
- Dining: table with 2–6 chairs
- Kitchen: stove, fridge, sink
- Bathroom: toilet, sink, shower or bathtub
- Use minimal, elegant, standardized top-down symbols for furniture.

**STRICT INSTRUCTIONS:**
- Never alter, move, or thicken any existing walls, doors, windows, or structural elements.
- Remove ALL text, labels, dimensions, numbers, and measurements.
- The only elements allowed to have any 3D effect are the walls. Everything else (floor and furniture) must remain perfectly flat 2D.
- Background outside the floorplan must be pure solid white (#FFFFFF). No gradients, no shadows, no texture, no vignette.

Output a clean, high-precision, technical illustration of the wooden floorplan model with transparent-friendly solid white background. Preserve the exact original aspect ratio and scale.
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
