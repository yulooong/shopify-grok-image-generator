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
TASK: Generate a top-down architectural model photograph based on the uploaded floorplan.

CORE STYLE: HYBRID WOODEN MODEL

BASE: A single flat sheet of light-grained natural wood (#E6C79C).

WALLS (THE ONLY 3D ELEMENT): Trace the uploaded walls EXACTLY. Render them as raised, physical wooden strips (#D8B58A). They must have visible thickness, a subtle top bevel, and cast a short, soft shadow to the bottom-right.

FURNITURE (STRICTLY 2D): All interior items must be FLAT 2D dark brown engraved lines (#4A2E1A) burnt into the wood base.

CRITICAL: Furniture must have ZERO height, ZERO thickness, and cast NO shadows. It must look like a 2D drawing on the floor.

LOGICAL FURNISHING RULES:

LIVING ROOM: Place a 2D-engraved TV flush against a solid wall. Place a 2D-engraved sofa directly parallel to and facing the TV. A 2D coffee table sits between them.

KITCHEN: 2D-engraved countertops, sink, and stove must be flat against the floor. No 3D extrusion on counters.

BATHROOM: Must include 2D-engraved toilet, sink, and a clear rectangular shower enclosure area.

DINING: If space allows, a centered 2D-engraved table with symmetrical 2D chairs.

BEDROOM: 2D-engraved bed with headboard flush against a wall.

STRICT PROHIBITIONS (STOPS FAILURES):

NO 3D FURNITURE: Do not extrude tables, chairs, or sofas. If it’s not a wall, it must be flat.

NO WALL ALTERATIONS: Do not move, add, or delete any walls from the original image.

NO SHADOWS ON FLOOR ITEMS: Only the raised walls cast shadows.

NO TEXT: No labels, dimensions, or room names.

FINAL VISUAL CHECK: The result must look like a physical board where the walls are 3D "wooden blocks" glued on, and the furniture is merely "inked" onto the surface. Pure white background.
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
