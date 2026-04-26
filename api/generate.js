// api/generate.js
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

async function buildComposite(frameBuffer, floorplanBuffer) {

  // ── 1. Read frame pixels ───────────────────────────────────────────────────
  const { data: frameData, info } = await sharp(frameBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: frameW, height: frameH } = info;
  const ch = 4;

  // ── 2. Find red rectangle bounds ──────────────────────────────────────────
  let minX = frameW, minY = frameH, maxX = 0, maxY = 0, found = false;

  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameW; x++) {
      const i = (y * frameW + x) * ch;
      if (frameData[i] > 180 && frameData[i+1] < 80 && frameData[i+2] < 80) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  if (!found) throw new Error('Red rectangle not found in frame image');

  // ── 3. Expand hole outward by 5px to fully swallow red border ─────────────
  const pad = 5;
  const holeLeft   = Math.max(0, minX - pad);
  const holeTop    = Math.max(0, minY - pad);
  const holeRight  = Math.min(frameW - 1, maxX + pad);
  const holeBottom = Math.min(frameH - 1, maxY + pad);
  const holeW      = holeRight - holeLeft;
  const holeH      = holeBottom - holeTop;

  console.log('✅ Hole:', { holeLeft, holeTop, holeW, holeH });

  // ── 4. Cut transparent hole in frame ──────────────────────────────────────
  for (let y = holeTop; y <= holeBottom; y++) {
    for (let x = holeLeft; x <= holeRight; x++) {
      frameData[(y * frameW + x) * ch + 3] = 0;
    }
  }

  const frameWithHole = await sharp(Buffer.from(frameData), {
    raw: { width: frameW, height: frameH, channels: 4 },
  }).png().toBuffer();

  // ── 5. Resize floorplan to exactly fill the hole ──────────────────────────
  const resizedFloorplan = await sharp(floorplanBuffer)
    .resize(holeW, holeH, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  // ── 6. Sample mat colour from frame (area just above the hole) ─────────────
  const sampleY    = Math.max(0, holeTop - 20);
  const sampleX    = holeLeft + Math.floor(holeW / 2);
  const sampleIdx  = (sampleY * frameW + sampleX) * ch;
  const matR       = frameData[sampleIdx]     || 245;
  const matG       = frameData[sampleIdx + 1] || 243;
  const matB       = frameData[sampleIdx + 2] || 240;

  // ── 7. Cast shadow ─────────────────────────────────────────────────────────
  // This is the key to realism: the wooden model casts a soft shadow
  // on the mat board below it, as if it is physically raised inside the frame.
  // Shadow falls bottom-right (light source top-left, like the reference photo).
  const shadowOffsetX = 10;
  const shadowOffsetY = 16;
  const shadowBlur    = 18;

  // Create filled rectangle the size of the hole
  const shadowBase = await sharp({
    create: {
      width:    holeW,
      height:   holeH,
      channels: 4,
      background: { r: 40, g: 28, b: 18, alpha: 120 },
    },
  })
    .blur(shadowBlur)
    .png()
    .toBuffer();

  // ── 8. Composite — order matters: ─────────────────────────────────────────
  //    [mat background]
  //    → [cast shadow on mat, offset bottom-right]
  //    → [floorplan sits in hole]
  //    → [frame on top — mat is opaque, hole is transparent]
  const result = await sharp({
    create: {
      width:    frameW,
      height:   frameH,
      channels: 4,
      background: { r: matR, g: matG, b: matB, alpha: 1 },
    },
  })
    .composite([
      // Shadow falls on the mat, shifted bottom-right of the hole
      {
        input:  shadowBase,
        left:   Math.min(frameW - holeW, holeLeft + shadowOffsetX),
        top:    Math.min(frameH - holeH, holeTop  + shadowOffsetY),
        blend:  'multiply',   // darkens the mat beneath, doesn't affect frame wood
      },
      // Floorplan fills the hole exactly
      {
        input:  resizedFloorplan,
        left:   holeLeft,
        top:    holeTop,
        blend:  'over',
      },
      // Frame sits on top — its mat is opaque (hides shadow outside hole edge),
      // hole is transparent (shows floorplan beneath)
      {
        input:  frameWithHole,
        left:   0,
        top:    0,
        blend:  'over',
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
    return res.status(500).json({ error: 'API key missing' });

  try {
    const { image: imageDataUri } = req.body || {};
    if (!imageDataUri) return res.status(400).json({ error: 'No image provided' });

    const finalPrompt = `
You are an expert architectural drafter. Add furniture outlines to the uploaded floorplan.

STRUCTURAL PRESERVATION (NON-NEGOTIABLE):
Never alter walls, doors, windows, staircases, or room boundaries. Only furniture is added.

WOODEN MODEL STYLE (top-down view, photographed from directly above):
- Floor: warm amber/honey wood (#D4A96A), fine horizontal grain lines
- Walls: dark walnut brown (#5C3317), slightly raised 3D, faint drop shadow
- Furniture: laser-engraved outlines only — thin dark lines (#3D1F0A), ZERO shadow, ZERO 3D depth
- CRITICAL BACKGROUND: solid plain warm off-white #F5F2EE only — NO blue, NO grey gradient, NO vignette, NO shadows on background

FURNITURE:
- Living: sofa vs TV on opposite walls, coffee table centred between
- Bedroom: 1 bed, max 2 bedside tables, optional dresser
- Dining: 1 table, 2–6 chairs
- Kitchen: stove + fridge + sink along walls
- Bathroom: 1 toilet + 1 sink + 1 shower OR bathtub
- Unclear/small rooms: add nothing

CLEANUP: Remove all text, labels, dimensions. Keep walls, doors, windows, stairs, furniture only.
OUTPUT: Image only. No text. Preserve exact aspect ratio. Plain warm off-white background.
`.trim();

    // ── Call Grok ─────────────────────────────────────────────────────────────
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

    // ── Download floorplan ────────────────────────────────────────────────────
    const floorplanResp = await fetch(generatedUrl);
    if (!floorplanResp.ok)
      return res.status(500).json({ error: 'Failed to download floorplan' });
    const floorplanBuffer = Buffer.from(await floorplanResp.arrayBuffer());

    // ── Load frame ────────────────────────────────────────────────────────────
    const framePath = path.join(process.cwd(), 'public', 'Clean_Hausframe_Template.png');
    const frameBuffer = fs.readFileSync(framePath);

    // ── Composite ─────────────────────────────────────────────────────────────
    const finalImage = await buildComposite(frameBuffer, floorplanBuffer);

    res.status(200).json({
      success: true,
      imageUrl: `data:image/png;base64,${finalImage.toString('base64')}`,
    });

  } catch (error) {
    console.error('❌ Crash:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
