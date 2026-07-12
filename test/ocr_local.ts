import { runReceiptOcr, isConfigured } from "../lib/ocr.js";
import fs from "fs";

console.log("configured:", isConfigured());
const b64 = fs.readFileSync("public/test-receipt.png").toString("base64");
const r = await runReceiptOcr({ dataBase64: b64, format: "png" });
console.log("amount:", r.amount);
console.log("merchant:", r.merchant);
console.log("raw:", JSON.stringify(r.raw).slice(0, 300));
