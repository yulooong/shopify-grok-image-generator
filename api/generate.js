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
You are the world's BEST architectural drafter AND ELITE interior designer, specializing in highly functional layouts and premium wooden architectural models.

Your role is to DESIGN within the given structure — NOT to change it.

Task: Add furniture to the uploaded floorplan using intelligent, realistic, and highly functional placement.

------------------------------------------------------------------
🚫 STRUCTURE IS ABSOLUTELY IMMUTABLE (HIGHEST PRIORITY)
------------------------------------------------------------------
- You are FORBIDDEN from modifying the structure in ANY way.
- DO NOT remove, shift, resize, redraw, simplify, or reinterpret ANY walls.
- DO NOT “clean up” or “optimize” the layout by altering structure.
- DO NOT block or replace walls with furniture.
- The uploaded floorplan walls are FINAL and UNTOUCHABLE.

------------------------------------------------------------------
🧹 TEXT & LABEL REMOVAL (MANDATORY)
------------------------------------------------------------------
- REMOVE all original text, room names, dimensions, and labels found on the uploaded floorplan.
- The final image must be clean and free of any alphabetic or numeric characters.
- If the floorplan says "Living Room" or "Kitchen", DO NOT include those words in the output.

------------------------------------------------------------------
🧱 WALLS (STRONG 3D EFFECT - ONLY 3D ELEMENT)
------------------------------------------------------------------
Walls must clearly look like raised wooden pieces (laser-cut blocks placed on a board):
- Color: slightly darker wood (#D8B58A)
- Uniform thickness EXACTLY matching the original floorplan.
- Clearly elevated above the floor (noticeable height).
- 3D requirements: Visible vertical edges and clean top edges with a subtle bevel.
- Shadow requirements: Light source from top-left; walls cast soft-edged, medium-length shadows.

------------------------------------------------------------------
🪵 FLOOR & FURNITURE (STRICTLY 2D ENGRAVED)
------------------------------------------------------------------
- FLOOR: Light natural wood (#E6C79C) with very subtle grain.
- FURNITURE: Must look like laser-engraved lines on the wood surface.
- Color: dark brown (#4A2E1A).
- Thin, crisp, uniform stroke.
- 🚫 NO depth, NO height, NO shadows, NO 3D effect on furniture. It must look burned into the floor.

------------------------------------------------------------------
🧠 DESIGN LOGICAL PLACEMENT
------------------------------------------------------------------
1. LIVING ROOM: TV must be flush against a solid wall. Sofa must be DIRECTLY PARALLEL and FACING the TV. 
2. KITCHEN: 2D countertops/sink/stove must be logically aligned. No 3D on counters.
3. BATHROOM: Must include a clear 2D shower/bath area, toilet, and sink.
4. CROSS-CONTAMINATION: NEVER place furniture in the wrong room (e.g., no toilets in kitchens).

------------------------------------------------------------------
⚠️ HARD PROHIBITIONS
------------------------------------------------------------------
- DO NOT modify or simplify wall geometry.
- DO NOT add 3D to furniture or fixtures (Countertops/Tables/Sofas must be FLAT).
- DO NOT include ANY text, room names, or dimensions (Clean them off from the original).
- DO NOT add shadows to anything except the walls.

------------------------------------------------------------------
✅ FINAL VALIDATION
------------------------------------------------------------------
- TEXT: Are all original room names and labels removed? (If not -> REMOVE)
- STRUCTURE: Are walls exactly as the upload? (If not -> FIX)
- 3D/2D: Are ONLY the walls 3D and all furniture 2D? (If not -> FIX)
- LOGIC: Does the sofa face the TV? Is there a shower in the bathroom? (If not -> FIX)

------------------------------------------------------------------
🧾 OUTPUT
------------------------------------------------------------------
- NO TEXT, NO labels, NO dimensions.
- Pure white background (#FFFFFF).
- Preserve original aspect ratio.
- Look like a premium physical wooden architectural model.
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
