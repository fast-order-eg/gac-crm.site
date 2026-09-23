import { CONFIG } from './config.js';
import { GoogleAuth } from 'google-auth-library';

const modelsToTest = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-001",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-2.5-pro-001"
];

async function testAllModels() {
    console.log("==========================================");
    console.log("🧪 اختبار نماذج الجيل 2.5 المتاحة في Vertex AI...");
    console.log(`Project ID: ${CONFIG.PROJECT_ID}`);
    console.log("==========================================\n");

    const auth = new GoogleAuth({
        keyFilename: CONFIG.GOOGLE_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || 'project-c1442437-41e2-480c-86d-0935778ac612.json',
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    for (const modelName of modelsToTest) {
        process.stdout.write(`⏳ جاري اختبار الموديل: [ ${modelName} ] ... `);
        const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/locations/us-central1/publishers/google/models/${modelName}:generateContent`;

        const payload = {
            contents: [{ role: "user", parts: [{ text: "أهلا بك، هل أنت تعمل بكفاءة؟ رد بكلمتين باللغة العربية." }] }],
            generationConfig: {
                temperature: 0.5,
                maxOutputTokens: 100,
            }
        };

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken.token}`
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errText = await res.text();
                let errMsg = `Error ${res.status}`;
                try {
                    const errJson = JSON.parse(errText);
                    errMsg = errJson.error?.message || errMsg;
                } catch (e) {}
                console.log(`❌ فشل (${errMsg})`);
            } else {
                const data = await res.json();
                const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "بدون نص";
                console.log(`✅ شغال بنجاح! الرد: "${reply}"`);
            }
        } catch (error) {
            console.log(`❌ خطأ في الاتصال: ${error.message}`);
        }
    }
    console.log("\n==========================================");
    console.log("🏁 انتهى الاختبار!");
    console.log("==========================================");
}

testAllModels();
