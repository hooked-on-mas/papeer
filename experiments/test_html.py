import pymupdf as fitz
doc = fitz.open()
page = doc.new_page()

archive = fitz.Archive()
img_bytes = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDAT\x08\xd7c\xf8\xcf\xc0\x00\x00\x03\x01\x01\x00\x18\xdd\x8d\xb0\x00\x00\x00\x00IEND\xaeB`\x82'
archive.add((img_bytes, "f1.png"))

markup = '<div>Hello <img src="f1.png" style="width:50px;height:20px;"> world!</div>'

images_before = {tuple(img['bbox']) for img in page.get_image_info()}
page.insert_htmlbox(fitz.Rect(50, 50, 400, 400), markup, archive=archive)

images_after = page.get_image_info()
new_images = [img for img in images_after if tuple(img['bbox']) not in images_before]
new_images.sort(key=lambda img: (round((img['bbox'][1] + img['bbox'][3]) / 2 / 10), img['bbox'][0]))

print("New images:", new_images)

for img in new_images:
    img_rect = fitz.Rect(img['bbox'])
    fontsize = img_rect.height
    print("img_rect:", img_rect)
    rc = -1
    while fontsize >= 0.1:
        if page.insert_textbox(img_rect, "HiddenText", fontsize=fontsize, render_mode=3) >= 0:
            print("Inserted with fontsize:", fontsize)
            rc = 0
            break
        fontsize *= 0.9

print("Words:", page.get_text('words'))

