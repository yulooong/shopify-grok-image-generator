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
    const { prompt, roomDescription } = req.body || {};

    // Build a detailed prompt from what the user described
    const finalPrompt = prompt || 
      `A clean, professional architectural floorplan with furniture added. 
       The furniture should be neatly placed and to scale. 
       Style: top-down 2D floorplan view. 
       ${roomDescription ? 'Room details: ' + roomDescription : ''}`;

    console.log('✅ Sending prompt to Grok Aurora:', finalPrompt);

    const grokResponse = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "aurora",           // ✅ Correct model name
        prompt: finalPrompt,
        n: 1,
        size: "1024x1024"
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
        detail: data  // This shows the full error in your browser console
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
