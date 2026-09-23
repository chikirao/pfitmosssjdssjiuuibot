// Генерирует секреты для .dev.vars / wrangler secret put.
import { randomBytes } from "node:crypto";

console.log(`WEBHOOK_SECRET=${randomBytes(32).toString("hex")}`);
console.log(`TOKEN_ENC_KEY=${randomBytes(32).toString("base64")}`);
