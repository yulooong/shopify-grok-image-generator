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
You are the world's best architectural drafter and interior space planner, specializing in creating realistic and highly functional wooden architectural models.

Task: Add furniture to the uploaded floorplan using precise, logical, and practical placement.

**STYLE REQUIREMENTS (STRICT):**
- This is a flat laser-engraved wooden model (top-down orthographic view).
- Floor: light natural maple wood tone (#E6C79C) with very subtle, fine horizontal grain texture. Keep it soft, clean, and evenly lit.
- Walls: slightly darker warm wood tone (#D2A679), same hue family as the floor (NOT contrasting). Walls should appear gently raised using a soft, minimal shadow — not strong color difference.
- Furniture: Purely 2D laser-engraved style. Use only thin, crisp dark brown outlines (#5A3A1A). 
  Absolutely NO shading, NO bevel, NO drop shadow, NO 3D effect, NO thickness, and NO depth on any furniture or objects.

**FURNITURE PLACEMENT RULES (MUST BE HIGHLY LOGICAL AND FUNCTIONAL):**
- Place furniture in realistic, practical positions that make sense for daily living.
- Living room: Sofa and TV must face each other directly. Coffee table centered between sofa and TV. TV should be placed against a wall.
- Bedroom: Bed centered on the longest wall or headboard against a solid wall. Add at most 2 bedside tables.
- Dining area: Dining table centered in the room with chairs evenly arranged around it.
- Kitchen: Place stove, refrigerator, and sink logically along the walls (work triangle principle).
- Bathroom: Maximum one toilet, one sink, and one shower (or bathtub). Place them in functional positions with proper clearance.
- Only add furniture that fits comfortably without overcrowding.
- Leave adequate walking space and circulation paths in every room.

**STRICT INSTRUCTIONS:**
- Never alter walls, doors, windows, staircases, or structural boundaries.
- Remove ALL text, labels, dimensions, numbers, and measurements completely.
- The only elements allowed any 3D effect are the walls. All furniture must remain perfectly flat 2D engraved lines.
- Background outside the floorplan must be pure solid white (#FFFFFF). No gradients, no shadows, no texture, no vignette.
- Maintain a soft, realistic studio lighting effect with very gentle shadows only cast by walls to subtly show elevation.

Output a clean, professional, logically arranged wooden-style floorplan with solid white background. Preserve exact original aspect ratio.
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
