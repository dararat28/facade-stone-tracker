# Façade Stone Tracker — Vancouver Washington Temple (P23830)

A web dashboard built from the façade **IFC model**. It covers search by ticket, Issue Status,
T-31 hole counts or elevation; stones highlighted in 3D; an Overview page with charts; Fab Sheet
PDFs and STL files linked by ticket number; and import buttons for a new IFC model, STL files
and Fab Sheets.

**The IFC model is the only source of the dashboard's data.** The Excel control workbook is not
read, imported or merged. Changing the Excel file changes nothing on the dashboard.

It is a static website: it runs from **GitHub Pages** (a link anyone can open) or from this
folder on your own computer. Nothing is sent to any online service. The IFC import also
converts the file inside your own browser.

## วิธีใช้ (ภาษาไทย)

- **เปิดผ่านลิงก์:** ทำตาม `DEPLOY-GITHUB.md` ครั้งเดียว แล้วส่งลิงก์ให้ทีม ไม่ต้องติดตั้งอะไร
- **เปิดบนเครื่องตัวเอง:** แตก ZIP แล้วดับเบิลคลิก `start-dashboard.bat` (Windows) หรือ `start-dashboard.command` (Mac) ต้องมี Python 3
- **หน้า Overview:** สรุปภาพรวมเป็นกราฟ กดแท่งกราฟเพื่อไปดูชิ้นหินนั้นในโมเดล
- **ค้นหา:** พิมพ์เลข Ticket, ข้อความ Issue Status (เช่น `glued`), `T31=2` (จำนวนรู T-31-Count),
  `T31-30=3` (T-31(30mm.)-Count), Elevation, GlobalId หรือ Revit ID
- **ปุ่ม Import:** มี 3 แท็บ
  - **IFC model:** แปลงไฟล์ในเบราว์เซอร์และตรวจสอบก่อน แล้วกด *Replace the current model*
  - **STL files:** ไฟล์ต้องชื่อตรงกับเลข Ticket เช่น `18T-001.stl`
  - **Fab Sheets (PDF)**
- **บันทึกให้ทุกคนเห็น:** ถ้าเปิดผ่าน `start-dashboard.bat` ไฟล์ที่ Import จะถูกบันทึกลงเครื่องที่รันเซิร์ฟเวอร์
  ถ้าเปิดผ่าน GitHub Pages ไฟล์จะใช้ได้เฉพาะในเบราว์เซอร์ของคุณ ให้กด *Download* แล้วอัปโหลดขึ้น GitHub ตาม `DEPLOY-GITHUB.md`

## Pages

- **Overview**: KPI cards and charts, all from the IFC:
  - elements by elevation and by phase;
  - Issue Status values;
  - T-31-Count and T-31(30mm.)-Count (stones per holes-per-stone, with hole totals);
  - STL and Fab Sheet availability (each phase has its own colour in the phase chart);
  - which IFC properties are filled in.
  Clicking a bar or a card opens the Model page with that filter applied.
- **Model**:
  - **KPIs:** IFC elements, unique tickets, elements with Issue Status, T-31 hole totals (and the number of stones they are on), tickets with a Fab Sheet, and STL files for STL-status tickets.
  - **Filters:** phase (P1–P8; the Revit workset `P8-New` counts as P8, and the original value is still shown), Issue Status (any / none / group / exact IFC value), T-31 counts, files, finish and checks.
  - **3D:** click a stone to select it; Ctrl- or Shift-click adds stones. Drag orbits, right-drag pans and the wheel zooms.
  - **Properties panel:**
    - Issue Status exactly as written in the IFC, and both T-31 counts per stone. A missing value is shown as "not in IFC", never as 0.
    - Quantities: *Selected IFC elements* (1 / 1 for one stone), the ticket, the ticket on this elevation, the elevation total and the model total.
    - IFC dimensions, element identity and every IFC property set.
  - **Fab Sheet tab:** the ticket's PDF, loaded only when you open it.
  - **Preview STL:** opens the ticket's STL file in its own 3D viewer (orbit, pan, zoom, fit, views). It is not placed in the IFC model.
  - **Data quality tab:**
    - missing Fab Sheets, STL files expected but missing, STL files without an STL Issue Status, tickets with mixed Issue Status;
    - invalid T-31 values, and T-31 counts without a T-31 Issue Status;
    - suspect dimensions, repaired placements and isolated stones.

