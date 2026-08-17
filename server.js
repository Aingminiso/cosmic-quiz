/**
 * COSMIC QUIZ · LAN — Backend Server
 * ----------------------------------
 * Plain Node.js + Express, in-memory state (no database needed).
 * Implements every endpoint the frontend (public/index.html) calls:
 *
 *   POST /api/rooms                          create room, become host
 *   POST /api/rooms/:code/join                join an existing room
 *   GET  /api/rooms/:code/state?playerId=..   poll full game state (called every 700ms)
 *   POST /api/rooms/:code/heartbeat           keep-alive ping
 *   POST /api/rooms/:code/ready               toggle ready in lobby
 *   POST /api/rooms/:code/addbot              host adds an AI bot player
 *   POST /api/rooms/:code/start               host starts the match
 *   POST /api/rooms/:code/answer              submit an answer to the current question
 *
 * Design notes
 * ------------
 * There is no per-room setInterval/game loop. Instead, the current phase
 * (lobby -> question -> reveal -> ... -> end) is *computed on demand* from
 * `Date.now() - room.gameStartAt`, using fixed per-question timing:
 *
 *      [ 0s ................ QUESTION_TIME s ][ ... REVEAL_TIME s ]
 *      |------------- question -------------|------- reveal -------|
 *
 * This means every client polling /state gets a perfectly consistent view
 * of time remaining with zero drift, and the server needs no background
 * timers at all — which also makes bot-answering and score-finalization
 * trivially idempotent (see `ensureQuestionResolved`).
 */

const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

/* ============================== CONSTANTS ============================== */

const QUESTION_TIME = 10;         // seconds — MUST match QUESTION_TIME in index.html
const REVEAL_TIME = 5;            // seconds shown on the reveal screen
const TOTAL_PER_Q = QUESTION_TIME + REVEAL_TIME;
const MAX_QUESTIONS = 20;         // cap per match even if the bank is bigger
const MAX_PLAYERS = 12;
const ROOM_IDLE_MS = 30 * 60 * 1000; // reap rooms idle for 30 minutes

const DIFF_POINTS = { easy: 100, medium: 200, hard: 300 };
const DIFF_LABEL  = { easy: 'ง่าย', medium: 'ปานกลาง', hard: 'ยาก' };

const ALLOWED_AVATARS = ["👨‍🚀","👩‍🚀","🧑‍🚀","👽","🛸","🌠"];
const BOT_AVATARS = ["🤖","👽","🛸"];
const BOT_NAMES = [
  "บอทจันทรา","ไซบอร์ก-7","กัปตันเอไอ","หุ่นดาวหาง","เนบิวลาบอท",
  "ดวงจันทร์เทียม","วอยเอเจอร์-X","สกายเน็ตจูเนียร์","แอนดรอยด์อวกาศ","เอเลี่ยนบอท"
];

/* ============================ QUESTION BANK ============================= */
/* cat / diff / text / options[4] / correctIndex                            */

