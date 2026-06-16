/**
 * HausFrames – V2 Pipeline Test
 * File: api/generate-v2-test.js
 *
 * NEW PIPELINE (test only, does not touch existing routes):
 *   1. Customer upload → Sharp B&W → Potrace → SVG   (source of truth for Phanlong)
 *   2. SVG → PNG render → GPT-image-2 (add furniture outlines)
 *   3. Furniture PNG → GPT-image-2 (apply wooden render)
 *
 * Returns ALL intermediate outputs so you can evaluate each step visually.
 *
 * BEFORE RUNNING — install two new packages:
 *   npm install potrace @resvg/resvg-js
 *
 * TEST ENDPOINT: POST /api/generate-v2-test
 * Same request body as your existing routes: { image: "data:image/png;base64,..." }
 *
 * Response shape:
 * {
 *   step1_bwUrl:        string,  // Sharp B&W PNG   → check walls are clean black
 *   step1_svgUrl:       string,  // Potrace SVG     → send this to Phanlong
 *   step2_furnitureUrl: string,  // GPT furniture   → check layout makes sense
 *   step3_woodenUrl:    string,  // GPT wooden render → what customer sees
 *   originalUrl:        string,  // customer's original upload
 * }
 */

import sharp from 'sharp';
import potrace from 'potrace';
import { Resvg } from '@resvg/resvg-js';
import { v2 as cloudinary } from 'cloudinary';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── CLOUDINARY HELPERS ───────────────────────────────────────────────────────

function uploadBufferToCloudinary(buffer, folder, filename) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `hausframes/v2-test/${folder}`,
        public_id: filename,
        format: 'png',
        resource_type: 'image',
        overwrite: true,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

function uploadSvgToCloudinary(svgString, filename) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.from(svgString, 'utf8');
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'hausframes/v2-test/svg',
        public_id: filename,
        resource_type: 'raw',   // SVG must be uploaded as raw, not image
        overwrite: true,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// ─── STEP 1A: Sharp B&W conversion ───────────────────────────────────────────
// Deterministic pixel-level conversion. No AI, no interpretation.
// threshold(140): pixels darker than 140 → pure black, lighter → pure white.
// Tweak threshold between 100–160 depending on your customers' input quality:
//   - Clean PDF exports: 140 works well
//   - Greyscale scans:   try 110–120

async function convertToBW(imageDataUri) {
  const base64Data = imageDataUri.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  return await sharp(buffer)
    .grayscale()
    .normalise()          // stretch contrast so faint walls become fully black
    .threshold(140)       // hard black/white — no grey, perfect for Potrace
    .png()
    .toBuffer();
}

// ─── STEP 1B: Potrace → SVG ───────────────────────────────────────────────────
// Traces the B&W PNG into a vector SVG.
// These options are tuned for architectural floorplans.

function traceToSvg(bwBuffer) {
  return new Promise((resolve, reject) => {
    potrace.trace(bwBuffer, {
      alphamax:   0.2,         // near-sharp corners (walls, not blobs)
      opticurve:  false,       // keep straight lines as L commands, not beziers
      turdsize:   8,           // suppress noise smaller than 8px² (arrows, hatching)
      turnpolicy: 'minority',  // best for architectural line drawings
      threshold:  128,
    }, (err, svg) => {
      if (err) return reject(err);

      // Post-process: add mm dimensions + stroke for laser cutting
      // Using 200mm as default — Phanlong can scale in his software
      let out = svg
        .replace(/width="\d+"/, 'width="200mm"')
        .replace(/height="\d+"/, 'height="200mm"')
        .replace(/fill="#[^"]*"/g, 'fill="none"')
        .replace(/stroke="none"/, 'stroke="#000000" stroke-width="0.1mm"');

      resolve(out);
    });
  });
}

// ─── STEP 1C: SVG → PNG (for feeding into GPT) ───────────────────────────────
// Resvg is a pure-Wasm SVG renderer — works on Vercel with no native deps.
// Renders the SVG at 1024x1024 so GPT gets enough resolution to work with.

