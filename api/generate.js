// api/generate.js
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

// ── Detect red rectangle, cut a hole in the frame, composite naturally ───────
async function buildComposite(frameBuffer, floorplanBuffer) {

  // 1. Get frame pixel data
  const { data: frameData, info } = await sharp(frameBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: frameW, height: frameH } = info;
  const ch = 4;

  // 2. Find the red rectangle bounds
  let minX = frameW, minY = frameH, maxX = 0, maxY = 0, found = false;

  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameW; x++) {
      const i = (y * frameW + x) * ch;
      const r = frameData[i], g = frameData[i + 1], b = frameData[i + 2];
      if (r > 180 && g < 80 && b < 80) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  if (!found) throw new Error('Red rectangle not found in frame image');

  // Expand rect by 2px inward so the mat edge cleanly overlaps
  const rect = {
    left:   minX + 2,
    top:    minY + 2,
    width:  (maxX - minX) - 4,
    height: (maxY - minY) - 4,
  };

  console.log('✅ Red rectangle detected:', rect);

  // 3. Cut a transparent hole in the frame at the rect position
  //    (this lets the floorplan show through from behind)
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const i = (y * frameW + x) * ch;
      frameData[i + 3] = 0; // make fully transparent
    }
  }

  const frameWithHole = await sharp(Buffer.from(frameData), {
    raw: { width: frameW, height: frameH, channels: 4 },
  }).png().toBuffer();

  // 4. Resize floorplan to fill the hole exactly
  const resizedFloorplan = await sharp(floorplanBuffer)
    .resize(rect.width, rect.height, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  // 5. Build inner shadow overlay — makes the floorplan look recessed into the frame
  const shadowSize = 22;
  const shadowData = Buffer.alloc(rect.width * rect.height * 4, 0);

  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const i = (y * rect.width + x) * 4;
      const dist = Math.min(x, y, rect.width - 1 - x, rect.height - 1 - y);
      if (dist < shadowSize) {
        const strength = Math.pow(1 - dist / shadowSize, 1.6);
        shadowData[i]     = 20;  // R (dark warm shadow)
        shadowData[i + 1] = 15;  // G
        shadowData[i + 2] = 10;  // B
        shadowData[i + 3] = Math.round(strength * 160); // alpha max ~160
      }
    }
  }

  const innerShadow = await sharp(shadowData, {
    raw: { width: rect.width, height: rect.height, channels: 4 },
  }).png().toBuffer();

  // 6. Composite layers (bottom to top):
  //    [white background] → [floorplan] → [inner shadow] → [frame with hole]
  const result = await sharp({
    create: {
      width: frameW,
      height: frameH,
      channels: 4,
      background: { r: 248, g: 246, b: 243, alpha: 1 }, // warm white matches mat
    },
  })
    .composite([
      // Layer 1: floorplan sits in the hole position
      { input: resizedFloorplan, left: rect.left, top: rect.top, blend: 'over' },
      // Layer 2: inner shadow on top of floorplan — creates depth/recession illusion
      { input: innerShadow, left: rect.left, top: rect.top, blend: 'over' },
      // Layer 3: frame WITH hole sits on top — mat board naturally overlaps floorplan edges
      { input: frameWithHole, left: 0, top: 0, blend: 'over' },
    ])
    .png()
    .toBuffer();

  return result;
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
You are an expert architectural drafter. Your ONLY job is to add furniture outlines to an existing floorplan image.
========================================
RULE 0 — ABSOLUTE STRUCTURAL PRESERVATION (MOST IMPORTANT)
You must NEVER add, move, remove, or alter ANY of the following:
Walls, Doors (including door swing arcs), Windows, Staircases, Room boundaries or openings.
The structural layout must be 100% identical to the uploaded image.
Only furniture is added. Nothing else changes.
========================================
VISUAL STYLE — HYPER-REALISTIC WOODEN MODEL
The output must look like a physical laser-cut wooden architectural scale model photographed from directly above.
Floor surfaces: warm amber/honey wood tone (#D4A96A) with subtle horizontal wood grain lines.
Walls: thick, dark walnut brown (#5C3317) with slightly raised 3D appearance.
Exterior border: darkest wood tone (#3D1F0A), slightly thicker than interior walls.
Furniture outlines: laser-engraved into the wood surface — thin dark brown lines (#3D1F0A), completely flat with zero depth or 3D effect.
Walls ONLY must cast a faint drop shadow to simulate physical raised dividers.
Furniture has ZERO shadow, ZERO depth, ZERO 3D effect of any kind.
Furniture looks like laser engravings burned into the wood, not objects placed on top of it.
CRITICAL: The background MUST be a plain warm off-white (#F5F2EE) with NO gradients, NO blue, NO grey tones, NO shadows on the background itself.
========================================
FURNITURE RULES
LIVING ROOM: Sofa against one wall facing the TV console on the opposite wall. Coffee table centred between them.
BEDROOM: Exactly 1 bed. Max 1–2 bedside tables if space allows. Optional dresser in larger rooms.
DINING: Exactly 1 dining table with 2–6 chairs around it.
KITCHEN: 1 stove, 1 fridge, 1 sink — all along walls.
BATHROOM: Exactly 1 toilet, 1 sink, 1 shower OR 1 bathtub (not both unless clearly large enough).
SMALL/UNCLEAR ROOMS: Add nothing.
========================================
STRICT RULES
All furniture fully inside room boundaries.
Never block any door, window, or entryway.
No furniture within 60 cm of any door opening.
Align furniture to walls or room axis only. No random angles.
========================================
CLEANUP
Remove ALL text, room labels, dimension lines, and annotations.
Keep only: walls, doors, windows, stairs, and new furniture outlines.
========================================
OUTPUT
Output the final image ONLY — no text, no commentary.
Hyper-realistic wooden scale model appearance.
Preserve the original image's aspect ratio exactly.
`.trim();

    // ── 1. Call Grok ──────────────────────────────────────────────────────────
    console.log('✅ Sending floorplan to Grok...');
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
      return res.status(500).json({ error: grokData.error?.message || 'Grok API error', detail: grokData });

    const generatedUrl = grokData.data?.[0]?.url;
    if (!generatedUrl)
      return res.status(500).json({ error: 'No image URL from Grok', detail: grokData });

    // ── 2. Download generated floorplan ───────────────────────────────────────
    const floorplanResp = await fetch(generatedUrl);
    if (!floorplanResp.ok)
      return res.status(500).json({ error: 'Failed to download floorplan' });
    const floorplanBuffer = Buffer.from(await floorplanResp.arrayBuffer());

    // ── 3. Load frame template ────────────────────────────────────────────────
    const framePath = path.join(process.cwd(), 'public', 'Clean_Hausframe_Template.png');
    const frameBuffer = fs.readFileSync(framePath);

    // ── 4. Build composite ────────────────────────────────────────────────────
    const finalImage = await buildComposite(frameBuffer, floorplanBuffer);

    // ── 5. Return base64 ──────────────────────────────────────────────────────
    const base64 = finalImage.toString('base64');
    res.status(200).json({ success: true, imageUrl: `data:image/png;base64,${base64}` });

  } catch (error) {
    console.error('❌ Backend crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
