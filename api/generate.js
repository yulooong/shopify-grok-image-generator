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

The uploaded floorplan walls are FINAL and UNTOUCHABLE.
If any wall is changed, missing, thinner, thicker, moved, or simplified → OUTPUT IS WRONG.

------------------------------------------------------------------
🧱 WALLS (STRONG 3D EFFECT - ONLY 3D ELEMENT)
------------------------------------------------------------------
Walls must clearly look like raised wooden pieces (laser-cut blocks placed on a board):
- Color: slightly darker wood (#D8B58A)
- Uniform thickness EXACTLY matching the original floorplan
- Clearly elevated above the floor (noticeable height)

3D requirements:
- Visible vertical edge (not flat)
- Stronger, but still realistic depth
- Clean top edges with subtle bevel

Shadow requirements:
- Light source from top-left
- Shadows must be:
  - Clearly visible (stronger than before)
  - Still soft-edged (not harsh)
  - Short to medium length (not overly long)
- Shadow must be consistent across ALL walls

👉 Walls should look like physical wooden strips placed on top of the board.

------------------------------------------------------------------
🪵 FLOOR
------------------------------------------------------------------
- Light natural wood (#E6C79C)
- Very subtle grain
- Flat and even lighting

------------------------------------------------------------------
✏️ FURNITURE (STRICTLY 2D ENGRAVED)
------------------------------------------------------------------
Furniture must look like laser-engraved lines on the wood surface:
- Color: dark brown (#4A2E1A)
- Thin, crisp, uniform stroke
- NO fill
- NO shading
- NO gradients
- NO shadows
- NO bevel
- NO emboss
- NO depth

🚫 If furniture looks like objects instead of engraved lines → WRONG

------------------------------------------------------------------
🧠 DESIGN LOGIC (MANDATORY)
------------------------------------------------------------------
You are a PROFESSIONAL interior designer. Placement must be intentional.

STEP 1: Identify room function  
STEP 2: Define focal point  
STEP 3: Plan walking paths  
STEP 4: Place furniture logically  

🚫 CROSS-CONTAMINATION PROHIBITION: NEVER place furniture meant for one room type into another (e.g., NO sofas in kitchens or bathrooms, NO toilets in living rooms).

------------------------------------------------------------------
🏠 LIVING ROOM (STRICT)
------------------------------------------------------------------
- Identify a proper TV wall (solid wall, no doors/windows)
- Place TV flush against that wall
- Place sofa DIRECTLY facing the TV (must be aligned correctly, not sideways or angled wrongly)
- Coffee table centered between sofa and TV
- Maintain clear walking space

🚫 INVALID:
- Sofa not facing TV
- TV floating
- Random placement

------------------------------------------------------------------
🍽️ DINING AREA (REQUIRED WHEN SPACE EXISTS)
------------------------------------------------------------------
If there is open space near kitchen/living:
- MUST include dining table
- Table centered in its zone
- Chairs evenly spaced and symmetrical
- Ensure clearance for chairs

🚫 INVALID:
- Missing dining set when space clearly allows

------------------------------------------------------------------
🛏️ BEDROOMS
------------------------------------------------------------------
- Bed headboard against solid wall
- Logical centering or placement
- Max 2 bedside tables
- Maintain walking clearance

------------------------------------------------------------------
🍳 KITCHEN
------------------------------------------------------------------
- Follow work triangle (sink, stove, fridge)
- Align along walls

------------------------------------------------------------------
🚿 BATHROOM
------------------------------------------------------------------
- Max: toilet, sink, shower/bath
- Maintain usable spacing

------------------------------------------------------------------
⚠️ HARD PROHIBITIONS
------------------------------------------------------------------
- DO NOT modify walls (ZERO tolerance)
- DO NOT reduce or simplify wall geometry
- DO NOT add 3D to furniture (must look burned/engraved flat onto the floor)
- DO NOT add shadows to furniture
- DO NOT randomly place items
- DO NOT overcrowd

------------------------------------------------------------------
🎯 LIGHTING
------------------------------------------------------------------
- Clean studio lighting
- Even illumination
- ONLY walls cast shadows
- Stronger but controlled shadow for clear 3D effect

------------------------------------------------------------------
✅ FINAL VALIDATION (MANDATORY)
------------------------------------------------------------------
Before output:

STRUCTURE: Are ALL original walls perfectly preserved? If not → FIX
WALLS: Do walls clearly look raised with visible depth? If not → INCREASE 3D effect
LIVING ROOM: Sofa facing TV? If not → FIX
DINING: Space exists but no dining table? → ADD IT
FURNITURE: Completely flat engraved lines? If not → FIX

------------------------------------------------------------------
🧾 OUTPUT
------------------------------------------------------------------
- No text, labels, or dimensions
- Pure white background (#FFFFFF)
- Preserve original aspect ratio
- Must look like a premium physical wooden architectural model
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
