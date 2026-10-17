# Round 3: IFC-only data, Issue Status and T-31, STL preview, Overview, imports

Inputs used:
- `INH_Vancouver Washington_v24_FACADE.ifc`, corrected version of 18 Oct 2026 (1,365,934,745 bytes, IFC2X3, in a 297 MB ZIP);
- the Fab Sheet ZIP (1,288 PDFs, identical to the previous set);
- `STL.zip` (199 STL files);
- the Excel control workbook. Per the brief it was used **only as a reference when reading this report**. The dashboard does not read it.

## 1. What changed and why (root cause per issue)

| # | Issue | Root cause | What was done |
|---|---|---|---|
| 1 | Dashboard data must come only from the IFC | Round 2 merged the Excel workbook (`data/stones.json`) for quantities, dimensions and the tracker. | Removed `data/stones.json`, `tools/build_data.py` and every Excel code path. All KPIs, filters, charts and panels are computed from `data/elements.json` (IFC). Test S3 checks the code. |
| 2 | Import a new IFC model | There was no import path, only a Python rebuild. | New in-browser converter `assets/ifc-core.js` (a JavaScript port of the Python pipeline), run in a Web Worker (`assets/ifc-worker.js`). It validates (schema, stones with TICKET NUMBER, elevation), converts and shows a diff summary against the current model. Nothing changes until **Replace the current model**. On failure, the current model stays. There is no merging. In server mode **Save on the server for everyone** archives the old model in `_archive/model-<time>/`. On static hosting, **Download the model update** gives `data/` + `geom/` for GitHub. The same code runs from the command line (`tools/ifc-convert.mjs`). |
| 3 | Import STL files | There was no STL support. | `tools/library.py` (it replaces `fabsheets.py`) handles PDF and STL the same way. The filename is matched to the IFC ticket (`TICKET.stl`, `TICKET - TICKET.stl`, unique leading-zero match). Binary and ASCII STL are checked. Duplicates in one import, unknown tickets and broken files are rejected. Replaced files are archived. The IFC is not re-imported. |
| 4 | Issue Status, T-31-Count, T-31(30mm.)-Count | These were not exported to the dashboard. | `tools/export_geom.py` and `ifc-core.js` export them raw, per stone, plus every property set. Values are shown exactly as in the IFC. A count is *ok* (whole number, 0 included), *empty*, *invalid* or *not in IFC*. A missing value is never treated as 0. Totals add up holes, and the number of stones those holes are on is shown next to each total. The two parameters are never added together. Search: free text, `T31=2`, `T31-30=3`. |
| 5 | STL preview | — | `assets/stl-viewer.js`: its own WebGL viewer in a dialog (orbit, pan, zoom, pinch, fit, 3D/Front/Top/Right views, download progress, triangle count, size). The STL is shown on its own and is not aligned with the IFC; the dialog says so. The IFC selection and filters stay unchanged. |
| 6 | Overview dashboard with charts | — | New Overview page (the default page). It has KPI cards and charts: by elevation, by phase, Issue Status values, T-31-Count and T-31(30mm.)-Count distributions, STL and PDF availability, and IFC parameter availability. Each phase has its own fixed colour (8 colours checked for colour-blind separation). Every bar also carries its phase name and value. The finish chart was removed on request. Charts have hover tooltips, and a click opens the Model page with that filter. |
| 7 | Model placement / P8 / counts / PDF mapping (regression) | Fixed in round 2. | Re-checked against the new IFC: 121 placement repairs, 0 failing validation; P8 + P8-New = 1,076; 1 / 1 for a single stone; 1,288 / 1,288 PDFs. |
| 8 | Viewer limited to 65,535 elements | Element ids were 16-bit in the viewer. | 32-bit ids and 24-bit picking, so a larger imported model also works. |
| 9 | 24T-001 (Revit ID 6363118) and IC-005 (5080576) shown near ground level instead of on the cornice | The IFC export wrote these two B-reps with their own placement height **subtracted** in z (−35,754 mm and −34,437 mm). Applying the placement as written therefore puts them at about 0 m. This is the mirror image of the 121 stones whose placement was written twice. | Second structural rule in both converters: when the placement height is more than 5 m, the B-rep is local in x/y, and its z range contains minus that height, the height is added back. The same validation as rule 1 applies. Result: 2 repairs, both within 0.3 m of their neighbours and at the same height as the rest of their ticket (35.64 m and 34.57 m), as in Revit. No isolated stones remain. |
| 10 | 3D view blank when opening the Model page | The viewer started while the Overview page hid it: zero canvas size, so the camera fit was invalid. | The camera is fitted when the Model page is first shown. Nothing is drawn while the viewer is hidden. |

### Converter verification

The JavaScript converter (used by the Import button) was run on the same ZIP and compared with the Python export.

