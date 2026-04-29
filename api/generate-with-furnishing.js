// api/generate-with-furnishing.js
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
TASK: Generate a perfectly top-down (90-degree orthographic) architectural model photograph based on the uploaded floorplan.

🚫 CLEAN SLATE (STRICT): Permanently remove and wipe clean ALL original text, labels, room names, and dimensions found on the uploaded floorplan. The final output must be completely clean of any alphabetic or numeric characters.

🏗️ CORE STYLE: HYBRID WOODEN MODEL

BASE: A single flat sheet of light natural wood (#E6C79C) with subtle grain.

WALLS (THE ONLY 3D ELEMENT): Trace the uploaded walls EXACTLY. Do not simplify geometry. Render them as raised, physical, laser-cut darker wooden blocks (#D8B58A). They must have visible depth, thickness, a subtle top bevel, and cast a short, soft shadow to the bottom-right.

FURNITURE (STRICTLY 2D ENGRAVED): All interior furniture must be FLAT 2D dark brown engraved lines (#4A2E1A) burnt into the wood base.

CRITICAL 2D RULE: Furniture, kitchen countertops, and bathroom fixtures must have ZERO height, ZERO thickness, and cast NO shadows. They must look like a drawing on the floor.

🛋️ RIGID DESIGN LOGIC (MANDATORY):

LIVING ROOM: Anchor a 2D-engraved TV flush against the longest solid wall. Place a 2D-engraved sofa directly parallel to and facing the TV. A 2D coffee table must be centered between them.

KITCHEN: 2D-engraved countertops, sink, and stove must align along the walls. NO 3D extrusion on counters or fixtures.

BATHROOM: MUST include 2D-engraved toilet, sink, and a clear, defined rectangular area for a shower or bath.

DINING: If space allows, a centered 2D-engraved table with symmetrical 2D chairs.

BEDROOM: 2D-engraved bed with headboard flush against a solid wall.

⚠️ STRICT PROHIBITIONS:

NO TEXT: No labels, numbers, or dimensions in the final output.

NO 3D FURNITURE: No thickness or shadows on tables, chairs, counters, or sofas.

NO SHADOWS ON FLOOR ITEMS: Only the raised walls cast shadows.

NO STRUCTURE ALTERATIONS: The walls must match the uploaded floorplan perfectly.

FINAL VISUAL CHECK: The result must look like a physical board where the walls are 3D wooden blocks glued on, the floorplan labels are erased, and the furniture is merely inked/engraved onto the wooden surface. Pure white background.
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
