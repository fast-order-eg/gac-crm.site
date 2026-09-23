import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
   USER_KEY: process.env.VERTEX_USER_KEY || "missing_key",
   PROJECT_ID: process.env.VERTEX_PROJECT_ID || "fast-order-505012",
   MODEL_NAME: process.env.VERTEX_MODEL_NAME || "gemini-3.8-flash",
   LOCATION: process.env.VERTEX_LOCATION || "global",
   GOOGLE_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS || 'fast-order-505012-2adde4c0badf.json',

   getVertexUrl(modelName = null, location = null) {
       const m = modelName || this.MODEL_NAME;
       const loc = location || this.LOCATION;
       if (loc === 'global') {
           return `https://aiplatform.googleapis.com/v1/projects/${this.PROJECT_ID}/locations/global/publishers/google/models/${m}:generateContent`;
       }
       return `https://${loc}-aiplatform.googleapis.com/v1/projects/${this.PROJECT_ID}/locations/${loc}/publishers/google/models/${m}:generateContent`;
   },

   SYSTEM_INSTRUCTIONS: `أنت مساعد ذكي ومهني لتعلم اللغة الألمانية. هدفك مساعدة العملاء والإجابة على استفساراتهم حول دورات اللغة الألمانية باحترافية ودقة وبطريقة تشجعهم على التعلم.
جاوب دائماً باللغة العربية بأسلوب ودود وسهل وبسيط، وشجعهم على التحدث والممارسة باللغة الألمانية باستخدام بعض الكلمات أو العبارات البسيطة مثل (Hallo, Vielen Dank, Tschüss) لتبسيط اللغة وتحفيزهم.`
};

export function getVertexEndpoint(modelName, location) {
    return CONFIG.getVertexUrl(modelName, location);
}