Project rule used for STL: a ticket whose IFC Issue Status mentions "STL" is cut from
`stl/<TICKET>.stl`. The Issue Status groups (STL file / Pin & glued / T-31 / T-31 (30 mm stone) /
Other) are derived from the text for filtering only. The IFC text is always shown as it is.

## Files linked by ticket number

```
fab-sheets/<TICKET>.pdf      Fab Sheets (extra sheets <TICKET>__2.pdf)
stl/<TICKET>.stl             STL files (binary or ASCII)
data/pdf_index.json, data/stl_index.json    rebuilt by server.py, by GitHub Actions and by
                             python tools/library.py index
```

The dashboard also looks for `<folder>/<TICKET>.<ext>` directly, so a newly uploaded file works
even before the index is rebuilt. The import accepts `TICKET.ext`, `TICKET - TICKET.ext` and ZIPs.
It rejects files whose ticket is not in the IFC model, as well as broken files. A replaced file
goes to `<folder>/_archive/<date-time>/` (server mode) or stays in the GitHub history.

## Updating the IFC model

Choose one of three equivalent ways (they produce the same data):

1. **Dashboard → Import → IFC model.** Choose the `.ifc` or a `.zip` containing it.
   - The file is checked, converted in the browser and summarised against the current model (stones, tickets and changed values).
   - Nothing changes until you press **Replace the current model**. If the file fails the check, the current model stays.
   - Then, in server mode, press **Save on the server for everyone** (the old model is archived in `_archive/model-<date-time>/`). On GitHub Pages, press **Download the model update** and upload its `data/` and `geom/` files.
   - A 1.4 GB IFC needs a computer with 8 GB of memory or more and takes several minutes.
2. `node --max-old-space-size=6144 tools/ifc-convert.mjs model.zip .` (Node 22+, the same code as the button).
3. `python tools/build_all.py --ifc model.zip` (Python 3.9+ with numpy). This also writes `reports/*.csv`.

## Folder structure

```
index.html                     page
assets/app.css, app.js         design and application logic
assets/viewer.js               WebGL2 model viewer (no external libraries)
assets/stl-viewer.js           STL reader and preview viewer
assets/ifc-core.js, ifc-worker.js   in-browser IFC converter used by Import → IFC model
data/elements.json             IFC elements: GlobalId, Revit ID, ticket, elevation, phase,
                               Issue Status, T-31 counts, dimensions, all property sets, bbox
data/pdf_index.json, stl_index.json   file indexes
geom/*.bin                     IFC geometry, one file per elevation (largest 17 MB)
fab-sheets/<TICKET>.pdf        1,288 Fab Sheets
stl/<TICKET>.stl               199 STL files
vendor/pdfjs/                  pdf.js 6.2.108 (Apache-2.0) for browsers without a PDF viewer
server.py, start-dashboard.*   local use; saves imports for everyone using this server
tools/                         rebuild pipeline (IFC parser, geometry, file library, reports)
reports/*.csv                  stone list, tickets, file matching and data checks
docs/REPORT-ROUND3.md          this round: root causes, tests, open items
.github/workflows/pages.yml    GitHub Pages publishing
DEPLOY-GITHUB.md               publishing steps
```

## Confidentiality

The site contains project drawings, STL files and model data. On GitHub Free/Pro/Team, a GitHub
Pages site is visible to anyone who has the link. Only GitHub Enterprise Cloud can restrict Pages
to signed-in members. Read the warning in `DEPLOY-GITHUB.md` before publishing.
