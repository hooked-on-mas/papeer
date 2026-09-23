
from pathlib import Path
from paperdesk.gui_window_library import render_markdown_with_math
folder = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures' / 'sample-paper'
text = '法すべてで .0 \le \text{Prob}(y > 1.7) \le 0.18$ が のまま表示される'
out = render_markdown_with_math(text, folder)
print(out)

