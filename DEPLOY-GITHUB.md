# Publishing the dashboard on GitHub Pages / ขั้นตอนเผยแพร่บน GitHub Pages

ผลลัพธ์: ได้ลิงก์ เช่น `https://<ชื่อบัญชี>.github.io/facade-stone-tracker/` ที่ส่งให้ทีมเปิดได้ทันที
ไม่ต้องติดตั้งโปรแกรม ไม่ต้องรู้เรื่องโค้ด

## ⚠️ อ่านก่อน: ใครจะเห็นข้อมูลได้บ้าง

| แผน GitHub | Repository | เว็บไซต์ (Pages) |
|---|---|---|
| Free | ต้องเป็น Public | **ทุกคนที่มีลิงก์เปิดดูได้** และดาวน์โหลดไฟล์ทั้งหมดได้ |
| Pro / Team | เป็น Private ได้ | **เว็บไซต์ยังเปิดให้ทุกคนที่มีลิงก์** |
| Enterprise Cloud | Private | ตั้งให้เฉพาะสมาชิกองค์กรที่ล็อกอินเห็นได้ |

ไฟล์นี้มีแบบ Fab Sheet 1,288 แผ่น ไฟล์ STL 199 ไฟล์ และข้อมูลโมเดลของโครงการ ถ้าข้อมูลเป็นความลับ ให้ขออนุญาตเจ้าของงานก่อน
หรือเลือกทางอื่นในหัวข้อ "ถ้าต้องการจำกัดคนดู" ด้านล่าง

## ขนาดไฟล์ (ตรวจแล้วอยู่ในขีดจำกัดของ GitHub Pages)

| รายการ | ขนาด | ขีดจำกัด |
|---|---|---|
| ทั้งเว็บไซต์ | ประมาณ 416 MB (1,540 ไฟล์: PDF 136 MB, STL 180 MB, โมเดล 80 MB) | เว็บไซต์ไม่เกิน 1 GB, repository แนะนำไม่เกิน 1 GB |
| ไฟล์ใหญ่สุด | 17 MB (`geom/E2201T.bin`), STL ใหญ่สุด 13 MB | ไฟล์ละไม่เกิน 100 MB (อัปโหลดผ่านหน้าเว็บได้ไม่เกิน 25 MB) |
| ผู้ชม 1 คน (ครั้งแรก) | ประมาณ 83 MB (โมเดล + ข้อมูล) ส่วน PDF และ STL โหลดทีละไฟล์เมื่อกดดู | ปริมาณรับส่งข้อมูลประมาณ 100 GB ต่อเดือน (ประมาณ 1,200 ครั้งเปิดแบบเต็ม) |

ห้ามใช้ Git LFS กับไฟล์ในเว็บนี้ เพราะ GitHub Pages ไม่ส่งไฟล์ LFS ให้เบราว์เซอร์

## ขั้นตอน (ครั้งแรก ประมาณ 20 นาที)

1. **สมัคร/ล็อกอิน** ที่ https://github.com
2. **ติดตั้ง GitHub Desktop** จาก https://desktop.github.com แล้วล็อกอินด้วยบัญชีเดียวกัน
   (ใช้ GitHub Desktop เพราะหน้าเว็บของ GitHub อัปโหลดได้ครั้งละไม่เกิน 100 ไฟล์ แต่ชุดนี้มีประมาณ 1,600 ไฟล์)
3. ใน GitHub Desktop: **File → New repository**
   - Name: `facade-stone-tracker`
   - Local path: เลือกโฟลเดอร์ใดก็ได้ เช่น Documents
   - กด **Create repository**
4. เปิดโฟลเดอร์ repository ที่เพิ่งสร้าง (ปุ่ม **Show in Explorer**) แล้ว**คัดลอกไฟล์และโฟลเดอร์ทั้งหมด**ของชุดนี้ลงไป
   รวมโฟลเดอร์ซ่อน `.github` และไฟล์ `.nojekyll` ด้วย (ใน Windows Explorer: View → Show → Hidden items)
5. กลับไปที่ GitHub Desktop จะเห็นรายการไฟล์ที่เปลี่ยน ในช่อง Summary พิมพ์ `Add dashboard` แล้วกด **Commit to main**
6. กด **Publish repository**
   - บัญชี Free: เอาเครื่องหมายถูกที่ "Keep this code private" ออก (Pages ของบัญชี Free ใช้ได้กับ repository แบบ Public เท่านั้น)
   - กด Publish แล้วรอให้อัปโหลดเสร็จ
7. เปิดหน้า repository บน github.com → **Settings → Pages**
   ในหัวข้อ **Build and deployment → Source** เลือก **GitHub Actions**
