// api/generate.js
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { prompt = "Make this look like a premium, professional product mockup with clean lighting" } = req.body;
    let imageDataUri = req.body.image; // base64 data URI sent from frontend

    if (!imageDataUri) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const response = await fetch('https://api.x.ai/v1/images/edits', {
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

    const data = await response.json();

    if (!response.ok) {
      console.error(data);
      return res.status(500).json({ error: data.error || 'Grok API error' });
    }

    const generatedUrl = data.data[0].url;
    res.status(200).json({ success: true, imageUrl: generatedUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong' });
  }
}