const BANK = [
  // ---- easy ----
  { cat:"🪐 ระบบสุริยะ", diff:"easy", text:"ดาวเคราะห์ดวงใดอยู่ใกล้ดวงอาทิตย์ที่สุด", options:["ดาวศุกร์","ดาวพุธ","โลก","ดาวอังคาร"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"easy", text:"ดาวเคราะห์ดวงใดใหญ่ที่สุดในระบบสุริยะ", options:["ดาวเสาร์","ดาวยูเรนัส","ดาวพฤหัสบดี","โลก"], correctIndex:2 },
  { cat:"🪐 ระบบสุริยะ", diff:"easy", text:"โลกโคจรรอบดวงอาทิตย์ครบ 1 รอบ ใช้เวลาประมาณกี่วัน", options:["30 วัน","365 วัน","100 วัน","500 วัน"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"easy", text:"ดวงอาทิตย์จัดเป็นวัตถุประเภทใด", options:["ดาวเคราะห์","ดาวฤกษ์","ดาวหาง","ดาวบริวาร"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"easy", text:"ดาวเคราะห์ดวงใดได้ชื่อว่า 'ดาวแดง'", options:["ดาวศุกร์","ดาวอังคาร","ดาวพุธ","ดาวเนปจูน"], correctIndex:1 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"easy", text:"ปรากฏการณ์ที่ดวงจันทร์บังดวงอาทิตย์เรียกว่าอะไร", options:["จันทรุปราคา","สุริยุปราคา","ฝนดาวตก","ออโรรา"], correctIndex:1 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"easy", text:"มนุษย์คนแรกที่เหยียบดวงจันทร์คือใคร", options:["บัซ อัลดริน","นีล อาร์มสตรอง","ยูริ กาการิน","จอห์น เกล็นน์"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"easy", text:"ดวงจันทร์เป็นบริวารของดาวเคราะห์ดวงใด", options:["ดาวอังคาร","โลก","ดาวศุกร์","ดาวพุธ"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"easy", text:"กาแล็กซีที่โลกของเราอยู่มีชื่อว่าอะไร", options:["แอนดรอเมดา","ทางช้างเผือก","ไทรแองกูลัม","โซมเบรโร"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"easy", text:"ระบบสุริยะมีดาวเคราะห์ทั้งหมดกี่ดวง (ตามนิยามปัจจุบัน)", options:["7","8","9","10"], correctIndex:1 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"easy", text:"องค์กรอวกาศของสหรัฐอเมริกาชื่อย่อว่าอะไร", options:["ESA","NASA","JAXA","ROSCOSMOS"], correctIndex:1 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"easy", text:"ดาวตกเกิดจากอะไร", options:["ดาวฤกษ์ระเบิด","เศษหินอวกาศเสียดสีกับบรรยากาศโลก","ดวงจันทร์แตก","แสงเลเซอร์"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"easy", text:"ดาวเคราะห์ดวงใดมีวงแหวนที่โดดเด่นที่สุด", options:["ดาวพฤหัสบดี","ดาวเสาร์","ดาวยูเรนัส","ดาวเนปจูน"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"easy", text:"ดาวฤกษ์ที่อยู่ใกล้โลกที่สุด (นอกจากดวงอาทิตย์) คือดาวใด", options:["ดาวซิริอุส","พร็อกซิมา เซนทอรี","ดาวเวก้า","ดาวเบเทลจุส"], correctIndex:1 },

  // ---- medium ----
  { cat:"🪐 ระบบสุริยะ", diff:"medium", text:"ดาวเคราะห์ดวงใดหมุนรอบตัวเองในทิศทางตรงข้ามกับดาวเคราะห์ส่วนใหญ่", options:["ดาวอังคาร","ดาวศุกร์","ดาวพฤหัสบดี","โลก"], correctIndex:1 },
  { cat:"🌌 จักรวาลวิทยา", diff:"medium", text:"ทฤษฎีที่อธิบายจุดกำเนิดของจักรวาลว่าเริ่มจากการระเบิดครั้งใหญ่เรียกว่าอะไร", options:["Big Crunch","Big Bang","Steady State","Inflation Theory"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"medium", text:"หลุมดำเกิดจากอะไร", options:["ดาวฤกษ์ขนาดใหญ่ยุบตัวหลังหมดเชื้อเพลิง","ดาวเคราะห์ชนกัน","การระเบิดของดาวหาง","แสงรวมตัวกัน"], correctIndex:0 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"medium", text:"ยานอวกาศลำแรกที่ออกจากระบบสุริยะสำเร็จคือยานใด", options:["Voyager 1","Apollo 11","Cassini","New Horizons"], correctIndex:0 },
  { cat:"🪐 ระบบสุริยะ", diff:"medium", text:"ดาวเคราะห์แคระที่มีชื่อเสียงที่สุด (เดิมเคยถูกนับเป็นดาวเคราะห์ดวงที่ 9) คือดวงใด", options:["Eris","Ceres","Pluto","Haumea"], correctIndex:2 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"medium", text:"แสงออโรรา (แสงเหนือ-ใต้) เกิดจากอนุภาคจากดวงอาทิตย์ปะทะกับสิ่งใดของโลก", options:["เปลือกโลก","สนามแม่เหล็กและบรรยากาศ","มหาสมุทร","แกนโลก"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"medium", text:"หน่วยวัดระยะทางในอวกาศ 'ปีแสง' ใช้วัดอะไร", options:["เวลา","ระยะทางที่แสงเดินทางได้ใน 1 ปี","ความสว่างของดาว","อุณหภูมิดาว"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"medium", text:"ดาวเคราะห์ดวงใดมีอุณหภูมิพื้นผิวสูงที่สุดในระบบสุริยะ", options:["ดาวพุธ","ดาวศุกร์","ดาวอังคาร","ดาวพฤหัสบดี"], correctIndex:1 },
  { cat:"🌌 จักรวาลวิทยา", diff:"medium", text:"นักวิทยาศาสตร์ค้นพบว่าจักรวาลกำลังทำอะไร", options:["หดตัวลง","ขยายตัวออก","หยุดนิ่ง","หมุนกลับทิศ"], correctIndex:1 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"medium", text:"สถานีอวกาศนานาชาติมีชื่อย่อว่าอะไร", options:["ISS","MIR","SKY","ESA"], correctIndex:0 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"medium", text:"ดาวฤกษ์ผลิตพลังงานจากกระบวนการใด", options:["ปฏิกิริยาเคมี","ปฏิกิริยานิวเคลียร์ฟิวชัน","แรงโน้มถ่วง","การเผาไหม้ก๊าซ"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"medium", text:"แถบดาวเคราะห์น้อยส่วนใหญ่อยู่ระหว่างดาวเคราะห์ดวงใด", options:["โลกกับดาวอังคาร","ดาวอังคารกับดาวพฤหัสบดี","ดาวพฤหัสบดีกับดาวเสาร์","ดาวเสาร์กับดาวยูเรนัส"], correctIndex:1 },

  // ---- hard ----
  { cat:"🌌 จักรวาลวิทยา", diff:"hard", text:"รังสีพื้นหลังที่หลงเหลือจากบิ๊กแบงเรียกว่าอะไร", options:["Cosmic Microwave Background","Solar Wind","Hawking Radiation","Gamma Ray Burst"], correctIndex:0 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"hard", text:"ดาวฤกษ์มวลมากเมื่อสิ้นอายุขัยมักระเบิดเป็นปรากฏการณ์ใด", options:["โนวา","ซูเปอร์โนวา","พัลซาร์","ควาซาร์"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"hard", text:"ความเร็วหลุดพ้น (escape velocity) จากพื้นผิวโลก มีค่าประมาณกี่กิโลเมตรต่อวินาที", options:["7.9 km/s","11.2 km/s","15.0 km/s","24.1 km/s"], correctIndex:1 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"hard", text:"กล้องโทรทรรศน์อวกาศเจมส์ เว็บบ์ (JWST) สังเกตการณ์ด้วยแสงชนิดใดเป็นหลัก", options:["แสงอัลตราไวโอเลต","แสงอินฟราเรด","รังสีเอกซ์","คลื่นวิทยุ"], correctIndex:1 },
  { cat:"🌌 จักรวาลวิทยา", diff:"hard", text:"สสารชนิดใดที่คาดว่ามีอยู่ในจักรวาลปริมาณมากแต่ตรวจจับไม่ได้ด้วยแสง", options:["สสารมืด","ปฏิสสาร","พลาสมา","ไอออน"], correctIndex:0 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"hard", text:"ควาซาร์ (Quasar) คือวัตถุประเภทใด", options:["ดาวเคราะห์นอกระบบ","แกนกลางกาแล็กซีที่มีหลุมดำมวลยิ่งยวดสว่างจ้า","ดาวหางขนาดใหญ่","ดาวฤกษ์เกิดใหม่"], correctIndex:1 },

  /* ========================= +50 ADDITIONAL QUESTIONS ========================= */

  // ---- 🪐 ระบบสุริยะ ----
  { cat:"🪐 ระบบสุริยะ", diff:"easy", text:"ดาวเคราะห์ดวงใดอยู่ไกลดวงอาทิตย์ที่สุด", options:["ดาวยูเรนัส","ดาวเนปจูน","ดาวพลูโต","ดาวเสาร์"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"easy", text:"ดาวเคราะห์ดวงใดมีขนาดเล็กที่สุดในระบบสุริยะ", options:["ดาวอังคาร","ดาวพุธ","ดาวศุกร์","โลก"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"easy", text:"ดวงจันทร์ของโลกใช้เวลาโคจรรอบโลกประมาณกี่วัน", options:["7 วัน","14 วัน","27 วัน","60 วัน"], correctIndex:2 },
  { cat:"🪐 ระบบสุริยะ", diff:"easy", text:"ดาวศุกร์มีดวงจันทร์บริวารกี่ดวง", options:["0","1","2","4"], correctIndex:0 },
  { cat:"🪐 ระบบสุริยะ", diff:"medium", text:"ดาวเคราะห์ดวงใดในระบบสุริยะที่หมุนรอบตัวเองครบ 1 วันใช้เวลานานกว่าโคจรรอบดวงอาทิตย์ครบ 1 ปี", options:["โลก","ดาวศุกร์","ดาวอังคาร","ดาวพฤหัสบดี"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"medium", text:"ระนาบสมมติที่ดาวเคราะห์ส่วนใหญ่โคจรรอบดวงอาทิตย์อยู่บนระนาบใกล้เคียงกันเรียกว่าอะไร", options:["Ecliptic","Equator","Meridian","Horizon"], correctIndex:0 },
  { cat:"🪐 ระบบสุริยะ", diff:"medium", text:"ดาวเคราะห์ดวงใดมีความหนาแน่นเฉลี่ยต่ำที่สุดในระบบสุริยะ (เบาจนลอยน้ำได้ถ้ามีอ่างน้ำใหญ่พอ)", options:["ดาวพฤหัสบดี","ดาวเสาร์","ดาวยูเรนัส","ดาวเนปจูน"], correctIndex:1 },
  { cat:"🪐 ระบบสุริยะ", diff:"medium", text:"ดาวอังคารมีดวงจันทร์บริวารกี่ดวง", options:["0","1","2","4"], correctIndex:2 },
  { cat:"🪐 ระบบสุริยะ", diff:"hard", text:"คาบการโคจรของดาวพลูโตรอบดวงอาทิตย์ใช้เวลาประมาณกี่ปี", options:["84 ปี","165 ปี","248 ปี","365 ปี"], correctIndex:2 },
  { cat:"🪐 ระบบสุริยะ", diff:"hard", text:"จุดที่ดาวเคราะห์อยู่ใกล้ดวงอาทิตย์ที่สุดในวงโคจรเรียกว่าอะไร", options:["Aphelion","Perihelion","Apogee","Perigee"], correctIndex:1 },

  // ---- ⭐ ดวงดาว & กาแล็กซี ----
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"easy", text:"ดาวฤกษ์ส่วนใหญ่ประกอบด้วยธาตุใดเป็นหลัก", options:["ออกซิเจน","ไฮโดรเจน","คาร์บอน","เหล็ก"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"easy", text:"สีของดาวฤกษ์บอกอะไรเกี่ยวกับดาวดวงนั้นเป็นหลัก", options:["ระยะห่างจากโลก","อุณหภูมิพื้นผิว","อายุขัยที่แน่นอน","ขนาดเสมอ"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"easy", text:"กลุ่มดาวที่คนไทยเรียกว่า 'ดาวไถ' ในสากลเรียกว่ากลุ่มดาวอะไร", options:["Ursa Major","Orion","Scorpius","Cygnus"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"easy", text:"กาแล็กซี (ดาราจักร) คืออะไร", options:["กลุ่มเมฆก๊าซเดี่ยวๆ","กลุ่มดาวฤกษ์ ก๊าซ และฝุ่นจำนวนมหาศาลที่ยึดเหนี่ยวด้วยแรงโน้มถ่วง","ดาวเคราะห์น้อยกลุ่มใหญ่","ดาวหางกลุ่มหนึ่ง"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"medium", text:"กาแล็กซีที่อยู่ใกล้ทางช้างเผือกมากที่สุดและกำลังจะโคจรเข้าชนกันในอนาคตคือกาแล็กซีใด", options:["ไทรแองกูลัม","แอนดรอเมดา","โซมเบรโร","วังน้ำวน"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"medium", text:"พัลซาร์ (Pulsar) คือดาวประเภทใด", options:["ดาวยักษ์แดง","ดาวนิวตรอนที่หมุนเร็วและปล่อยคลื่นวิทยุเป็นจังหวะ","ดาวแคระขาว","ดาวฤกษ์เกิดใหม่"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"medium", text:"ดาวฤกษ์ที่มีมวลมากกว่าดวงอาทิตย์มากๆ มักมีอายุขัยเป็นอย่างไรเมื่อเทียบกับดาวฤกษ์มวลน้อย", options:["ยาวกว่ามาก","สั้นกว่ามาก","เท่ากันเสมอ","ไม่มีความสัมพันธ์กัน"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"medium", text:"กระจุกดาวทรงกลม (Globular Cluster) มักพบอยู่บริเวณใดของกาแล็กซี", options:["ใจกลางกาแล็กซี","แขนกังหันของกาแล็กซี","รอบนอกและฮาโลของกาแล็กซี","ในระบบสุริยะ"], correctIndex:2 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"hard", text:"แผนภาพที่ใช้จำแนกดาวฤกษ์ตามอุณหภูมิและความสว่างเรียกว่าอะไร", options:["Doppler Diagram","Hertzsprung-Russell Diagram","Hubble Diagram","Drake Diagram"], correctIndex:1 },
  { cat:"⭐ ดวงดาว & กาแล็กซี", diff:"hard", text:"ดาวแคระขาว (White Dwarf) เกิดจากซากของดาวฤกษ์ประเภทใด", options:["ดาวฤกษ์มวลมากพิเศษหลังซูเปอร์โนวา","ดาวฤกษ์มวลต่ำถึงปานกลางหลังหมดเชื้อเพลิง","ดาวนิวตรอนที่เย็นตัวลง","หลุมดำที่ระเหยไป"], correctIndex:1 },

  // ---- ☄️ ปรากฏการณ์ท้องฟ้า ----
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"easy", text:"ฝนดาวตกที่มีชื่อเสียงในช่วงเดือนสิงหาคมของทุกปีชื่อว่าอะไร", options:["ลีโอนิดส์","เจมินิดส์","เพอร์เซอิดส์","ควอดแรนติดส์"], correctIndex:2 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"easy", text:"จันทรุปราคาเกิดขึ้นเมื่อวัตถุใดบังแสงอาทิตย์ที่ส่องไปยังดวงจันทร์", options:["ดวงอาทิตย์เอง","โลก","ดาวอังคาร","เมฆ"], correctIndex:1 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"easy", text:"ดวงจันทร์เต็มดวงที่ดูใหญ่และสว่างกว่าปกติเพราะโคจรใกล้โลกที่สุดเรียกว่าอะไร", options:["Blue Moon","Super Moon","Blood Moon","Harvest Moon"], correctIndex:1 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"easy", text:"หางของดาวหางจะชี้ไปทิศทางใดเสมอเมื่อเข้าใกล้ดวงอาทิตย์", options:["ชี้เข้าหาดวงอาทิตย์","ชี้ออกจากดวงอาทิตย์เสมอ","ชี้ไปทางโลกเสมอ","ไม่มีทิศทางแน่นอน"], correctIndex:1 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"medium", text:"ปรากฏการณ์ 'ดวงจันทร์สีเลือด' (Blood Moon) เกิดขึ้นระหว่างปรากฏการณ์ใด", options:["สุริยุปราคาเต็มดวง","จันทรุปราคาเต็มดวง","ฝนดาวตก","ดาวเคียงเดือน"], correctIndex:1 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"medium", text:"เหตุใดดวงจันทร์ในช่วงจันทรุปราคาเต็มดวงจึงมักปรากฏเป็นสีแดง", options:["สะท้อนแสงจากดาวอังคาร","แสงอาทิตย์หักเหผ่านชั้นบรรยากาศโลกแล้วไปตกกระทบดวงจันทร์","ฝุ่นอวกาศบดบัง","มลพิษบนดวงจันทร์"], correctIndex:1 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"medium", text:"เมื่อสังเกตด้วยตาเปล่า ดาวเคราะห์ต่างจากดาวฤกษ์อย่างไร", options:["ดาวเคราะห์กะพริบแสง ส่วนดาวฤกษ์แสงนิ่ง","ดาวเคราะห์แสงนิ่งกว่า ส่วนดาวฤกษ์มักกะพริบแสง","ทั้งสองแบบเหมือนกันทุกประการ","ดาวเคราะห์มองไม่เห็นด้วยตาเปล่า"], correctIndex:1 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"medium", text:"ปรากฏการณ์ที่ดาวเคราะห์ดวงหนึ่งโคจรมาอยู่ในตำแหน่งตรงข้ามกับดวงอาทิตย์พอดี (โดยมีโลกอยู่ระหว่างกลาง) เรียกว่าอะไร", options:["Conjunction","Opposition","Transit","Occultation"], correctIndex:1 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"hard", text:"สุริยุปราคาแบบวงแหวน (Annular Eclipse) เกิดขึ้นเมื่อใด", options:["ดวงจันทร์อยู่ใกล้โลกที่สุดขณะบัง","ดวงจันทร์อยู่ไกลโลกจนบังดวงอาทิตย์ไม่มิด เหลือขอบเป็นวงแหวน","โลกอยู่ไกลดวงอาทิตย์ที่สุด","เกิดเฉพาะฤดูหนาวเท่านั้น"], correctIndex:1 },
  { cat:"☄️ ปรากฏการณ์ท้องฟ้า", diff:"hard", text:"ปรากฏการณ์ออโรราบนโลกจะพบเห็นได้ชัดเจนที่สุดบริเวณใด", options:["เส้นศูนย์สูตร","เขตร้อน","บริเวณละติจูดสูงใกล้ขั้วโลก","ทะเลทราย"], correctIndex:2 },

  // ---- 🚀 การสำรวจอวกาศ ----
  { cat:"🚀 การสำรวจอวกาศ", diff:"easy", text:"ยานอวกาศลำแรกที่ถูกส่งขึ้นสู่วงโคจรของโลกชื่อว่าอะไร", options:["อพอลโล 11","สปุตนิก 1","วอยเอเจอร์ 1","ฮับเบิล"], correctIndex:1 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"easy", text:"ภารกิจใดที่พามนุษย์ไปเหยียบดวงจันทร์เป็นครั้งแรก", options:["อพอลโล 8","อพอลโล 11","อพอลโล 13","เจมินี 4"], correctIndex:1 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"easy", text:"สุนัขตัวแรกที่ถูกส่งขึ้นสู่อวกาศชื่อว่าอะไร", options:["ไลก้า","บัดดี้","แฮม","สโนว์ปี้"], correctIndex:0 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"easy", text:"กล้องโทรทรรศน์อวกาศชื่อดังที่โคจรรอบโลกมานานกว่า 30 ปีชื่อว่าอะไร", options:["กล้องเจมส์ เว็บบ์","กล้องฮับเบิล","กล้องเคปเลอร์","กล้องสปิตเซอร์"], correctIndex:1 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"medium", text:"บริษัทเอกชนที่พัฒนาจรวด Falcon 9 และยาน Dragon คือบริษัทใด", options:["Blue Origin","SpaceX","Virgin Galactic","Boeing"], correctIndex:1 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"medium", text:"ยานสำรวจของ NASA ที่ลงจอดและปฏิบัติภารกิจสำรวจพื้นผิวดาวอังคารชื่อว่าอะไร", options:["Curiosity","Sputnik","Voyager","Apollo"], correctIndex:0 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"medium", text:"ภารกิจ Artemis ขององค์การ NASA มีเป้าหมายหลักคืออะไร", options:["สำรวจดาวอังคาร","พามนุษย์กลับไปเยือนดวงจันทร์อีกครั้ง","ส่งกล้องโทรทรรศน์ใหม่ขึ้นวงโคจร","สำรวจดาวศุกร์"], correctIndex:1 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"medium", text:"นักบินอวกาศหญิงคนแรกของโลกชื่อว่าอะไร", options:["เพ็กกี้ วิตสัน","วาเลนตินา เตเรชโควา","แซลลี ไรด์","เมย์ เจมิสัน"], correctIndex:1 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"hard", text:"ยานอวกาศ Voyager 1 และ 2 ถูกปล่อยขึ้นสู่อวกาศในปีใด", options:["1969","1977","1986","1990"], correctIndex:1 },
  { cat:"🚀 การสำรวจอวกาศ", diff:"hard", text:"สถานีอวกาศเมียร์ (Mir) เป็นสถานีอวกาศของประเทศ/กลุ่มประเทศใด", options:["สหรัฐอเมริกา","สหภาพโซเวียต","จีน","สหภาพยุโรป"], correctIndex:1 },

  // ---- 🌌 จักรวาลวิทยา ----
  { cat:"🌌 จักรวาลวิทยา", diff:"easy", text:"เอกภพ (Universe) หมายถึงอะไร", options:["เฉพาะระบบสุริยะของเรา","ทุกสิ่งที่มีอยู่ ทั้งสสาร พลังงาน อวกาศ และเวลา","เฉพาะกาแล็กซีทางช้างเผือก","กลุ่มดาวฤกษ์กลุ่มหนึ่ง"], correctIndex:1 },
  { cat:"🌌 จักรวาลวิทยา", diff:"easy", text:"นักวิทยาศาสตร์ประมาณว่าเอกภพมีอายุประมาณกี่พันล้านปี", options:["4.6 พันล้านปี","13.8 พันล้านปี","100 พันล้านปี","1 พันล้านปี"], correctIndex:1 },
  { cat:"🌌 จักรวาลวิทยา", diff:"easy", text:"คำว่า 'หลุมดำ' (Black Hole) มาจากคุณสมบัติใดของมัน", options:["มีสีดำสนิทมองเห็นง่าย","มีแรงโน้มถ่วงสูงมากจนแม้แต่แสงก็หนีออกไม่ได้","เป็นหลุมในอวกาศที่ว่างเปล่าสนิท","เป็นดาวเคราะห์สีดำ"], correctIndex:1 },
  { cat:"🌌 จักรวาลวิทยา", diff:"easy", text:"กาแล็กซีทางช้างเผือกของเรามีรูปร่างแบบใด", options:["กาแล็กซีรี","กาแล็กซีกังหัน","กาแล็กซีไร้รูปแบบ","กาแล็กซีทรงกลม"], correctIndex:1 },
  { cat:"🌌 จักรวาลวิทยา", diff:"medium", text:"แรงพื้นฐานใดมีบทบาทสำคัญที่สุดในการยึดเหนี่ยวโครงสร้างขนาดใหญ่ของเอกภพ เช่น กาแล็กซี", options:["แรงแม่เหล็กไฟฟ้า","แรงโน้มถ่วง","แรงนิวเคลียร์อย่างเข้ม","แรงนิวเคลียร์อย่างอ่อน"], correctIndex:1 },
  { cat:"🌌 จักรวาลวิทยา", diff:"medium", text:"พลังงานลึกลับที่เชื่อว่าเป็นสาเหตุให้เอกภพขยายตัวเร็วขึ้นเรื่อยๆ เรียกว่าอะไร", options:["พลังงานมืด","สสารมืด","รังสีคอสมิก","พลังงานฟิวชัน"], correctIndex:0 },
  { cat:"🌌 จักรวาลวิทยา", diff:"medium", text:"กฎของฮับเบิล (Hubble's Law) อธิบายความสัมพันธ์ระหว่างสิ่งใด", options:["มวลกับแรงโน้มถ่วงของดาว","ระยะห่างของกาแล็กซีกับความเร็วที่มันเคลื่อนที่ออกจากเรา","อุณหภูมิกับสีของดาวฤกษ์","ขนาดกับความสว่างของดาว"], correctIndex:1 },
  { cat:"🌌 จักรวาลวิทยา", diff:"medium", text:"ทฤษฎีใดอธิบายว่าเอกภพในช่วงเสี้ยววินาทีแรกหลังบิ๊กแบงมีการขยายตัวอย่างรวดเร็วมาก", options:["ทฤษฎีสัมพัทธภาพทั่วไป","ทฤษฎีการพองตัว (Inflation Theory)","ทฤษฎีสตริง","กฎแรงโน้มถ่วงของนิวตัน"], correctIndex:1 },
  { cat:"🌌 จักรวาลวิทยา", diff:"hard", text:"นักวิทยาศาสตร์ผู้เสนอทฤษฎีสัมพัทธภาพทั่วไป ซึ่งเป็นพื้นฐานสำคัญของจักรวาลวิทยาสมัยใหม่คือใคร", options:["ไอแซก นิวตัน","อัลเบิร์ต ไอน์สไตน์","สตีเฟน ฮอว์คิง","เอ็ดวิน ฮับเบิล"], correctIndex:1 },
  { cat:"🌌 จักรวาลวิทยา", diff:"hard", text:"สสารปกติ (ที่ไม่ใช่สสารมืดหรือพลังงานมืด) คิดเป็นสัดส่วนโดยประมาณเท่าใดของมวล-พลังงานทั้งหมดในเอกภพ", options:["ประมาณ 5%","ประมาณ 27%","ประมาณ 68%","ประมาณ 95%"], correctIndex:0 },
];

/* ============================ IN-MEMORY STATE ============================ */

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function makeRoomCode() {
  let code;
  do {
    code = 'COSMIC-' + String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Returns a copy of question `q` with its 4 options shuffled into a random
 * order (and correctIndex remapped to match), so the correct answer isn't
 * predictably in the same slot every time this question is drawn.
 */
function shuffleQuestionOptions(q) {
  const order = shuffle([0, 1, 2, 3]);
  return {
    ...q,
    options: order.map(i => q.options[i]),
    correctIndex: order.indexOf(q.correctIndex),
  };
}

function sanitizeName(n) {
  let s = String(n || '').trim().slice(0, 12);
  if (!s) s = 'นักบิน' + Math.floor(Math.random() * 1000);
  return s;
}

function sanitizeAvatar(a) {
  return ALLOWED_AVATARS.includes(a) ? a : ALLOWED_AVATARS[0];
}

function makePlayer({ id, name, avatar, isHost, isBot }) {
  return {
    id, name, avatar, isHost: !!isHost, isBot: !!isBot,
    ready: !!isBot, // bots are always ready
    score: 0,
    streak: 0,
    maxCombo: 0,
    correctCount: 0,
    totalAnswered: 0,
    sumTime: 0,
    catCorrect: {},
    lastSeen: Date.now(),
  };
}

/* =============================== GAME LOGIC =============================== */

function comboMultiplier(streak) {
  if (streak >= 5) return 2;
  if (streak >= 3) return 1.5;
  if (streak >= 2) return 1.2;
  return 1;
}

/**
 * Derive the room's current phase purely from elapsed wall-clock time.
 * Returns one of:
 *   { phase:'lobby' }
 *   { phase:'question', qi, timeLeft }
 *   { phase:'reveal', qi, revealTimeLeft }
 *   { phase:'end' }
 */
function getComputedPhase(room) {
  if (!room.started) return { phase: 'lobby' };
  const totalQ = room.questions.length;
  const elapsedSec = (Date.now() - room.gameStartAt) / 1000;
  const qi = Math.floor(elapsedSec / TOTAL_PER_Q);
  if (qi >= totalQ) return { phase: 'end' };
  const within = elapsedSec - qi * TOTAL_PER_Q;
  if (within < QUESTION_TIME) {
    return { phase: 'question', qi, timeLeft: QUESTION_TIME - within };
  }
  return { phase: 'reveal', qi, revealTimeLeft: TOTAL_PER_Q - within };
}

/**
 * Records one player's answer + applies scoring. Idempotent per (qi, playerId).
 * Returns true if it actually recorded something new.
 */
function recordAnswer(room, qi, player, optionIndex, timeTaken) {
  if (!room.answers[qi]) room.answers[qi] = {};
  if (room.answers[qi][player.id]) return false;

  const q = room.questions[qi];
  const correct = optionIndex === q.correctIndex;
  const base = DIFF_POINTS[q.diff];
  let bonus = 0, mult = 1, gain = 0;

  if (correct) {
    const remaining = Math.max(0, QUESTION_TIME - timeTaken);
    bonus = Math.round(base * 0.5 * remaining / QUESTION_TIME);
    player.streak = (player.streak || 0) + 1;
    mult = comboMultiplier(player.streak);
    gain = Math.round((base + bonus) * mult);
    player.correctCount = (player.correctCount || 0) + 1;
    player.maxCombo = Math.max(player.maxCombo || 0, player.streak);
    player.catCorrect = player.catCorrect || {};
    player.catCorrect[q.cat] = (player.catCorrect[q.cat] || 0) + 1;
  } else {
    player.streak = 0;
  }

  player.score = (player.score || 0) + gain;
  player.totalAnswered = (player.totalAnswered || 0) + 1;
  player.sumTime = (player.sumTime || 0) + timeTaken;

  room.answers[qi][player.id] = { optionIndex, correct, base, bonus, mult, gain, timeTaken };
  return true;
}

/**
 * Makes sure every player has an answer recorded for question `qi`.
 * - Bots always get resolved immediately (they "decide" as soon as we look).
 * - Humans are only auto-marked as timed-out (-1) when `resolveHumans` is true,
 *   i.e. once the question phase for `qi` has actually ended.
 * Safe to call repeatedly — already-answered players are skipped.
 */
function ensureQuestionResolved(room, qi, resolveHumans) {
  if (!room.answers[qi]) room.answers[qi] = {};
  const q = room.questions[qi];
  for (const p of room.players) {
    if (room.answers[qi][p.id]) continue;
    if (p.isBot) {
      const correctChance = q.diff === 'easy' ? 0.85 : q.diff === 'medium' ? 0.65 : 0.45;
      const willBeCorrect = Math.random() < correctChance;
      let optionIndex;
      if (willBeCorrect) {
        optionIndex = q.correctIndex;
      } else {
        const wrongs = [0, 1, 2, 3].filter(i => i !== q.correctIndex);
        optionIndex = wrongs[Math.floor(Math.random() * wrongs.length)];
      }
      const timeTaken = Math.min(QUESTION_TIME, +(1.5 + Math.random() * 6).toFixed(2));
      recordAnswer(room, qi, p, optionIndex, timeTaken);
    } else if (resolveHumans) {
      recordAnswer(room, qi, p, -1, QUESTION_TIME);
    }
  }
}

function playersView(room) {
  return room.players.map(p => ({
    id: p.id, name: p.name, avatar: p.avatar,
    isHost: !!p.isHost, isBot: !!p.isBot, ready: !!p.ready,
  }));
}

/* ================================ ROUTES ================================= */

app.post('/api/rooms', (req, res) => {
  const name = sanitizeName(req.body.name);
  const avatar = sanitizeAvatar(req.body.avatar);
  const code = makeRoomCode();
  const playerId = makeId();
  const host = makePlayer({ id: playerId, name, avatar, isHost: true, isBot: false });

  rooms.set(code, {
    code,
    players: [host],
    started: false,
    gameStartAt: null,
    questions: [],
    answers: {},
    createdAt: Date.now(),
  });

  res.json({ roomCode: code, playerId });
});

app.post('/api/rooms/:code/join', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
  if (room.started) return res.status(400).json({ error: 'ALREADY_STARTED' });
  if (room.players.length >= MAX_PLAYERS) return res.status(400).json({ error: 'ROOM_FULL' });

  const name = sanitizeName(req.body.name);
  const avatar = sanitizeAvatar(req.body.avatar);
  const playerId = makeId();
  room.players.push(makePlayer({ id: playerId, name, avatar, isHost: false, isBot: false }));

  res.json({ playerId });
});

app.post('/api/rooms/:code/heartbeat', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
  const player = room.players.find(p => p.id === req.body.playerId);
  if (player) player.lastSeen = Date.now();
  res.json({ ok: true });
});

app.post('/api/rooms/:code/ready', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
  if (room.started) return res.status(400).json({ error: 'ALREADY_STARTED' });
  const player = room.players.find(p => p.id === req.body.playerId);
  if (!player) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  player.ready = !!req.body.ready;
  res.json({ ok: true });
});

app.post('/api/rooms/:code/addbot', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
  if (room.started) return res.status(400).json({ error: 'ALREADY_STARTED' });
  if (room.players.length >= MAX_PLAYERS) return res.status(400).json({ error: 'ROOM_FULL' });

  const usedNames = new Set(room.players.map(p => p.name));
  const pool = BOT_NAMES.filter(n => !usedNames.has(n));
  const name = pool.length ? pool[Math.floor(Math.random() * pool.length)] : ('บอท' + Math.floor(Math.random() * 1000));
  const avatar = BOT_AVATARS[Math.floor(Math.random() * BOT_AVATARS.length)];
  const id = makeId();
  room.players.push(makePlayer({ id, name, avatar, isHost: false, isBot: true }));

  res.json({ ok: true, playerId: id });
});

app.post('/api/rooms/:code/start', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
  const player = room.players.find(p => p.id === req.body.playerId);
  if (!player) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  if (!player.isHost) return res.status(403).json({ error: 'NOT_HOST' });
  if (room.started) return res.status(400).json({ error: 'ALREADY_STARTED' });
  if (room.players.length < 1) return res.status(400).json({ error: 'NOT_ENOUGH_PLAYERS' });
  if (!room.players.every(p => p.ready)) return res.status(400).json({ error: 'NOT_ALL_READY' });

  const count = Math.min(MAX_QUESTIONS, BANK.length);
  room.questions = shuffle(BANK).slice(0, count).map(shuffleQuestionOptions);
  room.answers = {};
  room.started = true;
  room.gameStartAt = Date.now();

  res.json({ ok: true });
});

app.post('/api/rooms/:code/answer', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
  const player = room.players.find(p => p.id === req.body.playerId);
  if (!player) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });

  const computed = getComputedPhase(room);
  if (computed.phase !== 'question') return res.status(400).json({ error: 'NOT_QUESTION_PHASE' });

  const qIndex = Number(req.body.qIndex);
  if (qIndex !== computed.qi) return res.status(400).json({ error: 'STALE_QUESTION' });

  const optionIndex = Number(req.body.optionIndex);
  const timeTaken = Math.min(QUESTION_TIME, Math.max(0, QUESTION_TIME - computed.timeLeft));
  recordAnswer(room, computed.qi, player, optionIndex, timeTaken);

  res.json({ ok: true });
});

app.get('/api/rooms/:code/state', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
  const player = room.players.find(p => p.id === req.query.playerId);
  if (!player) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  player.lastSeen = Date.now();

  const computed = getComputedPhase(room);

  // ---- LOBBY ----
  if (computed.phase === 'lobby') {
    return res.json({
      phase: 'lobby',
      roomCode: room.code,
      you: { id: player.id, isHost: !!player.isHost, ready: !!player.ready, name: player.name, avatar: player.avatar },
      players: playersView(room),
    });
  }

  // ---- QUESTION ----
  if (computed.phase === 'question') {
    for (let i = 0; i < computed.qi; i++) ensureQuestionResolved(room, i, true); // finalize any past questions
    ensureQuestionResolved(room, computed.qi, false); // bots answer now, humans still pending

    const q = room.questions[computed.qi];
    const answeredCount = Object.keys(room.answers[computed.qi] || {}).length;

    return res.json({
      phase: 'question',
      roomCode: room.code,
      you: { id: player.id, isHost: !!player.isHost },
      players: playersView(room),
      question: {
        index: computed.qi,
        total: room.questions.length,
        cat: q.cat,
        diff: q.diff,
        diffLabel: DIFF_LABEL[q.diff],
        text: q.text,
        options: q.options,
      },
      timeLeft: computed.timeLeft,
      answeredCount,
    });
  }

  // ---- REVEAL ----
  if (computed.phase === 'reveal') {
    for (let i = 0; i <= computed.qi; i++) ensureQuestionResolved(room, i, true);

    const q = room.questions[computed.qi];
    const mine = room.answers[computed.qi][player.id];
    const leaderboard = room.players.slice()
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 5)
      .map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score || 0 }));

    return res.json({
      phase: 'reveal',
      roomCode: room.code,
      question: { index: computed.qi, total: room.questions.length, diffLabel: DIFF_LABEL[q.diff] },
      revealTimeLeft: computed.revealTimeLeft,
      reveal: {
        isLast: computed.qi === room.questions.length - 1,
        correctIndex: q.correctIndex,
        correctText: q.options[q.correctIndex],
        yourAnswerIndex: mine.optionIndex,
        yourCorrect: mine.correct,
        yourBreakdown: { base: mine.base, bonus: mine.bonus, mult: mine.mult, total: mine.gain },
        yourGain: mine.gain,
      },
      leaderboard,
    });
  }

  // ---- END ----
  for (let i = 0; i < room.questions.length; i++) ensureQuestionResolved(room, i, true);

  const sorted = room.players.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  let bestCat = '-';
  if (player.catCorrect) {
    const entries = Object.entries(player.catCorrect);
    if (entries.length) {
      entries.sort((a, b) => b[1] - a[1]);
      bestCat = entries[0][0];
    }
  }
  const avgTime = player.totalAnswered ? (player.sumTime / player.totalAnswered).toFixed(1) : '0.0';

  return res.json({
    phase: 'end',
    roomCode: room.code,
    end: {
      players: sorted.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score || 0 })),
      yourStats: {
        correctCount: player.correctCount || 0,
        total: room.questions.length,
        avgTime,
        maxCombo: player.maxCombo || 0,
        bestCat,
      },
    },
  });
});

// SPA fallback (so refreshing on "/?room=COSMIC-1234" still serves the app)
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ============================= ROOM CLEANUP ============================== */

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const humans = room.players.filter(p => !p.isBot);
    const allStale = humans.length === 0 || humans.every(p => now - p.lastSeen > ROOM_IDLE_MS);
    if (allStale && now - room.createdAt > ROOM_IDLE_MS) {
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

/* ================================ START ================================= */

function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('🌌 COSMIC QUIZ server running');
  console.log(`   Local:        http://localhost:${PORT}`);
  for (const ip of getLanIPs()) {
    console.log(`   LAN:          http://${ip}:${PORT}`);
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    console.log(`   Public URL:   ${process.env.RENDER_EXTERNAL_URL}`);
  }
  console.log('   Share whichever URL applies with your players.');
});