8. ไปที่แท็บ **Actions** จะเห็นงาน "Publish dashboard" กำลังทำงาน รอประมาณ 2–4 นาทีจนขึ้นเครื่องหมายถูกสีเขียว
   (ถ้ายังไม่เริ่ม ให้กด "Publish dashboard" → **Run workflow**)
9. ลิงก์ของเว็บจะแสดงในหน้า **Settings → Pages** และในผลของงาน Actions
   รูปแบบลิงก์: `https://<ชื่อบัญชี>.github.io/facade-stone-tracker/`

## อัปเดต Fab Sheet หรือไฟล์ STL (ไม่ต้องใช้โปรแกรมอะไร)

1. ตั้งชื่อไฟล์ให้ตรงกับเลข Ticket เช่น `AC-005.pdf` หรือ `18T-001.stl`
   (หรือใช้ปุ่ม **Import** บนเว็บ แท็บ *Fab Sheets* หรือ *STL files* เพื่อตรวจชื่อ ตรวจว่าไฟล์ไม่เสีย และดูผลในเบราว์เซอร์ก่อน
   แล้วกด **Download for upload** จะได้ ZIP ของไฟล์ที่เปลี่ยนชื่อถูกต้องแล้ว)
2. บน github.com เปิดโฟลเดอร์ `fab-sheets` (สำหรับ PDF) หรือ `stl` (สำหรับ STL) → **Add file → Upload files** → ลากไฟล์ลงไป → **Commit changes**
   ไฟล์ชื่อเดิมจะถูกแทนที่ และ GitHub เก็บเวอร์ชันเก่าไว้ในประวัติ (History) เสมอ
   (หน้าเว็บ GitHub อัปโหลดได้ครั้งละไม่เกิน 100 ไฟล์ ไฟล์ละไม่เกิน 25 MB ถ้ามากกว่านั้นให้ใช้ GitHub Desktop)
3. รอ 2–4 นาทีให้งาน Actions เสร็จ แล้วกดรีเฟรชหน้าเว็บ

## อัปเดตโมเดล IFC (ไม่ต้องใช้ Excel)

1. เปิดเว็บ → ปุ่ม **Import** → แท็บ **IFC model** → เลือกไฟล์ `.ifc` หรือ `.zip`
   (ต้องใช้คอมพิวเตอร์ที่มีหน่วยความจำ 8 GB ขึ้นไป ไฟล์ 1.4 GB ใช้เวลาหลายนาที ไฟล์ไม่ถูกส่งออกไปที่ไหน)
2. อ่านสรุปการเปลี่ยนแปลง (จำนวนหิน Ticket ที่เพิ่ม/หาย ค่าที่เปลี่ยน) แล้วกด **Replace the current model** เพื่อตรวจในเบราว์เซอร์
3. กด **Download the model update (for GitHub)** จะได้ไฟล์ `model-update-for-upload.zip`
4. แตก ZIP แล้วคัดลอกโฟลเดอร์ `data` และ `geom` ทับในโฟลเดอร์ repository (ใน GitHub Desktop) แล้วกด **Commit to main** และ **Push origin**
   (ไฟล์ใน `geom` ใหญ่ถึง 17 MB ใช้ GitHub Desktop สะดวกกว่าหน้าเว็บ)
5. รอ 2–4 นาทีให้งาน Actions เสร็จ ระบบจะจับคู่ PDF/STL กับ Ticket ใหม่ให้เอง

หรือรัน `python tools/build_all.py --ifc <ไฟล์ IFC หรือ ZIP>` บนเครื่องที่มี Python (ดู README) ผลเหมือนกัน

## ถ้าต้องการจำกัดคนดู

- **GitHub Enterprise Cloud:** ทำตามขั้นตอนเดิม แล้วตั้งค่า Pages เป็น Private (ดู "Changing the visibility of your GitHub Pages site")
- **ใช้ภายในสำนักงาน:** รัน `python server.py --host 0.0.0.0` บนเครื่องหนึ่งในเครือข่ายบริษัท แล้วให้ทีมเปิด `http://<IP เครื่องนั้น>:8080/`
  (มีปุ่ม Import ที่บันทึกไฟล์ให้ทุกคนเห็น แต่ไม่มีระบบล็อกอิน จึงห้ามเปิดออกอินเทอร์เน็ต)
- **บริการเว็บแบบมีล็อกอิน** เช่น Azure Static Web Apps หรือ Cloudflare Pages + Cloudflare Access:
  อัปโหลดเฉพาะ `index.html` และโฟลเดอร์ `assets data geom fab-sheets stl vendor` ได้เหมือนกัน เพราะเป็นเว็บแบบ static
