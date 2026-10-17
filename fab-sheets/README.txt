Fab Sheet library

One PDF per IFC ticket number, named exactly like the ticket: AC-005.pdf, 28T-001.pdf ...
Extra sheets for the same ticket: AC-005__2.pdf, AC-005__3.pdf

To update a sheet, replace the file with one of the same name, or use Import > Fab Sheets (PDF)
in the dashboard, or: python tools/library.py import pdf <pdf, zip or folder>.
Replaced files are kept in _archive/ when you import through the dashboard (server mode) or the tool.
