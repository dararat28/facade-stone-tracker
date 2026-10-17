# Round 2 — fixes for the 7 reported issues

17 October 2026. All results below come from the supplied IFC, workbook and Fab Sheet ZIPs.
Test evidence: section "Test report"; expected values were computed from the source files,
not from the dashboard's own data.

## 1. "No Fab Sheet" when clicking a stone

**Root cause.** The dashboard looked PDFs up from `fab-sheets/`, but the PDFs were not part of the
delivered package; the user had to extract the two ZIPs into that folder by hand. If they were
extracted elsewhere, or the ZIPs were copied in unextracted, every lookup failed. A browser
cannot open a PDF inside a ZIP, and the message only said "No Fab Sheet".

**Fix.**
- The 1,288 PDFs are now part of the project in one flat folder, named exactly like the ticket
  (`fab-sheets/AC-005.pdf`). `tools/fabsheets.py` built it from both ZIPs. All 1,288 copies are
  byte-identical to the originals.
- Lookup accepts `TICKET.pdf`, `TICKET - TICKET.pdf`, any letter case and spaces, extra sheets
  (`TICKET__2.pdf`), and a ticket written without leading zeros only when that match is unique.
  Duplicates are reported, not guessed.
- A PDF is fetched only when its sheet is opened (verified: 0 PDF requests at start-up).
- When nothing matches, the panel names the ticket as written in IFC and Excel, the lookup key,
  the paths tried with their HTTP result, and what to do.
- The Fab Sheet opens in a dedicated tab of the right panel, with a full-screen option.

## 2. Quantity on click showed the elevation total

**Root cause.** The panel's "Quantity" line was the Excel quantity of the whole
ticket × elevation record (for example 6 for AC-005 on E2100T), shown as if it belonged to the
clicked stone.

**Fix.** A Quantities block with four labelled rows:

| Row | Counts |
|---|---|
| Selected elements | IFC elements selected / highlighted: **1 / 1** for one click; Ctrl/Shift-click adds |
| Ticket X (all elevations) | IFC elements with that ticket, next to the Excel quantity |
| X on elevation Y | IFC elements of the ticket on that elevation, next to the Excel sheet row |
| Elevation Y total | all stones on that elevation, IFC and Excel |
| Dashboard total | 13,704 IFC elements, 13,703 Excel quantity, 1,288 tickets, 2,324 Excel rows |

The KPI strip separates IFC elements, Excel quantity, unique tickets and Excel records.

## 3. P8 and P8-New

The IFC Workset values `P8` (798 stones) and `P8-New` (278) are both shown as phase **P8**
(1,076 stones). Only the pattern `P<number>` followed by "new" is merged. The original Revit value
stays visible ("Phase P8 / Revit workset P8-New") and in `reports/ifc_elements.csv`.

## 4. Model did not match the Revit positions

**Root cause, found in the IFC structure.** 121 stones are members of an `IfcElementAssembly`
and use an `IfcFacetedBrep` body. The exporter wrote their B-rep vertices in project coordinates
**and** gave them a non-identity ObjectPlacement, so the same offset is applied twice. Any IFC
viewer shows them 30–60 m from the building. For these elements the placement origin lies
inside the bounding box of the untransformed geometry, while that geometry is more than 5 m from
the local origin; that is the rule the converter applies. It does not move elements by hand.

**Validation.** All 121 repaired stones then sit with a 9–10 mm joint to their neighbours, the
same joint as the rest of the façade, overlap no other stone, and lie among stones of their own
elevation.

**Display coordinates.** The IfcSite placement carries Revit's shared-coordinate rotation
(−90.93°). The viewer removes it from the whole model with one rigid transform, so the model
appears in Revit's project orientation; the Revit model text reads upright in Top view. The
inverse matrix is stored in `data/elements.json` (`coords`).

**Not resolved.** 24T-001 (E2801T) and IC-005 (E2802T) are each more than 3 m from any other
stone. Their geometry is shared with correctly placed stones, but their placement leaves them
about 35 m below the building, and no single consistent rule places them. They are drawn where
the IFC puts them and listed under Data quality; check them in Revit.

## 5. Open the dashboard from a link (GitHub Pages)

**Root cause.** The first version needed `server.py` (Python) on each computer.

**Fix.** The dashboard now runs from any static web host. It uses only relative paths, and was
tested under a GitHub-style sub-path (`/facade-stone-tracker/`) with no server API: 36/36
geometry files, 0 requests outside the sub-path. `.github/workflows/pages.yml` publishes it and
rebuilds the PDF index whenever PDFs are uploaded to `fab-sheets/`.

Sizes, checked against the [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits):

| Item | Size | Limit |
|---|---|---|
| Published site | about 214 MB | 1 GB |
| Largest file | 17 MB | 100 MB per file |
| One full visit | about 75 MB, PDFs on demand | 100 GB per month soft limit, about 1,300 full loads |

**Confidentiality.** On GitHub Free the repository must be public, and on Pro/Team the site is
still public. Only Enterprise Cloud can restrict a Pages site. The site exposes all Fab Sheets
and model data to anyone with the link. `DEPLOY-GITHUB.md` gives the steps, in Thai, and
alternatives with a login.

