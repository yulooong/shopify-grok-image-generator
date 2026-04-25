// api/generate.js
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  // === CORS HEADERS (allows Shopify to call this) ===
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.XAI_API_KEY) {
    console.error('❌ XAI_API_KEY is not set in Vercel environment variables');
    return res.status(500).json({ error: 'Server misconfiguration: API key missing' });
  }

  try {
    const { image: imageDataUri } = req.body || {};

    if (!imageDataUri) {
      return res.status(400).json({ error: 'No image provided in request body' });
    }

    const finalPrompt = `
You are an expert architectural drafter. Your ONLY job is to add furniture outlines to an existing floorplan image.
========================================
RULE 0 — ABSOLUTE STRUCTURAL PRESERVATION (MOST IMPORTANT)
You must NEVER add, move, remove, or alter ANY of the following:

Walls
Doors (including door swing arcs)
Windows
Staircases
Room boundaries or openings

The structural layout must be 100% identical to the uploaded image.
Only furniture is added. Nothing else changes.
========================================
WALL RENDERING
Redraw all existing walls as clean, bold, solid dark brown lines with visible wood grain texture.
Do not change wall positions, thickness ratios, or room shapes.
========================================
VISUAL STYLE — HYPER-REALISTIC WOODEN MODEL
The output must look like a physical laser-cut wooden architectural scale model, as if photographed from directly above. Follow these rules precisely:
MATERIALS & COLORS:

Floor surfaces: warm amber/honey wood tone (#D4A96A) with subtle horizontal wood grain lines
Walls: thick, dark walnut brown (#5C3317) with a slightly raised 3D appearance
Exterior border: darkest wood tone (#3D1F0A), slightly thicker than interior walls
Furniture outlines: engraved/etched into the wood surface — thin dark brown lines (#3D1F0A), no fills

WOOD GRAIN TEXTURE:

Apply fine, parallel horizontal grain lines across all floor surfaces
Grain lines should be subtle — slightly darker than the base floor color
Vary grain direction slightly between rooms to suggest individual wood panels

DEPTH & REALISM:

Walls must cast a faint drop shadow (soft, rightward and downward) to simulate physical raised dividers
The entire floorplan model should cast a soft drop shadow on the background, as if physically resting on a surface
Background: off-white or light warm grey — NOT pure white — to simulate a photography surface

LIGHTING:

Simulate soft overhead studio lighting
Walls appear slightly lighter on their top edge and slightly darker on their side face to reinforce the 3D raised effect

FURNITURE STYLE:

All furniture rendered as laser-engraved outlines — thin, clean dark lines on the wood surface
No fills, no shading, no colours on furniture
Slight line depth/emboss effect to simulate physical engraving into wood

========================================
STEP-BY-STEP ROOM PROCESS
For EACH room:

Identify room type from its shape, size, and position in the floorplan.
Check all door positions — furniture must never block any door or its swing path.
Place the main anchor furniture first (bed, sofa, or dining table).
Add secondary items ONLY if there is clear space remaining.
If the room is too small or unclear, add minimal or no furniture.

========================================
STRICT PLACEMENT RULES (NON-NEGOTIABLE)

All furniture must be fully inside room boundaries — no overlaps with walls.
Maintain walking clearance:

Main paths: 70–90 cm
Secondary paths: 50–60 cm


Do NOT block:

Doors (assume door swing clearance even if not shown)
Windows
Entryways between rooms


Align furniture to walls or center it logically. No random angles.
Keep all furniture aligned to the room's primary axis (horizontal/vertical).
Maintain realistic spacing:

Bed: at least one accessible side (≥50 cm)
Sofa ↔ coffee table: 30–50 cm
Dining chairs: ≥60 cm clearance behind


Scale furniture proportionally to room size.
Each room must have ONE clear focal point (e.g., bed, TV, dining table).

========================================
FURNITURE RULES (MINIMAL & REALISTIC)
LIVING ROOM (READ CAREFULLY — SPATIAL LOGIC IS MANDATORY):

Step 1: Place the sofa against one wall. The sofa faces AWAY from that wall, toward the centre of the room.
Step 2: Place the TV console flat against the wall directly in front of the sofa — this is the wall the sofa is FACING. The sofa and TV must be on opposite walls, facing each other.
Step 3: Place the coffee table in the open space between the sofa and the TV console, centred on both.
The sofa must NEVER face a blank wall with no TV. The TV must NEVER be beside or behind the sofa.
Optional: 1 small side table or plant at the side of the sofa only if space allows.

BEDROOM:

Exactly 1 bed
Maximum 1–2 bedside tables (only if space allows beside the bed)
Optional: 1 dresser against a wall (only in larger bedrooms)

DINING ROOM / DINING AREA:

Exactly 1 dining table
Chairs placed only around the table (2–6 chairs depending on table size)

KITCHEN:

Trace and preserve existing counter/fixture shapes only
Add: 1 stove symbol, 1 fridge symbol, 1 sink symbol — all along walls
Do NOT add a dining table inside the kitchen unless there is clear open space

BATHROOM (CRITICAL — READ CAREFULLY):

Exactly 1 toilet
Exactly 1 sink (never 2, never 0)
Exactly 1 shower OR 1 bathtub — NOT both, unless the room is clearly large enough for both
Do not add any other items

SMALL ROOMS / UNCLEAR ROOMS:

If the room purpose is unclear or the space is tight: add nothing
Never force furniture into a room that does not have enough space

========================================
SPACING & CLEARANCE RULES

Minimum 80 cm clearance on all main walking paths
Minimum 50 cm clearance on secondary paths (e.g., beside a bed)
Sofa to coffee table gap: 35–45 cm
Dining chairs need ≥60 cm pull-out space behind them
No furniture within 60 cm of any door opening

========================================
CLEANUP

Remove ALL existing text, room labels, dimension lines, and annotations
Keep only: walls, doors, windows, stairs, and the new furniture outlines

========================================
OUTPUT REQUIREMENTS

Output the final image ONLY — no text, no commentary
Hyper-realistic wooden scale model appearance (see VISUAL STYLE section above)
Preserve the original image's aspect ratio exactly
Target width: 2126–2244 pixels (18–19 cm at 300 DPI) for A4 printing
No distortions

========================================
FINAL CHECK BEFORE OUTPUT
Verify each of the following before rendering:
[ ] No new doors, windows, or walls were added
[ ] No door or window is blocked by furniture
[ ] Every bathroom has exactly 1 sink, 1 toilet, 1 shower or bath
[ ] The sofa and TV console are on OPPOSITE walls, facing each other
[ ] The coffee table is between the sofa and TV, not beside them
[ ] No room is overcrowded
[ ] All furniture is fully inside room boundaries
[ ] All text and labels are removed
[ ] The output looks like a hyper-realistic laser-cut wooden physical model photographed from above
[ ] Wood grain, wall depth, shadows, and engraved furniture lines are all present
[ ] Layout looks like a real, livable home
`.trim();

    console.log('✅ Sending floorplan image to Grok...');

    const grokResponse = await fetch('https://api.x.ai/v1/images/edits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-imagine-image",
        prompt: finalPrompt,
        image: {
          url: imageDataUri,
          type: "image_url"
        }
      })
    });

    const data = await grokResponse.json();

    console.log('Grok response status:', grokResponse.status);
    console.log('Grok response body:', JSON.stringify(data));

    if (!grokResponse.ok) {
      console.error('❌ Grok API error:', data);
      return res.status(500).json({
        error: data.error?.message || 'Grok API returned an error',
        detail: data
      });
    }

    const generatedUrl = data.data?.[0]?.url;

    if (!generatedUrl) {
      return res.status(500).json({ error: 'No image URL returned from Grok', detail: data });
    }

    res.status(200).json({ success: true, imageUrl: generatedUrl });

  } catch (error) {
    console.error('❌ Backend crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