function svgToPng(svgString) {
  // Resvg needs pixel units in the SVG, not mm — create a render copy
  const svgForRender = svgString
    .replace(/width="\d+mm"/, 'width="1024"')
    .replace(/height="\d+mm"/, 'height="1024"')
    // Also restore fill for the render so walls show as black (Resvg renders fill)
    .replace(/fill="none"/g, 'fill="#000000"')
    .replace(/stroke="#000000" stroke-width="0\.1mm"/, 'stroke="none"');

  const resvg = new Resvg(svgForRender, {
    fitTo: { mode: 'width', value: 1024 },
    background: 'white',
  });

  const pngData = resvg.render();
  return pngData.asPng(); // returns a Buffer
}

// ─── STEP 2: GPT-image-2 → Add furniture outlines ────────────────────────────
// Input: PNG of the clean B&W floorplan (walls black, rooms white)
// Output: same floorplan with minimalist furniture line-art added

async function addFurnitureWithGPT(pngBuffer) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');

  // Flatten to white bg (GPT-image-2 requires no transparency)
  const flatBuffer = await sharp(pngBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  const blob = new Blob([flatBuffer], { type: 'image/png' });
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('quality', 'low');
  form.append('image', blob, 'floorplan-bw.png');
  form.append('prompt', FURNITURE_PROMPT);

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenAI API error (step 2)');

  const result = data.data?.[0];
  if (!result) throw new Error('No image returned from OpenAI (step 2)');

  if (result.b64_json) return Buffer.from(result.b64_json, 'base64');
  if (result.url) {
    const resp = await fetch(result.url);
    return Buffer.from(await resp.arrayBuffer());
  }
  throw new Error('Unexpected OpenAI response format (step 2)');
}

// ─── STEP 3: GPT-image-2 → Wooden render ─────────────────────────────────────
// Input: PNG with correct walls + furniture outlines from Step 2
// GPT's job here is ONLY material/style — geometry is already locked in

async function applyWoodenRenderWithGPT(furniturePngBuffer) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');

  const flatBuffer = await sharp(furniturePngBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  const blob = new Blob([flatBuffer], { type: 'image/png' });
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('quality', 'low');
  form.append('image', blob, 'floorplan-furniture.png');
  form.append('prompt', WOODEN_RENDER_PROMPT);

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenAI API error (step 3)');

  const result = data.data?.[0];
  if (!result) throw new Error('No image returned from OpenAI (step 3)');

  if (result.b64_json) return Buffer.from(result.b64_json, 'base64');
  if (result.url) {
    const resp = await fetch(result.url);
    return Buffer.from(await resp.arrayBuffer());
  }
  throw new Error('Unexpected OpenAI response format (step 3)');
}

// ─── PROMPTS ──────────────────────────────────────────────────────────────────

const FURNITURE_PROMPT = `
You are given a black and white architectural floorplan. Black areas are walls. White areas are rooms.

Your task: add minimalist 2D furniture outlines inside the rooms ONLY. Do not modify the walls in any way.

Rules:
- Walls must remain exactly as they are: solid black, same thickness, same position.
- Furniture must be simple flat line-art outlines only. No fills, no shadows, no 3D.
- Use standard room logic: living room gets sofa + coffee table, kitchen gets counters + sink + hob, bedrooms get bed + wardrobe, bathrooms get toilet + shower + vanity.
- All furniture must fit cleanly inside the room boundaries without touching or overlapping walls.
- Keep the background pure white.
- Do not add any text, labels, dimensions, or annotations.
- Output must be black lines on white background, top-down view, no perspective.
`.trim();

