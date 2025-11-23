import { GoogleGenAI } from "@google/genai";

export default async function handler(req, res) {
  // Handle CORS for Vercel
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Robust API Key check
  const apiKey = (
    process.env.API_KEY || 
    process.env.GOOGLE_API_KEY || 
    process.env.GEMINI_API_KEY || 
    process.env.VITE_API_KEY || 
    process.env.NEXT_PUBLIC_API_KEY || 
    ""
  ).trim();

  if (!apiKey) {
    console.error("CRITICAL: API Key missing in Vercel Environment Variables.");
    return res.status(500).json({ 
      error: 'Server Configuration Error', 
      details: 'API_KEY is missing. If you added it recently, you MUST REDEPLOY the project for changes to apply.' 
    });
  }

  // Handle body parsing
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }
  
  const { text, language } = body || {};
  
  if (!text) {
     return res.status(400).json({ error: 'No text provided' });
  }
  
  try {
    const ai = new GoogleGenAI({ apiKey });
    
    // Construct system instruction
    // Updates:
    // 1. Explicitly forbid patronizing terms ('my child').
    // 2. Stronger command to use Google Search for locations.
    // 3. Instruction to provide a SINGLE, CONSOLIDATED response to prevent "double answers".
    let systemInstruction = "You are Narada, an expert and accurate guide for Tirumala devotees with precise knowledge of temple geography, cottages, rest houses, and facilities. Always start your response with 'Govinda! Govinda!'. When asked about specific locations (e.g., 'nearest Kalyanakatta to Rambagicha-3', 'directions to CRO'), you MUST use Google Search to find the exact location and calculate proximity before answering. Do not guess. Do NOT use patronizing terms like 'my child' or 'son'. Be respectful, direct, and helpful. Provide a single, final, consolidated answer. Do not output your thought process or a preliminary answer followed by a final answer. Do not repeat the greeting 'Govinda! Govinda!' more than once.";
    
    if (language === 'te') systemInstruction += " Reply in Telugu.";
    else if (language === 'hi') systemInstruction += " Reply in Hindi.";
    else if (language === 'ta') systemInstruction += " Reply in Tamil.";
    else if (language === 'kn') systemInstruction += " Reply in Kannada.";
    else systemInstruction += " Reply in English.";

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: text,
      config: {
        systemInstruction,
        temperature: 0.3, 
        maxOutputTokens: 350,
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
        tools: [
            { googleSearch: {} }, 
            { googleMaps: {} }
        ],
      }
    });

    let generatedText = response.text;
    
    if (!generatedText) {
        throw new Error("Empty response from AI model");
    }

    // --- CLEAN UP DUPLICATE ANSWERS ---
    // Sometimes the model outputs: "Govinda! Govinda! [Draft Answer] Govinda! Govinda! [Final Answer]"
    // We clean this up by removing ALL greetings and adding it back ONCE at the start.
    const greeting = "Govinda! Govinda!";
    const greetingRegex = /Govinda!\s*Govinda!/gi;
    
    // 1. Remove all occurrences of the greeting
    let cleanBody = generatedText.replace(greetingRegex, "").trim();
    
    // 2. Add the greeting back exactly once at the top
    generatedText = `${greeting}\n${cleanBody}`;

    // Extract map link if available
    let mapLink = undefined;
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (chunks) {
        const mapChunk = chunks.find(c => c.maps?.uri);
        if (mapChunk) mapLink = mapChunk.maps.uri;
    }

    res.status(200).json({ text: generatedText, mapLink });
  } catch (error) {
    console.error('Narada API Error:', error);
    res.status(500).json({ error: 'Failed to generate response', details: error.message });
  }
}