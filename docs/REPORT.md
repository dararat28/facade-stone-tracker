# Façade Stone Dashboard — inspection, matching and test report

Project: Vancouver Washington Temple (P23830). Prepared 17 October 2026.
Everything below was measured on the supplied files; nothing was estimated or invented.

## 1. Input files

| File | Size | Contents |
|---|---|---|
| `INH_Vancouver_Washington_v24_FACADE.zip` | 301 MB | one IFC, `INH_Vancouver Washington_v24_FACADE.ifc`, 1,383,743,963 bytes |
| `2026-10-19_STONE_TICKET_CONTROL_SHEETS-Phase_8.xlsx` | 2.6 MB | 39 worksheets |
| `01-Fab_Sheet_P1-P8-Pdf.zip` | 128 MB (145 MB extracted) | 1,283 files in one folder `01-Fab Sheet P1-P8-Pdf/`: 1,281 PDFs, 1 PNG, `Thumbs.db` |
| `Add_Fab_sheet.zip` | 0.7 MB | 7 PDFs in `Add Fab sheet/` (the tickets missing from the first archive) |

## 2. IFC inspection

- Schema **IFC2X3**, CoordinationView 2.0, exported from Autodesk Revit 2024 (ODA SDAI 24.6) on 2026-10-17. Length unit **millimetre**; plane angle unit degree.
- 25.4 million entity instances. Geometry is dominated by faceted B-reps: 6.9 million `IfcFace`/`IfcPolyLoop`, 3.8 million points.
- Spatial structure: 1 project, 1 site, 1 building, 10 storeys.
- Products: **20,028 `IfcBuildingElementProxy`**, 1,290 `IfcElementAssembly`, 33 `IfcWindow`, 16 `IfcSlab`, 4 `IfcFlowTerminal`.
- Representations: Body as SweptSolid (11,952), MappedRepresentation (9,488; all mapping origins and targets are identity), Brep (2,160), SurfaceModel (363). No boolean or curved-surface geometry was found, so every product could be tessellated (0 unsupported items).

### Stone elements and identifiers

| Group | Count | How identified |
|---|---|---|
| **Stones** | **13,704** | proxies with `TICKET NUMBER` in property set `Text` |
| 3D ticket tags | 5,674 | proxies of family `Tag-Name-3D` (`Ticket Number` = `T-1`, `Panel Type Name` = ticket). Annotation only; excluded |
| Other proxies | 650 | model text and similar; drawn as context |
| Element assemblies | 1,290 | `Generic Models Assembly:<ticket>`; no own geometry; each aggregates one stone |

- Properties are **instance-level** (`IfcRelDefinesByProperties`); the 14,432 proxy types carry no stone data.
- Per stone: `Text`.`TICKET NUMBER`, `Text`.`Architect` (= elevation, 35 values E2100T … E2804T), `Identity Data`.`Workset` (P1–P8, P8-New), `Identity Data`.`Assembly Name`, `Dimensions`.`LENGTH/WIDTH/HEIGHT/THICKNESS` (mm), `Text`.`FINISH`, `Detail`, `Revision Number`, `Release date`, `STATUS`, `TOLERANCE`, `Wait to confirm model`.
- Every stone has a unique IFC **GlobalId** and a Revit element ID (IFC `Tag`); these are different identifiers and both are shown.
- **1,288 distinct tickets**; a ticket is **not** a unique stone ID (682 tickets have several stones, CT-002 has 1,870).

### Performance consequence