**Not done here.** The site is **not deployed**: this workspace has no GitHub access. Deployment
needs the steps in `DEPLOY-GITHUB.md`.

## 6. Professional appearance

Redesigned as a BIM coordination tool:
- dark application bar with global search and Import;
- compact KPI strip with icons;
- left panel with filters, an elevation table with bars, and Records / Data quality tabs;
- central viewer with icon toolbar (Home, Top/Front/Right/Back/Left, Selection, Show/Ghost/Hide,
  Ortho, Context) and an orientation gizmo;
- right panel with Properties and Fab Sheet tabs.

It uses a neutral slate palette with one blue accent and amber/red only for issues. Code is split
into `index.html`, `assets/app.css`, `assets/app.js` and `assets/viewer.js`.

## 7. MT-001 quantity

**Root cause.** The IFC has **18** MT-001 stones (E2100T 4, E2101T 5, E2200T 5, E2201T 4). The
workbook gives 17, because sheet *Elevation 2200T*, row 107, says 4 where the model has 5.

**Fix.** As you confirmed, the IFC element count is now treated as the physical quantity
everywhere. The panel and Data quality show "IFC 18 · Excel 17 · Excel needs update" and name the
cell to change. The workbook itself is not edited.

## Files created or modified

| Status | Files |
|---|---|
| Created | `assets/app.css`, `assets/app.js`, `assets/viewer.js`, `tools/fabsheets.py`, `.github/workflows/pages.yml`, `.nojekyll`, `.gitignore`, `DEPLOY-GITHUB.md`, `docs/FIXES-ROUND2.md`, `fab-sheets/*.pdf` (1,288) and `fab-sheets/README.txt` |
| Modified | `index.html` (now markup only), `server.py`, `tools/export_geom.py`, `tools/build_data.py`, `tools/build_all.py`, `README.md`, `data/elements.json`, `data/stones.json`, `data/pdf_index.json`, `geom/*.bin`, `reports/*.csv` |

## Test report

Run with Playwright and Chromium (software WebGL, no GPU). The static site was served from a
sub-path with a plain web server; `server.py` was run separately.

| # | Criterion | Result |
|---|---|---|
| 1.1 | 20 real tickets return a PDF byte-identical to the supplied file (incl. 28T-001, HT-021, HT-022) | PASS |
| 1.2 | Clicking a stone (AC-005) shows its sheet; drawing text contains AC-005 | PASS |
| 1.3 | Missing PDF gives a diagnostic naming ticket, key, path and HTTP status | PASS |
| 2.1 | One click shows Selected 1 / 1, with ticket, elevation and dashboard totals separate | PASS |
| 2.2 | Ctrl-click: 2 / 2, tickets in selection 2 | PASS |
| 2.3 | Ticket selection: 360 / 360 for CC-005 | PASS |
| 3.1 | P8 filter = 1,076 = 798 P8 + 278 P8-New; one P8 option | PASS |
| 3.2 | Original workset value shown | PASS |
| 4.1 | 121 repairs by rule all pass the overlap/neighbour check; 2 isolated stones reported, not moved | PASS |
| 4.2 | One rigid display transform; model text upright in Top view | PASS |
| 5.1 | Loads from a static sub-path: 36/36 files, 7,702,597 triangles, 0 HTTP or page errors | PASS |
| 5.2 | 0 PDF downloads at start-up | PASS |
| 5.3 | 0 requests outside the sub-path | PASS |
| 5.4 | Published on GitHub Pages and opened from the public link | NOT VERIFIED (no GitHub access here) |
| 6.1 | Static site: import previews in the browser; "Download for upload" gives a correctly named file | PASS |
| 6.2 | `server.py`: import replaces `fab-sheets/HT-021.pdf`, archives the old file, updates the index | PASS |
| 6.3 | Appearance on your monitors and browsers (Windows, Edge/Chrome with GPU) | NOT VERIFIED |
| 7.1 | Search 19T-002 highlights 134 elements = 134 IFC GlobalIds | PASS |
| 7.2 | Click selects the right element (GlobalId shown, 1 / 1) | PASS |
| 7.3 | Excel and IFC source values shown side by side (21C-001) | PASS |
| 7.4 | Unreliable mappings listed (28T-001…005, MT-001, 2 isolated stones, 121 repairs) | PASS |
| 7.5 | MT-001: panel says IFC 18 used, Excel 17, update Elevation 2200T row 107 | PASS |
| — | No page errors in any run | PASS |

## Still requires your action

1. Publish the repository with `DEPLOY-GITHUB.md` (GitHub Desktop, about 20 minutes), after
   deciding whether the data may be public.
2. In Revit: fix the IFC export of assembly members (double offset), check 24T-001 and IC-005,
   the 28T-001…005 elevation (IFC E2801T, Excel E2804T), and the 39 tickets whose IFC
   dimensions export as 0.008 (feet converted twice).
3. In Excel: Elevation 2200T row 107 (MT-001 should be 5).
