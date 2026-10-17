STL library

One STL file per IFC ticket number, named exactly like the ticket: 18T-001.stl, CC-080.stl ...
Binary and ASCII STL are both accepted. Project rule: a ticket whose IFC Issue Status mentions
"STL" is expected to have a file here; the dashboard lists missing and extra files.

To update a file, replace it with one of the same name, or use Import > STL files in the
dashboard, or: python tools/library.py import stl <stl, zip or folder>.
Replaced files are kept in _archive/ when you import through the dashboard (server mode) or the tool.
