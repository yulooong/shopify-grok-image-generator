// api/generate-empty.js

import sharp from 'sharp';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

async function buildTransparentFloorplan(floorplanBuffer) {
  return await sharp(floorplanBuffer)
    .ensureAlpha()
    .trim({ threshold: 15 })
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

BASE: A single flat sheet of light natural wood (#E6C79C) with subtle grain texture.

WALLS (THE ONLY 3D ELEMENT): Trace the uploaded walls EXACTLY. Do not simplify geometry. Render them as raised, physical, laser-cut darker wooden blocks (#D8B58A). They must have visible depth, thickness, a subtle top bevel, and cast a short, soft shadow to the bottom-right.

🪵 EMPTY FLOOR RULES (STRICTLY MANDATORY):
- The floor inside every room must be completely bare — smooth, clean, unscratched natural wood.
- NO furniture of any kind: no sofas, no beds, no tables, no chairs, no coffee tables, no wardrobes, no TV units, no cabinets, no counters.
- NO kitchen fixtures: no countertops, no sinks, no stoves, no appliances.
- NO bathroom fixtures: no toilets, no sinks, no bathtubs, no showers.
- NO engravings, no etchings, no burnt-in lines, no outlines of furniture on the floor.
- The floor surface must look like a freshly cut wooden board — untouched and completely empty.

⚠️ STRICT PROHIBITIONS:
- NO TEXT: No labels, numbers, or dimensions in the final output.
- NO FURNITURE: Absolutely zero items on the floor. Any object placed on the floor is a violation.
- NO FLOOR MARKINGS: No lines, no shadows, no silhouettes suggesting where furniture would go.
- NO STRUCTURE ALTERATIONS: The walls must match the uploaded floorplan perfectly.

FINAL VISUAL CHECK: The result must look like a physical wooden model board where the raised walls are 3D wooden blocks and the floor is a completely blank, clean, empty wooden surface with zero objects inside any room. Pure white background.
    `.trim();

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

    const floorplanResp = await fetch(generatedUrl);
    if (!floorplanResp.ok)
      return res.status(500).json({ error: 'Failed to download floorplan' });

    const floorplanBuffer = Buffer.from(await floorplanResp.arrayBuffer());
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
