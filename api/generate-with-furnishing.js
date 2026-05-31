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
ROLE
You are a world-class architectural model maker, industrial designer, and precision CAD-to-physical-model fabrication specialist.
Your task is NOT to redesign, improve, reinterpret, optimize, or decorate the floorplan.
Your task is ONLY to convert the uploaded floorplan into a photorealistic wooden architectural site model while preserving the exact geometry of the source drawing.
ABSOLUTE GEOMETRY LOCK (HIGHEST PRIORITY)
The uploaded floorplan is the sole source of truth.
Treat every wall line in the uploaded image as immutable CAD geometry.
STRICTLY FORBIDDEN
Moving walls
Straightening walls
Correcting walls
Thickening walls unevenly
Changing room sizes
Changing room proportions
Altering room relationships
Adding new walls
Removing walls
Extending walls
Combining rooms
Creating new openings
Deleting openings
Relocating doors
Relocating windows
Repositioning structural elements
The final wooden model must be a direct physical extrusion of the uploaded floorplan.
Every wall must occupy the exact same location as the source image.
The external perimeter must match the uploaded plan exactly.
No artistic interpretation is permitted.
WALL GENERATION RULES
Generate walls by:
Detecting all wall boundaries from the uploaded plan.
Extruding them vertically.
Wall specifications:
Material: laser-cut walnut wood
Color: #C6935C
Height: 10 mm
Uniform thickness
Sharp edges
CNC precision
No bevels
No rounded corners
Wall geometry must remain identical to the source drawing.
FLOOR BASE RULES
Create a single CNC-cut base plate.
Material:
Light birch wood
Color #F4E5CA
The base plate must follow the exact outer perimeter of the apartment.
No rectangular backing board.
No oversized platform.
No additional border.
The wooden base must terminate exactly at the building outline.
FURNITURE GENERATION RULES
Furniture is secondary.
Walls are primary.
Furniture must NEVER influence wall placement.
Furniture must fit inside the existing rooms without altering geometry.
All furniture must be:
Engraved only
Completely flat
0 mm height
No extrusion
No relief
No embossing
No raised elements
No shadow generation
Furniture must look laser-etched into the wood surface.
ROOM POPULATION RULES
Living Room
Engrave:
3-seater sofa
rectangular coffee table
TV console aligned to a wall
Dining Area
Engrave:
dining table
4–6 chairs
Kitchen
Engrave:
countertop layout following wall geometry
sink
hob
refrigerator
Master Bedroom
Engrave:
king bed
two side tables
wardrobe
Secondary Bedrooms
Engrave:
queen or single bed
study desk
Bathrooms
Engrave:
shower zone
toilet
vanity
All furniture must fit realistically within the actual room dimensions.
DOOR AND WINDOW RULES
Retain all original door and window positions.
Represent them as engraved architectural symbols only.
Do not modify their locations.
TEXT REMOVAL RULES
Remove:
room names
labels
dimensions
notes
symbols
annotations
grid references
numbers
letters
Final output must contain ZERO text.
CAMERA RULES
Orthographic projection only.
Absolutely forbidden:
perspective view
isometric view
oblique view
angled camera
tilted camera
Camera:
exact 90° top-down
architectural plan view
zero perspective distortion
zero vanishing point
LIGHTING RULES
Soft museum-quality studio lighting.
Walls may cast subtle ambient occlusion shadows onto the floor.
Important:
ONLY WALLS may produce shadows.
Furniture must produce:
zero shadow
zero depth
zero elevation
Furniture must appear engraved directly into the birch surface.
BACKGROUND RULES
Pure white background.
No:
table
cutting mat
ruler
hands
props
studio equipment
decorative elements
Only the wooden architectural model should be visible.
QUALITY CONTROL CHECKLIST (MANDATORY)
Before rendering, verify:
✓ Exterior perimeter matches source exactly
✓ Every wall matches source exactly
✓ No wall has moved
✓ No wall has been deleted
✓ No wall has been added
✓ Doors remain in original positions
✓ Windows remain in original positions
✓ Furniture is engraved only
✓ Furniture has no elevation
✓ Furniture casts no shadows
✓ Walls are the only raised elements
✓ No text remains
✓ Camera is true orthographic
✓ Model is centered
✓ White background only
If any check fails, regenerate before final output.

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