const WOODEN_RENDER_PROMPT = `
### ROLE: Professional Architectural Model Maker & Industrial Designer

### STRUCTURAL INTEGRITY (NON-NEGOTIABLE):
- THE UPLOADED IMAGE IS THE ABSOLUTE BLUEPRINT.
- DO NOT move, add, remove, or modify any wall or furniture element.
- Every wall and furniture outline in the input must appear in the output at the exact same position and proportion.

### TASK:
Apply a wooden site model material treatment to the uploaded floorplan image. Translate the existing walls and furniture lines into the wooden material language below. Do not interpret or reinvent the layout.

### CAMERA & VIEWPOINT:
- Strict 90-degree top-down orthographic projection.
- Zero perspective distortion, zero vanishing points.
- Model centered, filling 85% of the frame.

### MATERIAL SPECS:
- BASE: Light birch wood sheet (#F4E5CA) following exact exterior perimeter.
- WALLS (3D): Extruded laser-cut wood blocks (#C6935C), 10mm height, soft ambient occlusion shadows at wall bases only.
- FURNITURE (2D ENGRAVED): Translate all furniture outlines as flat birch wood engravings (#F4E5CA). Zero height, no shadows.

### OUTPUT:
- Remove all original black lines — replace entirely with wooden material treatment.
- White background. No text, no rulers, no props.
- Walls have 3D shadow. Everything else is strictly flat with no shadows.
`.trim();

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { image: imageDataUri } = req.body || {};
    if (!imageDataUri) return res.status(400).json({ error: 'No image provided' });

    const jobId = Date.now().toString(); // unique ID to group this job's files in Cloudinary
    console.log(`[v2-test] Starting job ${jobId}`);

    // ── Upload original ────────────────────────────────────────────────────────
    const base64Data = imageDataUri.replace(/^data:image\/\w+;base64,/, '');
    const originalBuffer = Buffer.from(base64Data, 'base64');
    const originalUrl = await uploadBufferToCloudinary(originalBuffer, 'original', `${jobId}-original`);
    console.log(`[v2-test] ✅ Step 0: original uploaded`);

    // ── Step 1A: Sharp B&W ─────────────────────────────────────────────────────
    const bwBuffer = await convertToBW(imageDataUri);
    const bwUrl = await uploadBufferToCloudinary(bwBuffer, 'bw', `${jobId}-bw`);
    console.log(`[v2-test] ✅ Step 1A: B&W PNG → ${bwUrl}`);

    // ── Step 1B: Potrace → SVG ─────────────────────────────────────────────────
    const svgString = await traceToSvg(bwBuffer);
    const svgUrl = await uploadSvgToCloudinary(svgString, `${jobId}-laser`);
    console.log(`[v2-test] ✅ Step 1B: SVG → ${svgUrl}`);

    // ── Step 1C: SVG → PNG for GPT input ──────────────────────────────────────
    const svgPngBuffer = svgToPng(svgString);
    const svgPngUrl = await uploadBufferToCloudinary(svgPngBuffer, 'svg-render', `${jobId}-svg-render`);
    console.log(`[v2-test] ✅ Step 1C: SVG→PNG render → ${svgPngUrl}`);

    // ── Step 2: Add furniture ──────────────────────────────────────────────────
    const furnitureBuffer = await addFurnitureWithGPT(svgPngBuffer);
    const furnitureUrl = await uploadBufferToCloudinary(furnitureBuffer, 'furniture', `${jobId}-furniture`);
    console.log(`[v2-test] ✅ Step 2: furniture PNG → ${furnitureUrl}`);

    // ── Step 3: Wooden render ──────────────────────────────────────────────────
    const woodenBuffer = await applyWoodenRenderWithGPT(furnitureBuffer);
    const woodenUrl = await uploadBufferToCloudinary(woodenBuffer, 'wooden', `${jobId}-wooden`);
    console.log(`[v2-test] ✅ Step 3: wooden render → ${woodenUrl}`);

    // ── Return all steps for visual inspection ─────────────────────────────────
    return res.status(200).json({
      success: true,
      jobId,
      // Inspect each of these URLs in sequence to validate the pipeline
      step0_originalUrl:  originalUrl,   // what the customer uploaded
      step1a_bwUrl:       bwUrl,         // Sharp B&W — check walls are solid black
      step1b_svgUrl:      svgUrl,        // Potrace SVG — send this to Phanlong
      step1c_svgRenderUrl: svgPngUrl,    // SVG rendered back to PNG — GPT's input
      step2_furnitureUrl: furnitureUrl,  // GPT furniture step — check room logic
      step3_woodenUrl:    woodenUrl,     // final wooden render — what customer sees
    });

  } catch (error) {
    console.error('[v2-test] ❌ Crash:', error);
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
