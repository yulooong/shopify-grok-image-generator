// api/generate.js
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

// ─── Step 1: Scan the frame PNG and find the red rectangle bounds ───────────
async function findAndEraseRedRect(frameBuffer) {
  const { data, info } = await sharp(frameBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const ch = 4; // RGBA
  let minX = width, minY = height, maxX = 0, maxY = 0, found = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // Detect vivid red pixels (the rectangle outline)
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

  const rect = { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
  console.log('✅ Red rectangle detected:', rect);

  // Erase the red outline by painting warm-white over the full detected area
  // (slightly expand by 3px to ensure no red bleeds through)
  const eraseW = rect.width + 6;
  const eraseH = rect.height + 6;

  const whitePatch = await sharp({
    create: {
      width: eraseW,
      height: eraseH,
      channels: 4,
      background: { r: 243, g: 241, b: 239, alpha: 1 }, // matches frame mat colour
    },
  }).png().toBuffer();

  const cleanedFrame = await sharp(frameBuffer)
    .composite([{ input: whitePatch, left: rect.left - 3, top: rect.top - 3 }])
    .png()
    .toBuffer();

  return { cleanedFrame, rect };
}

// ─── Step 2: Composite floorplan into frame naturally ───────────────────────
async function buildFinalImage(cleanedFrame, floorplanBuffer, rect) {
  // Resize floorplan to exactly fill the detected rectangle
  const resized = await sharp(floorplanBuffer)
    .resize(rect.width, rect.height, { fit: 'cover', position: 'centre' })
    .toBuffer();

  // Add a very subtle dark inner-shadow edge so the floorplan looks
  // recessed into the frame (realistic mat-opening effect)
  const shadowOverlay = await sharp({
    create: {
      width: rect.width,
      height: rect.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();

  // Composite: floorplan into frame, then a soft vignette on top
  const result = await sharp(cleanedFrame)
    .composite([
      // 1. The floorplan fills the rectangle exactly
      { input: resized, left: rect.left, top: rect.top, blend: 'over' },
      // 2. Thin dark border around the floorplan for depth
      {
        input: await sharp({
          create: {
            width: rect.width,
            height: rect.height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        })
          .png()
          .toBuffer(),
        left: rect.left,
        top: rect.top,
        blend: 'multiply',
      },
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
    return res.status(500).json({ error: 'Server misconfiguration: API key missing' });

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
Background: off-white or light warm grey — NOT pure white.
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
      return res.status(500).json({ error: 'No image URL returned from Grok', detail: grokData });

    // ── 2. Download the generated floorplan ──────────────────────────────────
    const floorplanResp = await fetch(generatedUrl);
    if (!floorplanResp.ok)
      return res.status(500).json({ error: 'Failed to download generated floorplan' });
    const floorplanBuffer = Buffer.from(await floorplanResp.arrayBuffer());

    // ── 3. Load frame template ────────────────────────────────────────────────
    const framePath = path.join(process.cwd(), 'public', 'Clean_Hausframe_Template.png');
    const frameBuffer = fs.readFileSync(framePath);

    // ── 4. Auto-detect red rect, erase it, composite floorplan ───────────────
    const { cleanedFrame, rect } = await findAndEraseRedRect(frameBuffer);
    const finalImage = await buildFinalImage(cleanedFrame, floorplanBuffer, rect);

    // ── 5. Return as base64 ───────────────────────────────────────────────────
    const base64 = finalImage.toString('base64');
    res.status(200).json({ success: true, imageUrl: `data:image/png;base64,${base64}` });

  } catch (error) {
    console.error('❌ Backend crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