| Check | Result |
|---|---|
| Elements | Identical: 14,401 elements, with every exported property identical. |
| Bounding boxes | Identical. |
| Placement repairs | 123 in both (121 + 2), 0 failing validation. |
| Isolated stones | None. |
| Unsupported geometry | None. |
| Geometry files | 36 files with identical triangle counts. A few vertices differ by one 16-bit quantisation step (under 0.3 mm), from floating-point rounding. |

Node.js run on the corrected IFC: 726 s and 1.6 GB of memory. The Python pipeline produced the same result.

## 2. Persistence: who sees an import

| Where the dashboard runs | IFC model | STL / PDF |
|---|---|---|
| `start-dashboard.bat` / `server.py` (this computer) | Replace: this browser tab. **Save on the server for everyone**: written to `data/` + `geom/`, old model archived. | Saved to `stl/` or `fab-sheets/` for everyone using this server; old file archived. |
| GitHub Pages or any static host | This browser tab only, lost on reload. Use **Download the model update** and upload it to GitHub. | Kept in this browser (IndexedDB) until removed. Use **Download for upload** and upload to `stl/` or `fab-sheets/` on GitHub. |

Imports are accepted only from the computer running `server.py`, unless `--allow-remote-import` is given. There is no login.

## 3. Findings in the corrected IFC (for the project team)

Compared with the previous IFC there are the same 13,703 stones (GlobalIds unchanged) and the same 1,288 tickets. 41 values changed:

- **Issue Status, 11 elements** (as you corrected them):
  - **24T-002:** STL status removed from 5 elements (6449426, 6449427, 6449472, 6449473, 6449474). It is no longer an STL ticket.
  - **CC-080** (4 elements), **DC-031** and **DC-031R:** STL status added. They now match their STL files.
- **T-31-Count, 30 stones:** +2 holes each (not mentioned in your message; please confirm this is intended):
  - CC-102…CC-106 and their R stones on E2500T: 6→8 or 7→9;
  - CC-107: 12→14;
  - CC-154…CC-162 and their R stones on E2602T: 6→8;
  - CC-163: 12→14.

Current state:
- **MT-001:** 17 stones (E2100T 4, E2101T 5, E2200T 4, E2201T 4).
- **Issue Status:** present on 2,818 of 13,703 stones.
- **T-31-Count:** on 1,126 stones, 2,652 holes in total.
- **T-31(30mm.)-Count:** on 415 stones, 992 holes in total.
- **Invalid count values:** none.
- **STL rule** (Issue Status mentions STL): **199 tickets, 199 have a file.** There are no missing STL files, no STL files without an STL status, and no STL files that match no ticket.
- **Fab Sheets:** 1,288 / 1,288. No PDF matches no ticket.
- **Tickets with mixed Issue Status:** none.
- **T-31 count without a T-31 Issue Status:** 111 stones (82 T-31-Count, 27 + 2 T-31(30mm.)-Count). Among them are the CC stones with STL status above. See Data quality and `reports/data_checks.csv`.
- **Suspect dimensions** (< 1 mm, for example 0.008): 152 values on 140 stones of 39 tickets.
- **Placement:** 123 placements were repaired (121 written twice, 2 with the height subtracted). No isolated stones remain. 24T-001 has 15 stones and IC-005 has 6, as in Revit.
- **Parameters that are not in the IFC:** Stone ID, Type and Part.

## 4. Test report

Environment: headless Chromium with SwiftShader (no GPU), Linux, Python 3.13 and Node 22.
Expected numbers come from the Python IFC parse (`products.pkl`), not from the dashboard's own data.

### Static hosting (GitHub-Pages-like sub-path `/facade/`)

