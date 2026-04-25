// api/generate.js
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

async function buildComposite(frameBuffer, floorplanBuffer) {

  // ── 1. Read frame ───────────────────────────────────────────────
  const { data: frameData, info } = await sharp(frameBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: frameW, height: frameH } = info;
  const ch = 4;

  // ── 2. Detect red rectangle ─────────────────────────────────────
  let minX = frameW, minY = frameH, maxX = 0, maxY = 0, found = false;

  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameW; x++) {
      const i = (y * frameW + x) * ch;
      const r = frameData[i], g = frameData[i + 1], b = frameData[i + 2];

      if (r > 180 && g < 80 && b < 80) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        found = true;
      }
    }
  }

  if (!found) throw new Error('Red rectangle not found');

  // ── 3. Expand hole ──────────────────────────────────────────────
  const expand = 4;
  const holeLeft   = Math.max(0, minX - expand);
  const holeTop    = Math.max(0, minY - expand);
  const holeRight  = Math.min(frameW - 1, maxX + expand);
  const holeBottom = Math.min(frameH - 1, maxY + expand);
  const holeW      = holeRight - holeLeft;
  const holeH      = holeBottom - holeTop;

  // ── 4. Cut hole ─────────────────────────────────────────────────
  for (let y = holeTop; y <= holeBottom; y++) {
    for (let x = holeLeft; x <= holeRight; x++) {
      const i = (y * frameW + x) * ch;
      frameData[i + 3] = 0;
    }
  }

  const frameWithHole = await sharp(Buffer.from(frameData), {
    raw: { width: frameW, height: frameH, channels: 4 },
  }).png().toBuffer();

  // ── 5. Resize floorplan ─────────────────────────────────────────
  const resizedFloorplan = await sharp(floorplanBuffer)
    .resize(holeW, holeH, { fit: 'cover' })
    .png()
    .toBuffer();

  // ── 6. Inner shadow (improved) ──────────────────────────────────
  const shadowDepth = 40;
  const shadowData = Buffer.alloc(holeW * holeH * 4, 0);

  for (let y = 0; y < holeH; y++) {
    for (let x = 0; x < holeW; x++) {
      const i = (y * holeW + x) * 4;

      const distX = Math.min(x, holeW - x);
      const distY = Math.min(y, holeH - y);
      const dist = Math.min(distX, distY);

      if (dist < shadowDepth) {
        const strength = Math.pow(1 - dist / shadowDepth, 2.5);

        shadowData[i]     = 20;
        shadowData[i + 1] = 15;
        shadowData[i + 2] = 10;
        shadowData[i + 3] = Math.round(strength * 220);
      }
    }
  }

  const innerShadow = await sharp(shadowData, {
    raw: { width: holeW, height: holeH, channels: 4 },
  }).png().toBuffer();

  // ── 7. Directional lighting ─────────────────────────────────────
  const lightData = Buffer.alloc(holeW * holeH * 4, 0);

  for (let y = 0; y < holeH; y++) {
    for (let x = 0; x < holeW; x++) {
      const i = (y * holeW + x) * 4;

      const lightFactor = 1 - ((x / holeW) * 0.4 + (y / holeH) * 0.6);
      const value = Math.round(255 * lightFactor * 0.12);

      lightData[i] = value;
      lightData[i + 1] = value;
      lightData[i + 2] = value;
      lightData[i + 3] = 80;
    }
  }

  const lightingOverlay = await sharp(lightData, {
    raw: { width: holeW, height: holeH, channels: 4 },
  }).png().toBuffer();

  // ── 8. Floor thickness (fake depth) ─────────────────────────────
  const depthOffset = 6;

  const floorShadow = await sharp(resizedFloorplan)
    .tint({ r: 80, g: 60, b: 40 })
    .blur(2)
    .png()
    .toBuffer();

  // ── 9. Contact shadow ───────────────────────────────────────────
  const contactShadow = await sharp(resizedFloorplan)
    .removeAlpha()
    .flatten({ background: '#000' })
    .blur(8)
    .modulate({ brightness: 0.4 })
    .png()
    .toBuffer();

  // ── 10. Subtle noise ────────────────────────────────────────────
  const noise = await sharp({
    create: {
      width: holeW,
      height: holeH,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .noise({ type: 'gaussian', mean: 128, sigma: 10 })
    .png()
    .toBuffer();

  // ── 11. Sample mat color ────────────────────────────────────────
  const sampleIdx = ((holeTop - 10) * frameW + ((holeLeft + holeW / 2) | 0)) * ch;

  const matR = frameData[sampleIdx] || 245;
  const matG = frameData[sampleIdx + 1] || 243;
  const matB = frameData[sampleIdx + 2] || 240;

  // ── 12. Final composite ─────────────────────────────────────────
  const result = await sharp({
    create: {
      width: frameW,
      height: frameH,
      channels: 4,
      background: { r: matR, g: matG, b: matB, alpha: 1 },
    },
  })
    .composite([
      // Contact shadow
      {
        input: contactShadow,
        left: holeLeft + 4,
        top: holeTop + 6,
        blend: 'multiply',
      },

      // Floor depth
      {
        input: floorShadow,
        left: holeLeft + depthOffset,
        top: holeTop + depthOffset,
        blend: 'multiply',
      },

      // Floorplan
      {
        input: resizedFloorplan,
        left: holeLeft,
        top: holeTop,
      },

      // Lighting
      {
        input: lightingOverlay,
        left: holeLeft,
        top: holeTop,
        blend: 'soft-light',
      },

      // Inner shadow
      {
        input: innerShadow,
        left: holeLeft,
        top: holeTop,
        blend: 'multiply',
      },

      // Noise
      {
        input: noise,
        left: holeLeft,
        top: holeTop,
        blend: 'overlay',
        opacity: 0.08,
      },

      // Frame
      {
        input: frameWithHole,
        left: 0,
        top: 0,
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

  try {
    const { image: imageDataUri } = req.body || {};
    if (!imageDataUri) return res.status(400).json({ error: 'No image provided' });

    const grokResponse = await fetch('https://api.x.ai/v1/images/edits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-imagine-image',
        prompt: "Add furniture to this floorplan. Keep structure unchanged.",
        image: { url: imageDataUri, type: 'image_url' },
      }),
    });

    const grokData = await grokResponse.json();
    const generatedUrl = grokData.data?.[0]?.url;

    const floorplanBuffer = Buffer.from(await (await fetch(generatedUrl)).arrayBuffer());

    const framePath = path.join(process.cwd(), 'public', 'Clean_Hausframe_Template.png');
    const frameBuffer = fs.readFileSync(framePath);

    const finalImage = await buildComposite(frameBuffer, floorplanBuffer);

    res.status(200).json({
      success: true,
      imageUrl: `data:image/png;base64,${finalImage.toString('base64')}`,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
