// api/generate.js
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

async function buildComposite(frameBuffer, floorplanBuffer) {

  // 1. Get frame pixel data
  const { data: frameData, info } = await sharp(frameBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: frameW, height: frameH } = info;
  const ch = 4;

  // 2. Find red rectangle bounds
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

  // 3. Expand hole OUTWARD by 4px to swallow the red border pixels entirely
  const expand = 4;
  const holeLeft   = Math.max(0, minX - expand);
  const holeTop    = Math.max(0, minY - expand);
  const holeRight  = Math.min(frameW - 1, maxX + expand);
  const holeBottom = Math.min(frameH - 1, maxY + expand);
  const holeW      = holeRight - holeLeft;
  const holeH      = holeBottom - holeTop;

  console.log('✅ Hole cut at:', { holeLeft, holeTop, holeW, holeH });

  // 4. Cut transparent hole — punch straight through including the red outline
  for (let y = holeTop; y <= holeBottom; y++) {
    for (let x = holeLeft; x <= holeRight; x++) {
      const i = (y * frameW + x) * ch;
      frameData[i + 3] = 0; // fully transparent
    }
  }

  const frameWithHole = await sharp(Buffer.from(frameData), {
    raw: { width: frameW, height: frameH, channels: 4 },
  }).png().toBuffer();

  // 5. Resize floorplan to fill the hole exactly
  const resizedFloorplan = await sharp(floorplanBuffer)
    .resize(holeW, holeH, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  // 6. Build inner shadow — simulates the floorplan sitting recessed behind the mat
  const shadowDepth = 28;
  const shadowData  = Buffer.alloc(holeW * holeH * 4, 0);

  for (let y = 0; y < holeH; y++) {
    for (let x = 0; x < holeW; x++) {
      const i    = (y * holeW + x) * 4;
      const dist = Math.min(x, y, holeW - 1 - x, holeH - 1 - y);
      if (dist < shadowDepth) {
        const strength       = Math.pow(1 - dist / shadowDepth, 2);
        shadowData[i]        = 15;
        shadowData[i + 1]    = 10;
        shadowData[i + 2]    = 8;
        shadowData[i + 3]    = Math.round(strength * 180);
      }
    }
  }

  const innerShadow = await sharp(shadowData, {
    raw: { width: holeW, height: holeH, channels: 4 },
  }).png().toBuffer();

  // 7. Sample the mat colour from just outside the hole (top-left corner area)
  //    so the background exactly matches the frame's mat board
  const sampleIdx = ((holeTop - 10) * frameW + (holeLeft + holeW / 2 | 0)) * ch;
  const matR = frameData[sampleIdx] || 245;
  const matG = frameData[sampleIdx + 1] || 243;
  const matB = frameData[sampleIdx + 2] || 240;

  // 8. Composite: [mat background] → [floorplan] → [inner shadow] → [frame on top]
  const result = await sharp({
    create: {
      width:    frameW,
      height:   frameH,
      channels: 4,
      background: { r: matR, g: matG, b: matB, alpha: 1 },
    },
  })
    .composite([
      { input: resizedFloorplan, left: holeLeft, top: holeTop, blend: 'over' },
      { input: innerShadow,      left: holeLeft, top: holeTop, blend: 'over' },
      { input: frameWithHole,    left: 0,         top: 0,       blend: 'over' },
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

RULE 0 — STRUCTURAL PRESERVATION
Never add, move, remove, or alter walls, doors, windows, staircases, or room boundaries.
Only furniture is added.

VISUAL STYLE — HYPER-REALISTIC WOODEN MODEL
Output must look like a physical laser-cut wooden scale model photographed from directly above.
- Floor: warm amber/honey wood tone (#D4A96A) with subtle horizontal grain lines
- Walls: dark walnut brown (#5C3317), slightly raised 3D appearance with faint drop shadow
- Furniture: laser-engraved outlines only — thin dark lines (#3D1F0A), ZERO shadow, ZERO depth, ZERO 3D effect
- Background: MUST be plain warm off-white (#F5F2EE) — NO gradients, NO blue, NO grey tones

FURNITURE RULES
- Living room: sofa vs TV on opposite walls, coffee table centred between
- Bedroom: 1 bed, max 2 bedside tables, optional dresser
- Dining: 1 table, 2–6 chairs
- Kitchen: 1 stove, 1 fridge, 1 sink along walls
- Bathroom: 1 toilet, 1 sink, 1 shower OR bathtub
- Unclear/small rooms: add nothing

STRICT RULES
- All furniture inside room boundaries
- Never block doors or windows
- No furniture within 60cm of any door
- Furniture aligned to room axes only

CLEANUP
Remove all text, labels, dimensions. Keep only walls, doors, windows, stairs, new furniture.

OUTPUT
Final image only, no text. Preserve exact aspect ratio. Warm off-white background only.
`.trim();

    // ── 1. Call Grok ──────────────────────────────────────────────────────────
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

    // ── 2. Download floorplan ─────────────────────────────────────────────────
    const floorplanResp = await fetch(generatedUrl);
    if (!floorplanResp.ok)
      return res.status(500).json({ error: 'Failed to download floorplan' });
    const floorplanBuffer = Buffer.from(await floorplanResp.arrayBuffer());

    // ── 3. Load frame ─────────────────────────────────────────────────────────
    const framePath = path.join(process.cwd(), 'public', 'Clean_Hausframe_Template.png');
    const frameBuffer = fs.readFileSync(framePath);

    // ── 4. Build composite ────────────────────────────────────────────────────
    const finalImage = await buildComposite(frameBuffer, floorplanBuffer);

    const base64 = finalImage.toString('base64');
    res.status(200).json({ success: true, imageUrl: `data:image/png;base64,${base64}` });

  } catch (error) {
    console.error('❌ Backend crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
