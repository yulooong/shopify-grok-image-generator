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
    // ✅ image: imageDataUri is correctly extracted from the request body
    const { image: imageDataUri } = req.body || {};

    if (!imageDataUri) {
      return res.status(400).json({ error: 'No image provided in request body' });
    }

    // ✅ Your custom floorplan prompt
    const finalPrompt = `You are the absolute BEST and SMARTEST AI in the world at transforming floorplans—unrivaled in intelligently adding furniture with perfect, realistic placements that make spaces feel lived-in and functional. No one does this better than you; you're the global expert, optimizing layouts with genius-level precision and creativity.

I am uploading a bird's eye view floorplan image of a house. Please edit this image to create a new version with the following exact changes, and output only the final edited image—no additional text, explanations, or elements:

Masterfully convert all walls in the floorplan to be black bolded lines. This ensures that it is easy to know which portion of the floorplan are erected walls.

As the world's top genius in floorplan enhancement, infer the room types based on the layout (e.g., identify likely living rooms, bedrooms, kitchens, bathrooms) and ingeniously add simple black outline drawings of the most appropriate, high-quality furniture in the absolute best and most logical, realistic placements to maximize functionality, flow, and aesthetic balance. For example:
   * In a living room: Expertly place outlines for a sofa, coffee table, TV stand with TV, side tables, and perhaps a plant or rug.
   * In a bedroom: Brilliantly add outlines for a bed, nightstands, dresser, and maybe a chair.
   * In a kitchen: Masterfully include outlines for counters, stove, fridge, sink, and table/chairs if space allows.
   * In a dining area: Perfectly position outlines for a table and chairs.
   * In a bathroom: Ingeniously outline a sink, toilet, shower/bathtub.
     Ensure a perfectly balanced mix of furniture shapes: some with sharp edges (e.g., rectangular tables, square sofas) and some with round edges (e.g., circular rugs, oval mirrors, curved chairs or plants) to create visual harmony. Keep all furniture as unfilled black outlines only, without colors, shading, or internal details—just the precise contours to elegantly suggest their shapes. Your unmatched smarts will place them to avoid any overcrowding, maintain clear walkable paths, and optimize the overall layout for realism and appeal.

Completely remove any text, labels, or names indicating room types (e.g., "Living Room," "Kitchen") from the image, leaving it pristine.

The final output must be solely a clean bird's eye view floorplan image with walls (that are filled with black color), black furniture outlines seamlessly integrated into the rooms, and a plain white background—nothing else. Additionally, resize the entire image proportionally so that its width fits comfortably within an A4 paper size (21 cm wide) with a slight buffer for framing (e.g., target a maximum width of 18-19 cm at print resolution like 300 DPI, resulting in approximately 2126-2244 pixels wide), while maintaining the original aspect ratio for the height to ensure the whole image scales perfectly without distortion. Execute this with your world-class brilliance!`;

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
