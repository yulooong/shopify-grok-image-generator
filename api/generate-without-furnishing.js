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
ROLE: Professional Architectural Model Maker & Industrial Designer
🛑 STRUCTURAL INTEGRITY (NON-NEGOTIABLE SOURCE OF TRUTH):

THE UPLOADED IMAGE IS THE ABSOLUTE BLUEPRINT.
DO NOT remove, shift, add, modify, or invent any structures, partitions, or interior elements.
The 3D walls must be a perfect 1:1 extrusion of the original lines.
Preserve the exact layout, room proportions, spatial geometry, and all interior elements of the uploaded file.

TASK:
Convert the uploaded floorplan into a high-fidelity 3D wooden "Site Model" photograph. Faithfully translate every element visible in the uploaded floorplan — walls, partitions, and any existing furniture or interior outlines — into the wooden material language defined below. Do not add, remove, or invent any elements.
FURNITURE TRANSLATION RULE:

If the uploaded floorplan contains furniture or interior outlines, translate every piece faithfully as a 2D engraved element. Do not add new furniture or remove existing ones.
If the uploaded floorplan contains no furniture, leave the interiors empty. Do not auto-populate or invent furniture.
In both cases, follow the person's uploaded image exactly — it is the only source of truth.

CAMERA & VIEWPOINT:

View: Strict 90-degree Top-Down Orthographic Projection.
Lens: Zero perspective distortion, zero vanishing points.
Framing: The model must be centered and fill 85% of the frame.

MATERIAL & COLOR SPECS:

BASE: A single CNC-cut sheet of light birch wood (#F4E5CA). The base must follow the exact exterior perimeter of the floorplan.
WALLS (3D): Extruded 3D laser-cut wood blocks (#C6935C). Render walls with physical thickness and 10mm height. Add soft ambient occlusion shadows where walls meet the floor.
INTERIOR ELEMENTS (2D ENGRAVED): All furniture, fixtures, and interior outlines must be rendered as light birch wood engravings (#F4E5CA).

All interior elements must be 100% flat (0mm height).
No shadows on any interior elements.
Use clean, minimalist line-art for all silhouettes.



CLEANLINESS & OUTPUT PROTOCOL:

REMOVAL: Permanently wipe all original text, room labels, dimensions, and grid lines. The final model must contain NO alphabetic or numeric characters.
BACKGROUND: Place the model on a plain white background.
NO EXTRA ELEMENTS: No hands, no rulers, no tables, no studio props. Only the wooden model.

FINAL AESTHETIC:
Clean, professional, minimalist architectural mockup.
GUARDRAILS:

Walls must carry the shadow and 3D extruded effect.
Everything else — furniture, fixtures, and all interior elements — must be strictly 2D, not raised, and cast no shadows.
Never invent. Never omit. Translate only what is shown.
    `.trim();

    const grokResponse = await fetch('https://api.x.ai/v1/images/edits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-imagine-image',
        // model: 'grok-imagine-image-quality',
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
