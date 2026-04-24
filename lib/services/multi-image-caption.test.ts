import assert from "node:assert/strict";

// @ts-ignore Node strip-types runner resolves the .ts module directly in tests.
import { sanitizeMultiImageCaption } from "./multi-image-caption.ts";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("ลบ duplicate intro block ได้", () => {
  const input = `ยังไม่มีไอเดียใช่มั้ย? 💅 รวม 4 สไตล์เล็บติดตามาให้แล้ว

📌 1 แบบ 1 — สีเล็บแดงมุก เงาแพง ดูสุภาพ
📌 2 แบบ 2 — ฟ้าเทาอ่อนมุก ประดับคริสตัล

🌟 แบบ 1 : เล็บสีแดงมุก เงางามวาว ดูหรูหรา
✨ แบบ 2 : โทนฟ้าเทาอ่อนมุก เรียบหรู ประดับคริสตัล
🌺 แบบ 3 : เล็บยาวโทนฟ้าใส เรียบหรู
💖 แบบ 4 : ทูโทนฟ้า น้ำตาล มุกเงา

#ไอเดียเล็บหลายแบบ #nailinspo #เล็บสวยๆ`;

  const output = sanitizeMultiImageCaption(input);

  assert.equal(output.includes("📌 1 แบบ 1"), false);
  assert.equal(output.includes("📌 2 แบบ 2"), false);
});

run("ยังเหลือรายการหลักแบบ 1 - 4", () => {
  const input = `เปิดโพสต์

📌 1 แบบ 1 — ซ้ำ

🌟 แบบ 1 : A
✨ แบบ 2 : B
🌺 แบบ 3 : C
💖 แบบ 4 : D`;

  const output = sanitizeMultiImageCaption(input);

  assert.equal(output.includes("แบบ 1 : A"), true);
  assert.equal(output.includes("แบบ 2 : B"), true);
  assert.equal(output.includes("แบบ 3 : C"), true);
  assert.equal(output.includes("แบบ 4 : D"), true);
});

run("ยังเหลือข้อความเปิดโพสต์", () => {
  const input = `ยังไม่มีไอเดียใช่มั้ย? 💅
ลองเลือกแบบที่ชอบที่สุดก่อน

1 แบบ 1 — ซ้ำ

🌟 แบบ 1 : A
✨ แบบ 2 : B`;

  const output = sanitizeMultiImageCaption(input);

  assert.equal(output.startsWith("ยังไม่มีไอเดียใช่มั้ย? 💅"), true);
  assert.equal(output.includes("ลองเลือกแบบที่ชอบที่สุดก่อน"), true);
});

run("ยังเหลือ hashtag", () => {
  const input = `เปิดโพสต์

แบบ 1 — ซ้ำ

🌟 แบบ 1 : A
✨ แบบ 2 : B

#tag1 #tag2`;

  const output = sanitizeMultiImageCaption(input);

  assert.equal(output.includes("#tag1 #tag2"), true);
});

run("ถ้าไม่มี duplicate block ไม่ควรแก้ caption", () => {
  const input = `ยังไม่มีไอเดียใช่มั้ย? 💅

🌟 แบบ 1 : เล็บสีแดงมุก
✨ แบบ 2 : โทนฟ้าเทาอ่อนมุก
🌺 แบบ 3 : เล็บยาวโทนฟ้าใส
💖 แบบ 4 : ทูโทนฟ้า น้ำตาล มุกเงา

#ไอเดียเล็บหลายแบบ #nailinspo`;

  const output = sanitizeMultiImageCaption(input);

  assert.equal(output, input.trim());
});

run("ไม่กระทบ single-image mode", () => {
  const input = `โพสต์ภาพเดี่ยวแนวมินิมอล
อ่านง่าย สั้นกระชับ
#single`;

  const output = sanitizeMultiImageCaption(input);

  assert.equal(output, input.trim());
});
