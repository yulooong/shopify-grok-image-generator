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
### ROLE: Professional Architectural Model Maker & Industrial Designer

### 🛑 STRUCTURAL INTEGRITY (NON-NEGOTIABLE SOURCE OF TRUTH):
- THE UPLOADED IMAGE IS THE ABSOLUTE BLUEPRINT. 
- DO NOT remove, shift, add, or modify any existing wall structures or partitions. 
- The 3D walls must be a perfect 1:1 extrusion of the original lines. 
- Preserve the exact layout, room proportions, and spatial geometry of the uploaded file.

### TASK:
Convert the uploaded floorplan into a high-fidelity 3D wooden "Site Model" photograph. Interpret the layout and auto-populate it with 2D engraved furniture based on the logic below.

### CAMERA & VIEWPOINT:
- View: Strict 90-degree Top-Down Orthographic Projection.
- Lens: Zero perspective distortion, zero vanishing points.
- Framing: The model must be centered and fill 85% of the frame.

### MATERIAL & COLOR SPECS:
1. BASE: A single CNC-cut sheet of light birch wood (#E6C79C). The base must follow the exact exterior perimeter of the house.
2. WALLS (3D): Extruded 3D laser-cut wood blocks (#D8B58A). Render walls with physical thickness and 10mm height. Add soft ambient occlusion shadows where walls meet the floor.
3. FURNITURE (2D ENGRAVED): All interior elements must be dark brown "burnt" wood engravings (#4A2E1A).
   - Furniture must be 100% flat (0mm height).
   - No shadows on furniture.
   - Use clean, minimalist line-art for furniture silhouettes.

### AUTO-POPULATION ROOM LOGIC:
Identify room types and auto-populate with these 2D engraved items (do not create new rooms, only fill existing ones):
- LIVING ROOM: A sectional or 3-seater sofa, a rectangular coffee table, and a slim TV console.
- KITCHEN: Perimeter countertops, a double sink, a stovetop/hob, and a refrigerator silhouette.
- DINING AREA: A dining table with 4 to 6 chairs tucked in.
- MASTER BEDROOM: A King-sized bed, two nightstands, and a long wardrobe silhouette.
- OTHER BEDROOMS: A Queen or Twin bed and a small desk.
- BATHROOMS: A walk-in shower area, a toilet, and a vanity/sink.

### CLEANLINESS & OUTPUT PROTOCOL:
- REMOVAL: Permanently wipe all original text, room names, dimensions, and grid lines. The final model should have NO alphabetic or numeric characters.
- BACKGROUND: Place the model on a Solid, Pure White (#FFFFFF) background for high-contrast extraction.
- NO EXTRA ELEMENTS: No hands, no rulers, no tables, no studio props. Only the wooden model.

### FINAL AESTHETIC: 
Clean, professional, minimalist architectural mockup.
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
