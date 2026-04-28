// api/generate.js
import sharp from 'sharp';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

// Returns the wooden floorplan with transparent background
async function buildTransparentFloorplan(floorplanBuffer) {
  return await sharp(floorplanBuffer)
    .ensureAlpha()                    // Make sure we have an alpha channel
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
You are an expert architectural drafter. Add furniture outlines to the uploaded floorplan.

STRUCTURAL PRESERVATION (NON-NEGOTIABLE):
Never alter walls, doors, windows, staircases, or room boundaries. Only furniture is added.

WOODEN MODEL STYLE (top-down view):
- Floor: warm amber/honey wood (#D4A96A), fine horizontal grain lines
- Walls: dark walnut brown (#5C3317), slightly raised 3D effect with faint drop shadow
- Furniture: laser-engraved outlines only — thin dark lines (#3D1F0A), no shadow, no 3D depth

BACKGROUND REQUIREMENTS (VERY IMPORTANT):
- The area outside the floorplan must be pure white (#FFFFFF) or very close to it.
- Do NOT add any vignette, gradient, shadow, or texture on the background.
- Preserve exact aspect ratio of the original floorplan.

CLEANUP:
- Remove all text, labels, dimensions, and measurements.
- Output only the wooden-style floorplan.

OUTPUT: Clean image with the wooden floorplan on a solid white background. No extra elements.
`.trim();

    // ── Call Grok ─────────────────────────────────────────────────────────────
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

    // Download the generated floorplan
    const floorplanResp = await fetch(generatedUrl);
    if (!floorplanResp.ok)
      return res.status(500).json({ error: 'Failed to download floorplan' });

    let floorplanBuffer = Buffer.from(await floorplanResp.arrayBuffer());

    // ── Make background transparent ───────────────────────────────────────────
    // This removes the white/off-white background and keeps only the wooden elements
    const transparentBuffer = await sharp(floorplanBuffer)
      .ensureAlpha()
      .trim(10)                    // Trim edges (tolerance of 10)
      .png({ 
        quality: 95, 
        compressionLevel: 9 
      })
      .toBuffer();

    // Optional: You can add a small padding back if you want some breathing room
    // .extend({ top: 20, bottom: 20, left: 20, right: 20, background: { r: 255, g: 255, b: 255, alpha: 0 } })

    const finalImage = transparentBuffer;

    res.status(200).json({
      success: true,
      imageUrl: `data:image/png;base64,${finalImage.toString('base64')}`,
    });
  } catch (error) {
    console.error('❌ Crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
