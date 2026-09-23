import { GoogleAuth } from 'google-auth-library';
import dotenv from 'dotenv';
dotenv.config();

const modelsToTest = [
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro',
    'gemini-2.5-flash'
];

async function testModels() {
    const auth = new GoogleAuth({
        keyFilename: 'trim-bot-486500-h8-4b614b18f7c0.json',
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    const location = 'us-central1';
    const projectId = process.env.VERTEX_PROJECT_ID || 'trim-bot-486500-h8';

    for (const modelName of modelsToTest) {
        console.log(`Testing model: ${modelName}...`);
        const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelName}:generateContent`;
        
        const payload = {
            contents: [{ role: "user", parts: [{ text: "مرحبا" }] }],
            generationConfig: { maxOutputTokens: 10 }
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken.token}`
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                console.log(`✅ Success! Model ${modelName} is working.`);
            } else {
                const err = await response.text();
                console.log(`❌ Failed! Model ${modelName} returned status ${response.status}: ${err}`);
            }
        } catch (error) {
            console.log(`❌ Error connecting to model ${modelName}:`, error.message);
        }
        await new Promise(r => setTimeout(r, 2000)); // 2 second delay to avoid rate limits
    }
}

testModels();
