// api/generate.js
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  // === CORS HEADERS (allows Shopify to call this) ===
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request from browser
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check API key exists before doing anything
  if (!process.env.XAI_API_KEY) {
    console.error('❌ XAI_API_KEY is not set in Vercel environment variables');
    return res.status(500).json({ error: 'Server misconfiguration: API key missing' });
  }

  try {
    // ✅ image is extracted from the request body
    const { image: imageDataUri } = req.body || {};

    if (!imageDataUri) {
      return res.status(400).json({ error: 'No image provided in request body' });
    }

    const finalPrompt = `
You are an expert AI specializing in architectural floorplan enhancement and interior layout optimization.
Your goal is to produce realistic, functional, and spatially accurate furniture layouts — prioritizing real-world usability over creativity.

I am uploading a bird's eye view floorplan image of a house. Edit this image and output ONLY the final edited image (no text, no explanations).

----------------------------------------
WALL STANDARDIZATION
----------------------------------------
Convert all walls into clean, bold black lines with consistent thickness.
Walls must be clearly distinguishable from all other elements.

----------------------------------------
ROOM & LAYOUT PROCESS (MANDATORY)
----------------------------------------
For each room, follow this exact process:

  Step 1: Identify the room type based on layout, size, and connectivity.
  Step 2: Define the room's primary function and focal point.
  Step 3: Place the main anchor furniture first (bed, sofa, or dining table).
  Step 4: Add secondary furniture ONLY if space allows after applying clearance rules.
  Step 5: Validate walkability, spacing, and realism before finalizing.

If a room is too small or unclear, place minimal or no furniture.

----------------------------------------
STRICT PLACEMENT RULES (NON-NEGOTIABLE)
----------------------------------------
1. All furniture must be fully inside room boundaries — no overlaps with walls.
2. Maintain walking clearance:
   - Main paths: 70–90 cm
   - Secondary paths: 50–60 cm
3. Do NOT block:
   - Doors (assume door swing clearance even if not shown)
   - Windows
   - Entryways between rooms
4. Align furniture to walls or center it logically. No random angles.
5. Keep all furniture aligned to the room's primary axis (horizontal/vertical).
6. Maintain realistic spacing:
   - Bed: at least one accessible side (≥50 cm)
   - Sofa ↔ coffee table: 30–50 cm
   - Dining chairs: ≥60 cm clearance behind
7. Scale furniture proportionally to room size.
8. Each room must have ONE clear focal point (e.g., bed, TV, dining table).

----------------------------------------
FURNITURE RULES (MINIMAL & REALISTIC)
----------------------------------------
Only include essential furniture:

  - Living room:  1 sofa (or L-shape), 1 coffee table, 1 TV console. Optional: 1 rug or plant.
  - Bedroom:      1 bed, max 2 bedside tables, optional dresser.
  - Dining:       1 table with chairs (ensure proper clearance).
  - Kitchen:      Essential fixtures only (counter, stove, sink, fridge).
  - Bathroom:     Sink, toilet, shower/bath only.

Do NOT overfill spaces. Empty space is intentional and important.

----------------------------------------
AVOID THESE MISTAKES
----------------------------------------
  - No overcrowding
  - No floating or misaligned furniture
  - No blocking functional paths
  - No unrealistic layouts (e.g., bed against door, TV behind sofa)
  - No forcing furniture into small rooms
  - No unnecessary symmetry

----------------------------------------
VISUAL STYLE
----------------------------------------
  - Furniture must be simple black outline drawings only
  - No colors, no shading, no fills
  - Clean, minimal linework only
  - Mix of shapes (rectangular + some rounded elements) for realism

----------------------------------------
CLEANUP
----------------------------------------
Remove ALL text, labels, and annotations from the image completely.

----------------------------------------
FINAL VALIDATION (MANDATORY)
----------------------------------------
Before output:
  - Ensure no overlaps or blocked paths
  - Ensure all spacing rules are followed
  - Ensure the layout looks like a real, livable home
  - Remove anything awkward, excessive, or unrealistic

----------------------------------------
OUTPUT REQUIREMENTS
----------------------------------------
  - Output ONLY the final edited floorplan image
  - Plain white background
  - Maintain original aspect ratio
  - Resize for A4 printing:
      - Target width: 18–19 cm at 300 DPI (~2126–2244 pixels)
      - No distortions, no additional elements

Execute with precision and realism.
`.trim();

    console.log('✅ Sending floorplan image to Grok for furniture generation...');

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

    // Log the full Grok response so you can see it in Vercel logs
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
