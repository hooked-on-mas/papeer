"""Create side-by-side PNGs of review artifacts for manual visual inspection."""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw

def pairs(root, output):
    output.mkdir(parents=True, exist_ok=True)
    for translated in root.glob('*.png'):
        source = root / (translated.stem + '-source.png')
        if not source.exists():
            continue
        images = []
        for path in (source, translated):
            im = Image.open(path).convert('RGB')
            im.thumbnail((780, 1150))
            images.append(im)
        sheet = Image.new('RGB', (sum(im.width for im in images) + 20, max(im.height for im in images) + 30), 'white')
        x = 0
        for im in images:
            sheet.paste(im, (x, 30))
            x += im.width + 20
        ImageDraw.Draw(sheet).text((8, 8), translated.stem + ' SOURCE / JAPANESE', fill='black')
        sheet.save(output / (translated.stem + '-pair.png'))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('review', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    pairs(args.review, args.output)
