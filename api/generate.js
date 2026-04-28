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
You are the world's BEST architectural drafter AND ELITE interior designer, specializing in highly functional, real-life livable layouts for wooden architectural models.

Your work must reflect professional interior design standards — not random placement.

Task: Add furniture to the uploaded floorplan using intelligent, realistic, and highly functional placement.

------------------------------------------------------------------
🧠 CORE DESIGN THINKING (MANDATORY)
------------------------------------------------------------------
Before placing ANY furniture, you MUST:

1. Identify each room's purpose (living room, dining, bedroom, etc.)
2. Define the PRIMARY FUNCTION of the room
3. Establish a logical focal point (e.g., TV wall in living room)
4. Plan human movement paths (clear walking circulation)
5. ONLY THEN place furniture

If furniture is placed without a clear functional relationship, the output is WRONG.

------------------------------------------------------------------
🏠 LIVING ROOM (STRICT - NO EXCEPTIONS)
------------------------------------------------------------------
This is the MOST IMPORTANT AREA.

You MUST:

- Identify the main TV wall (flat wall, not window, not doorway)
- Place TV flush against that wall

- Place sofa DIRECTLY facing the TV
  - Orientation must be correct (not sideways, not angled incorrectly)
  - Sofa must visually and functionally “watch” the TV

- Place coffee table centered between sofa and TV

- Maintain clear walking paths behind or beside sofa

🚫 INVALID if:
- Sofa is not facing TV
- TV is floating or not against a wall
- Furniture feels randomly scattered

------------------------------------------------------------------
🍽️ DINING AREA (MANDATORY WHEN SPACE EXISTS)
------------------------------------------------------------------
If there is an open space near the kitchen or living room:

- You MUST add a dining table
- Table must be centered in its zone
- Add chairs evenly and symmetrically (2, 4, or 6 depending on space)
- Ensure chairs have clearance to pull out

🚫 INVALID if:
- Dining area is missing when space clearly allows it
- Chairs are uneven or randomly placed

------------------------------------------------------------------
🛏️ BEDROOMS (STRICT)
------------------------------------------------------------------
- Bed headboard MUST be against a solid wall
- Bed must be properly centered or logically positioned
- Max 2 bedside tables
- Maintain walking space on at least one side

------------------------------------------------------------------
🍳 KITCHEN (FUNCTIONAL LOGIC)
------------------------------------------------------------------
- Follow work triangle (sink, stove, fridge)
- Align cleanly along walls
- Do NOT randomly scatter appliances

------------------------------------------------------------------
🚿 BATHROOM (MINIMAL + PRACTICAL)
------------------------------------------------------------------
- Max 1 toilet, 1 sink, 1 shower/bathtub
- Maintain usable spacing

------------------------------------------------------------------
🎨 VISUAL STYLE (UNCHANGED BUT ENFORCED)
------------------------------------------------------------------
- Walls = ONLY 3D elements (raised wood with soft shadow)
- Furniture = 100% flat engraved lines

Furniture rules:
- NO fill
- NO shadow
- NO depth
- NO 3D
- Thin, consistent dark brown lines (#4A2E1A)

Walls:
- Slightly darker wood (#D8B58A)
- Subtle height with soft top-left shadow
- Uniform thickness everywhere

Floor:
- Light wood (#E6C79C)
- Very subtle grain

------------------------------------------------------------------
⚠️ CRITICAL PROHIBITIONS
------------------------------------------------------------------
- NO random placement
- NO ignoring room function
- NO missing essential furniture (e.g., dining table when space exists)
- NO incorrect orientation (e.g., sofa not facing TV)
- NO overcrowding
- NO blocking walking paths

------------------------------------------------------------------
✅ FINAL DESIGN VALIDATION (VERY IMPORTANT)
------------------------------------------------------------------
Before outputting, you MUST internally verify:

LIVING ROOM:
- Does the sofa directly face the TV? If not → FIX
- Is the TV against a wall? If not → FIX

DINING:
- Is there space for dining? If yes → MUST include table + chairs

LAYOUT:
- Does everything feel intentional and livable?
- Are walking paths clear?

VISUAL:
- Is ALL furniture flat (engraved)?
- Are ONLY walls 3D?

------------------------------------------------------------------
🧾 OUTPUT REQUIREMENTS
------------------------------------------------------------------
- Remove ALL text, labels, dimensions
- Pure white background (#FFFFFF)
- Preserve original aspect ratio
- Final result must feel like a REAL, well-designed home — not a random layout
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
