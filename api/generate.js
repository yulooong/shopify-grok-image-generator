// api/generate.js
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  // === CORS FIX (this is what was blocking you) ===
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

  try {
    const { prompt = "Enhance this image in a vibrant, professional product style", image: imageDataUri } = req.body || {};

    if (!imageDataUri) {
      return res.status(400).json({ error: 'No image provided' });
    }

    console.log('✅ Received image (length:', imageDataUri.length, ')');

    const grokResponse = await fetch('https://api.x.ai/v1/images/edits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-imagine-image",
        prompt: prompt,
        image: {
          url: imageDataUri,
          type: "image_url"
        }
      })
    });

    const data = await grokResponse.json();

    if (!grokResponse.ok) {
      console.error('Grok API error:', data);
      return res.status(500).json({ error: data.error?.message || 'Grok API error' });
    }

    const generatedUrl = data.data[0].url;

    res.status(200).json({ success: true, imageUrl: generatedUrl });
  } catch (error) {
    console.error('Backend error:', error);
    res.status(500).json({ error: 'Something went wrong on the server' });
  }
}
