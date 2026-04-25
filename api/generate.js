// api/generate.js
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

// Red rectangle coordinates inside Clean_Hausframe_Template.png
const FRAME = {
  left: 140,
  top: 360,
  width: 690,
  height: 485,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.XAI_API_KEY) {
    return res.status(500).json({ error: 'Server misconfiguration: API key missing' });
  }

  try {
    const { image: imageDataUri } = req.body || {};
    if (!imageDataUri) return res.status(400).json({ error: 'No image provided' });

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
Furniture outlines: laser-engraved into the wood surface — thin dark brown lines (#3D1F0A), completely flat with zero depth or 3D effect

WOOD GRAIN TEXTURE:

Apply fine, parallel horizontal grain lines across all floor surfaces
Grain lines should be subtle — slightly darker than the base floor color
Vary grain direction slightly between rooms to suggest individual wood panels

DEPTH & REALISM — 3D EFFECT APPLIES TO WALLS ONLY:

Walls ONLY must cast a faint drop shadow (soft, rightward and downward) to simulate physical raised dividers
The entire floorplan model should cast a soft drop shadow on the background, as if physically resting on a surface
Background: off-white or light warm grey — NOT pure white — to simulate a photography surface

FURNITURE — ABSOLUTELY NO 3D EFFECT (CRITICAL):

Furniture has ZERO shadow of any kind — not drop shadow, not cast shadow, not contact shadow, not ambient shadow
Furniture has ZERO depth, ZERO emboss, ZERO bevel, ZERO extrusion, ZERO raised effect
Furniture lines do NOT interact with the lighting model in any way
Furniture is NOT an object sitting on the floor — it is a mark burned INTO the floor surface
Treat every furniture outline exactly like a laser burn or CNC engraving: it is a groove in the wood, flush with the surface, with no physical presence above the floor
If you are about to add any shadow, lift, or depth to a furniture item — STOP and remove it entirely

LIGHTING:

Simulate soft overhead studio lighting on walls only
Walls appear slightly lighter on their top edge and slightly darker on their side face to reinforce the 3D raised effect
Furniture lines are completely unaffected by any lighting — they are recessed grooves, not objects

FURNITURE STYLE:

All furniture rendered as laser-engraved outlines only — thin, clean, flat dark lines scored into the wood surface
No fills, no shading, no colours, no shadows, no gradients on or around any furniture
The floor beneath and around furniture is identical to the floor everywhere else — no darkening, no highlighting, no halo

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
Bed: at least one accessible side (>=50 cm)
Sofa to coffee table: 30–50 cm
Dining chairs: >=60 cm clearance behind

Scale furniture proportionally to room size.
Each room must have ONE clear focal point (e.g., bed, TV, dining table).

========================================
FURNITURE RULES (MINIMAL AND REALISTIC)
LIVING ROOM:
Step 1: Place the sofa against one wall. The sofa faces AWAY from that wall, toward the centre.
Step 2: Place the TV console flat against the wall directly in front of the sofa.
Step 3: Place the coffee table in the open space between the sofa and the TV console.
The sofa and TV must be on OPPOSITE walls, facing each other.

BEDROOM:
Exactly 1 bed
Maximum 1–2 bedside tables only if space allows
Optional: 1 dresser against a wall only in larger bedrooms

DINING ROOM:
Exactly 1 dining table
Chairs placed only around the table (2–6 chairs depending on table size)

KITCHEN:
Trace and preserve existing counter/fixture shapes only
Add: 1 stove symbol, 1 fridge symbol, 1 sink symbol — all along walls

BATHROOM (CRITICAL):
Exactly 1 toilet
Exactly 1 sink (never 2, never 0)
Exactly 1 shower OR 1 bathtub — NOT both, unless the room is clearly large enough for both

SMALL ROOMS:
If the room purpose is unclear or the space is tight: add nothing

========================================
CLEANUP
Remove ALL existing text, room labels, dimension lines, and annotations
Keep only: walls, doors, windows, stairs, and the new furniture outlines

========================================
OUTPUT REQUIREMENTS
Output the final image ONLY — no text, no commentary
Hyper-realistic wooden scale model appearance
Preserve the original image's aspect ratio exactly
No distortions
`.trim();

    // 1. Call Grok to generate the floorplan
    const grokResponse = await fetch('https://api.x.ai/v1/images/edits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-imagine-image",
        prompt: finalPrompt,
        image: { url: imageDataUri, type: "image_url" }
      })
    });

    const grokData = await grokResponse.json();

    if (!grokResponse.ok) {
      return res.status(500).json({ error: grokData.error?.message || 'Grok API error', detail: grokData });
    }

    const generatedUrl = grokData.data?.[0]?.url;
    if (!generatedUrl) {
      return res.status(500).json({ error: 'No image URL returned from Grok', detail: grokData });
    }

    // 2. Download the generated floorplan image
    const floorplanResponse = await fetch(generatedUrl);
    if (!floorplanResponse.ok) {
      return res.status(500).json({ error: 'Failed to download generated floorplan' });
    }
    const floorplanBuffer = Buffer.from(await floorplanResponse.arrayBuffer());

    // 3. Load the frame template from disk
    const framePath = path.join(process.cwd(), 'public', 'Clean_Hausframe_Template.png');
    const frameBuffer = fs.readFileSync(framePath);

    // 4. Resize the floorplan to fit exactly inside the red rectangle
    const resizedFloorplan = await sharp(floorplanBuffer)
      .resize(FRAME.width, FRAME.height, { fit: 'cover' })
      .toBuffer();

    // 5. Composite: paste the floorplan INTO the frame at the red rectangle position
    const composited = await sharp(frameBuffer)
      .composite([{
        input: resizedFloorplan,
        left: FRAME.left,
        top: FRAME.top,
      }])
      .png()
      .toBuffer();

    // 6. Return as base64 data URI
    const base64 = composited.toString('base64');
    const dataUri = `data:image/png;base64,${base64}`;

    res.status(200).json({ success: true, imageUrl: dataUri });

  } catch (error) {
    console.error('Backend crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
