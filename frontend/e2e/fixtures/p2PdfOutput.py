"""A searchable real input with CropBox, rotation and UserUnit for output verification."""
import sys
import pymupdf

pdf = pymupdf.open(sys.argv[1])
page = pdf[1]
page.set_cropbox(pymupdf.Rect(40, 40, 555, 802))
page.set_rotation(90)
pdf.xref_set_key(page.xref, 'UserUnit', '1.25')
pdf.save(sys.argv[2])