| ID | Test | Result |
|---|---|---|
| S1 | Full model loads from a sub-path with no server (36 files, 7.57 M triangles, no failed request except the expected `api/status` probe) | PASS |
| S2 | No PDF/STL download and no Excel/`stones.json` at start-up | PASS |
| S3 | Dashboard code and data folder contain no Excel data | PASS |
| S4 | Overview KPIs: 13,703 elements, 1,288 tickets, 2,818 with Issue Status, T-31 2,652 holes / 1,126 stones, T-31(30) 992 / 415 | PASS |
| S5 | STL availability 199 of 199 (IFC STL rule) | PASS |
| S6 | P8 + P8-New = 1,076 shown as P8 | PASS |
| S7 | Click the E2801T column → Model page filtered (288) | PASS |
| S8 | Filter by exact Issue Status (PIN & GLUED = 806) | PASS |
| S9 | Filter by Issue Status group (STL = 576) | PASS |
| S10 | Search `T31=4` → 97 stones, 388 holes | PASS |
| S11 | Search `T31-30=3` → 52 stones, 156 holes | PASS |
| S12 | Search suggests Issue Status values | PASS |
| S13 | MT-001 on E2200T 4 / 4, ticket total 17 | PASS |
| S14 | Click one stone in 3D → Selected IFC elements 1 / 1 | PASS |
| S15 | Fab Sheet found and rendered with pdf.js | PASS |
| S16 | STL preview, binary STL (18T-001, 1,120 triangles) | PASS |
| S17 | Ticket without an STL file (24T-002) → "No STL" button disabled with the reason | PASS |
| S18 | Data-quality counts (missing PDF 0, STL missing 0, STL without status 0, mixed 0, invalid 0, T-31 without status 111, suspect 140, repaired 123, isolated 0) | PASS |
| S19 | STL import on a static site: replaced in the browser, unknown ticket and broken file rejected | PASS |
| S20 | "Download for upload" ZIP contains the correctly named file | PASS |
| S21 | STL preview, ASCII STL (12 triangles, 100 × 50 × 30) | PASS |
| S22 | Invalid IFC rejected, current model unchanged | PASS |
| S23 | No "null" / "undefined" / "NaN" text on the page | PASS |
| S24 | Phone width 390 px: no horizontal scrolling | PASS |
| S25 | Opened from disk (file://): clear instructions | PASS |

### server.py (on a copy of the folder)

| ID | Test | Result |
|---|---|---|
| V1 | server.py detected; imports allowed from this computer only | PASS |
| V2 | STL import saved on the server; old file in `stl/_archive/<time>/`; index refreshed | PASS |
| V3 | After reload every user gets the new STL (ASCII, 12 triangles) without re-importing the IFC | PASS |
| V4 | Fab Sheet PDF import replaces and archives | PASS |
| V5 | Internal files (`tools/`, `server.py`, `_imports.json`, `_archive`, `_incoming`, `reports/`) are not served | PASS |
| V6 | Import IFC model: the corrected 1.37 GB IFC (297 MB ZIP) converted in the browser: 14,401 elements, 123 repairs, 24T-001 and IC-005 at the same height as their tickets, no errors. 306 s (196–954 s across runs on this cloud machine) | PASS |
| V7 | Import summary against the current model (13,703 → 13,703 stones, 0 added/removed, 0 changed values: same file) | PASS |
| V8 | Replace the current model in the session; a banner shows "Imported model (this session)" | PASS |
| V9 | Save on the server for everyone: files written and sizes checked; old model archived in `_archive/model-<time>/` | PASS |
| V10 | A new visitor loads the saved model (converter = browser) | PASS |

### Not verified here

| Item | Why |
|---|---|
| Real GitHub Pages deployment | It needs your GitHub account. The workflow file was checked for valid YAML and the site was tested from a sub-path. |
| Windows `start-dashboard.bat` and Mac `.command` | No Windows or Mac machine here. The files were not changed this round except as listed. |
| IFC import speed on your PC | The test used a software GPU and a cloud CPU. Your PC needs 8 GB of memory or more for the 1.4 GB IFC. |
| Older browsers (Safari < 16.4, Firefox < 113) | Not available here. The 3D viewer needs WebGL2; the STL viewer and the IFC import need a current browser. |

## 5. Ready vs. your action

**Ready:**
- the dashboard with the new IFC;
- 1,288 PDFs and 199 STL files linked;
- the Overview page, Issue Status and T-31 features, the STL preview, and the three import buttons;
- GitHub Pages workflow (now also publishes `stl/`), reports, and the deployment guide.

**Your action:**
1. Publish or update the GitHub repository (`DEPLOY-GITHUB.md`). The site is about 416 MB and 1,540 files, which is within the GitHub Pages limits. Mind the public visibility warning.
2. Confirm the 30 T-31-Count changes (+2 holes) on the CC-102…107 and CC-154…163 stones.
3. When convenient, decide on the 111 stones whose T-31 count and Issue Status disagree, and on the 39 tickets with suspect dimensions.

## 6. Files

- **Created:**
  - `assets/ifc-core.js`, `assets/ifc-worker.js`, `assets/stl-viewer.js`;
  - `tools/library.py`, `tools/ifc-convert.mjs`;
  - `data/stl_index.json`, `stl/*.stl` (199);
  - `reports/ifc_stones.csv`, `tickets.csv`, `file_matching.csv`, `data_checks.csv`;
  - `docs/REPORT-ROUND3.md`.
- **Modified:**
  - `index.html`, `assets/app.js` (rewritten), `assets/app.css`, `assets/viewer.js`;
  - `server.py`;
  - `tools/export_geom.py`, `tools/build_all.py`, `tools/report.py` (rewritten, IFC only);
  - `tools/ifc_pass1.py`, `ifc_props.py`, `geom_load.py`, `geom_build.py` (garbage collector off for speed);
  - `data/elements.json`, `data/pdf_index.json`, `data/stl_index.json`, `geom/*.bin` (corrected IFC of 18 Oct 2026);
  - `.github/workflows/pages.yml`, `.gitignore`, `README.md`, `DEPLOY-GITHUB.md`.
- **Removed:**
  - `data/stones.json`, `tools/build_data.py`, `tools/fabsheets.py`;
  - the Excel-based `reports/*.csv`.
- `docs/REPORT.md` and `docs/FIXES-ROUND2.md` are kept as history. They describe the Excel comparison of earlier rounds, which no longer exists.
