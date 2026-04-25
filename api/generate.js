// api/generate.js
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

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

    // ── STEP 1: Generate the wooden 3D floorplan model from the uploaded floorplan ──
    const modelPrompt = `
You are an expert architectural visualiser.

Take the uploaded floorplan image and redraw it as a hyper-realistic physical laser-cut wooden architectural scale model viewed from DIRECTLY ABOVE (top-down, 90 degrees, perfectly flat overhead shot — NOT perspective, NOT angled).

WOODEN MODEL STYLE:
- Floor surfaces: warm amber/honey wood (#D4A96A) with fine horizontal grain lines
- Walls: thick dark walnut brown (#5C3317), slightly raised 3D with faint drop shadow
- Exterior border: darkest wood (#3D1F0A), thicker than interior walls
- Furniture: laser-engraved outlines only — thin dark lines (#3D1F0A), ZERO shadow, ZERO depth
- Background behind the model: plain warm off-white (#F5F2EE), NO gradients, NO blue

ROOM FURNITURE (laser-engraved, flat):
- Living room: sofa against wall facing TV unit on opposite wall, coffee table centred between
- Bedroom: 1 bed, max 2 bedside tables, optional dresser
- Dining: 1 table, 2–6 chairs around it
- Kitchen: stove, fridge, sink symbols along walls
- Bathroom: 1 toilet, 1 sink, 1 shower OR bathtub
- Small/unclear rooms: nothing

RULES:
- Preserve ALL walls, doors, windows, stairs exactly as in the uploaded image
- All furniture inside boundaries, never block doors or windows
- Remove all text, labels, dimensions from the original

OUTPUT: Top-down wooden model image only. No text. Exact aspect ratio preserved.
`.trim();

    console.log('Step 1: Generating wooden model...');
    const step1 = await fetch('https://api.x.ai/v1/images/edits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-imagine-image',
        prompt: modelPrompt,
        image: { url: imageDataUri, type: 'image_url' },
      }),
    });

    const step1Data = await step1.json();
    if (!step1.ok)
      return res.status(500).json({ error: step1Data.error?.message || 'Step 1 Grok error', detail: step1Data });

    const modelImageUrl = step1Data.data?.[0]?.url;
    if (!modelImageUrl)
      return res.status(500).json({ error: 'No model image URL from Grok', detail: step1Data });

    // ── STEP 2: Generate the full lifestyle product photo ──────────────────────
    const lifestylePrompt = `
You are a professional product photographer and CGI artist.

Take the provided image (a top-down wooden laser-cut floorplan model) and place it INSIDE a shadow box picture frame to create a hyper-realistic lifestyle product photo. The final image must look like a real physical product being sold online.

FRAME:
- Natural light maple/beech wood shadow box frame
- Frame has depth (it is a box frame, not flat) — the wooden floorplan model sits raised inside
- White/off-white mat board surrounds the model inside the frame
- The wooden model casts a soft natural shadow downward onto the mat board beneath it

SCENE & PHOTOGRAPHY STYLE:
- The framed product is propped upright, slightly angled (about 5–10 degrees tilt), resting on a clean light wooden table
- Background: bright, airy modern Scandinavian home interior — softly blurred (bokeh), warm natural light from a window to the side
- Lighting: soft natural daylight, subtle warm shadows, photorealistic
- Camera angle: slightly above eye level, three-quarter perspective view of the frame
- The overall mood is warm, premium, lifestyle product photography — like something from a high-end Etsy or design store listing
- The floorplan model inside the frame must be clearly visible and recognisable

CRITICAL:
- The floorplan model from the input image must appear INSIDE the frame — do not alter its structure
- The frame must look like a real physical object with wood grain, depth, and natural shadows
- This must look like a real photograph, NOT a digital illustration or mockup template

OUTPUT: Final lifestyle product photo only. No text overlaid. Photorealistic.
`.trim();

    console.log('Step 2: Generating lifestyle product photo...');
    const step2 = await fetch('https://api.x.ai/v1/images/edits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-imagine-image',
        prompt: lifestylePrompt,
        image: { url: modelImageUrl, type: 'image_url' },
      }),
    });

    const step2Data = await step2.json();
    if (!step2.ok)
      return res.status(500).json({ error: step2Data.error?.message || 'Step 2 Grok error', detail: step2Data });

    const finalImageUrl = step2Data.data?.[0]?.url;
    if (!finalImageUrl)
      return res.status(500).json({ error: 'No lifestyle image URL from Grok', detail: step2Data });

    // Return the final URL directly — no compositing needed
    res.status(200).json({ success: true, imageUrl: finalImageUrl });

  } catch (error) {
    console.error('❌ Backend crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