The 1.38 GB IFC cannot be opened in a browser tab: web-ifc keeps the whole STEP file plus its parsed model in WebAssembly memory (4 GB ceiling) and would need minutes to tessellate. The geometry was therefore converted once (`tools/`) into 36 binary files (68 MB, 7.70 million triangles, positions quantised to 16 bit inside each element's bounding box, under 0.05 mm error for a 3 m stone). Twelve carved tickets (e.g. AC-005, CC-005 × 360, CC-121) account for about 5 million of the triangles.

## 3. Excel inspection

| Worksheets | Purpose | Notes |
|---|---|---|
| Project Overall Tracker | one row per ticket ("Fab Template"): L, W, H, T [mm], issue note, revision; 35 per-elevation quantity columns (VLOOKUP into the elevation sheets) and SUM TOTAL | header row 7, data rows 8–1295, 1 merged cell (H6:K6) |
| 35 × `Elevation …` | ticket, **Quantity**, L/W/H/T, revision, release date, issue status for one elevation (cell B5) | 17 sheets pull dimensions from the tracker by VLOOKUP, 18 hold typed values; sheet names are inconsistent (`Elevation 2600T` vs `Elevation E2500T`) but B5 is always `E…T` |
| Sheet1-P1-P4,P7 | fab sheet issue list (scope, count, issue date, revisions) | 455 rows |
| Sheet1-P5, Sheet P6 | Revit schedules per elevation | reference only, not counted |

- 1,288 tracker tickets, no duplicates; 2,324 elevation-sheet rows, no ticket repeated within one sheet; ticket format `<series>-<nnn>[A–D][R]`.
- Units: millimetres (headers `[mm.]`). Width is blank or 0 for 395 tracker values (not applicable for those stones).
- Release dates are mixed: real dates, `d/m/yyyy` and `d/m/yy` text; normalised to ISO with the original text kept.
- The workbook is read with Excel's cached formula results; it is never modified.

**Counting rules.** Physical stones in Excel = sum of `Quantity` on the elevation sheets (13,703). The tracker's quantity columns repeat the same numbers and are not added again. Tickets = distinct tracker rows (1,288). A record = one ticket on one elevation (2,329 records).

**Finding:** the tracker's `SUM TOTAL` row (1296) sums rows 8–1293, so HT-021 and HT-022 (rows 1294–1295, 7 stones on E2801T) are missing from the sheet's own totals (it shows 13,696 and 281 for E2801T). The per-ticket tracker quantities agree with the elevation sheets in all 2,324 rows.

**Finding:** 5 tickets appear only on the schedule sheets and nowhere else: 13T-001, 13T-002, 13T-002R (Sheet P6), VT-004, VT-005 (Sheet1-P5).

## 4. Fab Sheet PDF inspection

- 1,281 + 7 = **1,288 PDFs**, all named `<TICKET> - <TICKET>.pdf` with identical halves; no duplicates, no unsafe paths, no nested sub-folders beyond the top folder of each ZIP.
- Not PDFs (ignored): `INH_VancouverWashington_v24_FACADE-MicrosoftTeams-image(17)-3866176.png`, `Thumbs.db`.
- All 1,288 PDFs are single-page drawings (2592 × 1728 pt). **The drawing text of every PDF contains its own ticket number** (checked with `tools/verify_pdfs.py`), so no file is mis-named.
- Normalisation: remove whitespace, upper-case. No further normalisation was needed.

## 5. Cross-file matching

The reliable key is the **ticket number**, combined with the **elevation** (Excel sheet cell B5 = IFC `Architect`) because one ticket covers many stones. Individual stones are identified by IFC GlobalId.

| Check | Result |
|---|---|
| Excel tickets found in IFC | 1,288 / 1,288 |
| IFC tickets found in Excel | 1,288 / 1,288 |
| Tickets with a Fab Sheet PDF | 1,288 / 1,288 (1,281 before `Add_Fab_sheet.zip`; the 7 missing were 28T-001…005, HT-021, HT-022) |
| PDFs without a ticket | 0 |
| Excel stones / IFC stones | 13,703 / 13,704 |
| Records matched (same quantity) | 2,318 of 2,329 |
| Tickets mapping to several IFC elements | 682 (all are highlighted together) |
| Tickets mapping to several PDFs | 0 |

Quantity differences (`reports/records.csv`):

| Ticket | Excel | IFC |
|---|---|---|
| 28T-001 … 28T-005 | 2 each on **E2804T** | 2 each on **E2801T** (IFC `Architect` differs from the sheet the ticket is listed on) |
| MT-001 | 4 on E2200T | 5 on E2200T |

These explain the elevation totals: E2801T 288 vs 298, E2804T 126 vs 116, E2200T 1,005 vs 1,006.

Dimension conflicts, Excel tracker vs IFC instance values, more than 1 mm (42 tickets, `reports/dimension_conflicts.csv`):

- 39 tickets (21C-…, 22C-…, 21T-…, 27T-…, CT-180…217, FT-…, 18T-002, CC-037, JC-004): IFC shows **0.008 mm** (or 0.01) where Excel has 762 (914). 762 mm ÷ 304.8 ÷ 304.8 = 0.0082, so the IFC exporter converted these values from feet twice; the Revit parameter is probably correct and the IFC value is not.
- CT-173 length 641 vs 642.8; PC-002R 447 × 450 vs 450.9 × 446.9 (length and width swapped and rounded differently); CC-026 width 537 and height 448 in IFC but blank in the tracker.
- 366–368 stones have no Dimensions values in IFC; these are shown as "–", not as conflicts.

Neither source is overwritten: the dashboard shows both values with their source.

**Finding — position error in the IFC export:** 121 stones that belong to a Revit assembly and use an IfcFacetedBrep body get their placement offset twice (vertices already in project coordinates plus a non-identity ObjectPlacement), so any IFC viewer shows them 30–60 m from the building. The converter applies one structural rule to exactly these elements; afterwards all 121 sit with the same 9–10 mm joint as the rest of the façade (`reports/position_corrected.csv`, details in `docs/FIXES-ROUND2.md`). 24T-001 (E2801T) and IC-005 (E2802T) remain isolated and are drawn as the IFC places them (`reports/stones_outside_building.csv`).

## 6. Architecture

| Layer | Source → file | Notes |
|---|---|---|
| A. Geometry | IFC → `geom/<elevation>.bin` (36 files) | custom tessellator (`tools/geom_build.py`); loaded progressively, stones first |
| B. Data | IFC → `data/elements.json`; Excel → `data/stones.json` | GlobalId, Revit ID, ticket, elevation, properties, bounding box; every Excel value keeps its sheet and row |
| C. Fab Sheets | `fab-sheets/**.pdf` → `server.py /api/pdf-index` (live) or `data/pdf_index.json` | loaded only on Preview; import API replaces versions and archives the old file |

The viewer is a self-written WebGL2 renderer, not That Open Components / web-ifc: the network-isolated build machine could not install packages, the model is too large for in-browser IFC parsing, and a dependency-free page avoids sending project data to any CDN. Element colour and visibility live in a small texture indexed by element ID, so highlighting thousands of stones is one texture upload; picking uses an ID render pass; rendering happens only when the view changes.

## 7. Acceptance tests

Run with Playwright + Chromium (software WebGL, no GPU) against the package unzipped into an empty folder, PDFs extracted as the README says, started with `start-dashboard.command`. Expected values were computed directly from the workbook (openpyxl) and from an independent parse of the IFC, not from the dashboard's data files.

| # | Test | Result | Evidence |
|---|---|---|---|
| 1 | Actual IFC model loads | **Passed** | 36/36 geometry files, 7,702,597 triangles, 13,704 stones, 0 page errors |
| 2 | All worksheets interpreted | **Passed** | 39/39 sheets; quantity 13,703 equals the workbook |
| 3 | Ticket numbers indexed | **Passed** | 1,288 = tracker, none missing |
| 4 | Known ticket search returns correct records | **Passed** | AC-005 → E2100T, E2101T, E2200T, E2201T, same as the workbook |
| 5 | Matching IFC stones highlighted accurately | **Passed** | AC-005: 20 highlighted = the 20 IFC GlobalIds; CC-005 on E2100T 108 = 108; a click in the viewer picked the expected stone |
| 6 | Properties show expected values and units | **Passed** | 21C-001: 762/762/625/254 mm as in the workbook; IFC 0.008 shown and marked as conflicts |
| 7 | Elevation filter | **Passed** | E2804T: Excel 126, IFC 116, list only E2804T |
| 8 | KPI totals follow the counting rules | **Passed** | 1,288 / 13,703 / 13,704 equal the source files |
| 9 | Known ticket opens its correct Fab Sheet | **Passed** | 10C-001 requested `10C-001 - 10C-001.pdf`; its rendered text contains 10C-001 |
| 10 | Missing PDFs and unmatched elements reported | **Passed** | removing HT-022.pdf → KPI "1 missing", listed, preview disabled; 28T-001 E2804T / E2801T listed |
| 11 | Duplicates and conflicts handled explicitly | **Passed** | duplicate AC-001 PDF reported; 42 dimension conflicts with both values |
| 12 | No PDFs loaded at start-up | **Passed** | 0 PDF requests until Preview |
| 13 | Performance measured | **Passed (partly measured)** | JSON 0.13 s; all geometry download + parse + GPU upload 0.9 s on localhost; JS heap 34 MB. A full-model frame took about 5 s on the CPU software renderer; **real-GPU frame rate is Not Yet Verified** (no GPU available) |
| 14 | Launch from the instructions | **Passed** | fresh unzip + launcher; file:// shows the start instructions |
| 15 | Import replaces old Fab Sheet (server) | **Passed** | 1 replaced, wrong-ticket and non-PDF files rejected, old file in `_archive/`, panel shows "Imported …" |
| 16 | Import without server (browser only) | **Passed** | stored in IndexedDB, survives reload, pdf.js shows the imported file |
| 17 | Browser's own PDF viewer (iframe) | **Not Yet Verified** | headless Chromium has no PDF plug-in; the bundled pdf.js viewer was verified instead (it is used automatically when no built-in viewer exists) |
| 18 | Windows `start-dashboard.bat`, Edge/Firefox/Safari | **Not Yet Verified** | tested on Linux Chromium only |

Rebuild pipeline: `tools/build_all.py` run from the original ZIP reproduced byte-identical geometry files.

## 8. Known limitations and next steps

1. **Rendering load.** 7.7 million triangles are fine on a dedicated GPU but may be slow on old integrated graphics. Mitigations in the page: *Hide* + elevation filter (skips whole geometry files), `?elev=` to load selected elevations. Next step: GPU instancing for repeated carved stones (CC-005 ×360 alone is 3 million triangles) or offline mesh simplification for carved details.
2. **Fix in Revit/export:** IFC dimension values ≈ 0.008 for 39 tickets (double feet conversion); the double placement offset of 121 assembly stones and the 2 isolated stones; 28T-001…005 `Architect` E2801T vs Excel E2804T; MT-001 quantity 5 vs 4; tracker SUM TOTAL range.
3. The ticket letters (e.g. C/T in `21C`, `21T`, suffix `R`) are shown as-is; their meaning is not interpreted.
4. 3D ticket tags (5,674) are not drawn; they are annotation, not stones.
5. Imports through `server.py` have no user accounts; keep it on a trusted network. For multi-site use, host the folder behind the company's authenticated web server and keep `server.py` for the person who maintains the Fab Sheets.
6. When the IFC or workbook changes, run `tools/build_all.py`. Fab Sheet updates need no rebuild with `server.py`.
