// api/generate.js
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

// ── Remove chroma-key green background, leaving only the wooden model ─────────
async function removeBackground(floorplanBuffer) {
  const { data, info } = await sharp(floorplanBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const ch = 4;

  for (let i = 0; i < width * height * ch; i += ch) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // Detect chroma-key green: high G, low R and B
    if (g > 150 && r < 120 && b < 120) {
      data[i + 3] = 0; // fully transparent
    }
    // Also catch near-white/cream pixels that bleed at edges
    else if (r > 220 && g > 210 && b > 190) {
      data[i + 3] = 0;
    }
  }

  return sharp(Buffer.from(data), {
    raw: { width, height, channels: 4 },
  }).png().toBuffer();
}

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

  // ── 5. Remove green background from floorplan — transparent cutout ─────────
  const cutoutFloorplan = await removeBackground(floorplanBuffer);

  // ── 6. Scale the cutout to fit within the hole (contain, not cover) ────────
  //    We use 'contain' so the model doesn't get cropped — it floats
  //    on the mat just like in the reference photo
  const scaledFloorplan = await sharp(cutoutFloorplan)
    .resize(holeW, holeH, {
      fit: 'contain',
      position: 'centre',
      background: { r: 0, g: 0, b: 0, alpha: 0 }, // transparent padding
    })
    .png()
    .toBuffer();

  // ── 7. Cast shadow from the wooden model onto the mat ─────────────────────
  //    Create a blurred dark version of the cutout, offset bottom-right
  const shadowOffsetX = 12;
  const shadowOffsetY = 18;
  const shadowBlur    = 16;

  // Darken all visible pixels of the cutout to create a shadow shape
  const { data: cutoutData, info: cutoutInfo } = await sharp(scaledFloorplan)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const shadowData = Buffer.from(cutoutData);
  for (let i = 0; i < cutoutInfo.width * cutoutInfo.height * 4; i += 4) {
    shadowData[i]     = 20;   // R — dark warm shadow colour
    shadowData[i + 1] = 14;   // G
    shadowData[i + 2] = 8;    // B
    // Keep alpha from the cutout — shadow only where the model is
    shadowData[i + 3] = Math.round(cutoutData[i + 3] * 0.55);
  }

  const castShadow = await sharp(shadowData, {
    raw: { width: cutoutInfo.width, height: cutoutInfo.height, channels: 4 },
  })
    .blur(shadowBlur)
    .png()
    .toBuffer();

  // ── 8. Sample mat colour from the frame ───────────────────────────────────
  const sampleY   = Math.max(0, holeTop - 20);
  const sampleX   = holeLeft + Math.floor(holeW / 2);
  const sampleIdx = (sampleY * frameW + sampleX) * ch;
  const matR      = frameData[sampleIdx]     || 248;
  const matG      = frameData[sampleIdx + 1] || 246;
  const matB      = frameData[sampleIdx + 2] || 244;

  // ── 9. Composite — bottom to top ──────────────────────────────────────────
  //    [mat background] → [cast shadow] → [wooden model cutout] → [frame]
  const result = await sharp({
    create: {
      width:    frameW,
      height:   frameH,
      channels: 4,
      background: { r: matR, g: matG, b: matB, alpha: 1 },
    },
  })
    .composite([
      // Shadow on mat, offset bottom-right
      {
        input: castShadow,
        left:  Math.min(frameW - holeW, holeLeft + shadowOffsetX),
        top:   Math.min(frameH - holeH, holeTop  + shadowOffsetY),
        blend: 'multiply',
      },
      // Wooden model (transparent background — sits directly on white mat)
      {
        input: scaledFloorplan,
        left:  holeLeft,
        top:   holeTop,
        blend: 'over',
      },
      // Frame on top — mat is opaque, hole is transparent
      {
        input: frameWithHole,
        left:  0,
        top:   0,
        blend: 'over',
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

WOODEN MODEL STYLE (top-down, photographed from directly above):
- Floor: warm amber/honey wood (#D4A96A), fine horizontal grain lines
- Walls: dark walnut brown (#5C3317), slightly raised 3D, faint drop shadow on floors only
- Furniture: laser-engraved outlines only — thin dark lines (#3D1F0A), ZERO shadow, ZERO 3D depth

BACKGROUND — CRITICAL:
The entire background (every pixel outside the floorplan walls) MUST be filled with solid pure chroma-key green #00FF00.
No white. No cream. No grey. No gradient. Pure flat #00FF00 everywhere outside the floor plan boundary.
This is essential for post-processing.

FURNITURE:
- Living: sofa vs TV on opposite walls, coffee table centred between
- Bedroom: 1 bed, max 2 bedside tables, optional dresser
- Dining: 1 table, 2–6 chairs
- Kitchen: stove + fridge + sink along walls
- Bathroom: 1 toilet + 1 sink + 1 shower OR bathtub
- Unclear/small rooms: add nothing

CLEANUP: Remove all text, labels, dimensions. Keep walls, doors, windows, stairs, furniture only.
OUTPUT: Image only. No text. Exact aspect ratio. Pure green #00FF00 background.
`.trim();

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

    const floorplanResp = await fetch(generatedUrl);
    if (!floorplanResp.ok)
      return res.status(500).json({ error: 'Failed to download floorplan' });
    const floorplanBuffer = Buffer.from(await floorplanResp.arrayBuffer());

    const framePath = path.join(process.cwd(), 'public', 'Clean_Hausframe_Template.png');
    const frameBuffer = fs.readFileSync(framePath);

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
