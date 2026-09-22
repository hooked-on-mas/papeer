"""Generate reproducible UI/PDF previews from the included synthetic paper.

The Japanese translations below are manually authored fixture text.
No paid API or ChatGPT session is used to produce these previews.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz
from PySide6.QtGui import QFontDatabase
from PySide6.QtWidgets import QApplication

from paperdesk.gui import STYLE, Window
from paperdesk.pdf_engine import build_translated_pdf, bilingual_pdf, page_png, save_json

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/preview"
OUT.mkdir(parents=True, exist_ok=True)

translations = {
    "p1b1": "自動化システムの適応制御",
    "p1b2": "概要",
    "p1b3": "手法",
    "p1b4": "固定ゲインの基準手法と、オンラインのパラメータ更新を比較する。両手法には同じ外乱信号を与える。安定性はモデルで述べた仮定に依存する。",
    "p1b5": "自動生産システムの適応制御器を検討する。シミュレーション環境で追従誤差を18%削減した。実際の生産設備での検証は行っていない。",
    "p1b6": "図1. シミュレーションでの追従性能。",
    "p2b1": "結果と限界",
    "p2b2": "平均追従誤差は適応制御器が0.82、基準手法が1.00だった。シミュレーションは5回実行した。",
    "p2b3": "この実験は産業環境への導入時の信頼性を証明するものではない。センサーの遅延とハードウェア故障への対応は今後の課題である。",
    "p2b4": "参考文献\n1. この文献は動作検証用の架空の例です。",
}

app = QApplication.instance() or QApplication([])
app.setStyleSheet(STYLE)
with tempfile.TemporaryDirectory(prefix="paperdesk-preview-") as temporary:
    temporary = Path(temporary)
    if os.name != "nt":
        font_path = temporary / "cjk.ttf"
        font_path.write_bytes(fitz.Font("japan").buffer)
        font_id = QFontDatabase.addApplicationFont(str(font_path))
        families = QFontDatabase.applicationFontFamilies(font_id)
        if families:
            app.setStyleSheet(STYLE + f"\nQWidget {{font-family:'{families[0]}';}}")
    window = Window(temporary / "library")
    identity, _ = window.library.import_pdf(ROOT / "tests/fixtures/sample.pdf")
    window.library.update(identity, title="自動化システムの適応制御 · 動作検証サンプル", favorite=1,
                          note="## 確認したいこと\n\n- 実機でのセンサー遅延の影響\n- 固定ゲイン制御との比較条件",
                          collection_name="制御・自動化")
    folder = window.library.folder(identity)
    report = build_translated_pdf(folder / "original.pdf", window.library.document(identity), translations, folder / "translated.pdf")
    save_json(folder / "translation-report.json", report)
    window.library.update(identity, status="翻訳済み")
    article = f"""# 適応制御で何が改善したのか

これは画面とPDFの検証用に作成した架空の論文です。以下の文章と翻訳は手作業で用意したサンプルです。

## 研究の問い

制御器のパラメータをオンラインで更新すると、固定ゲインの制御より追従誤差を小さくできるか。

## 手法と結果

同じ外乱信号を用いて比較したところ、平均追従誤差（tracking error）は基準手法の **1.00** に対し、適応制御器で **0.82** だった。改善率は **18%**。 [原文 p.2](paperdesk://{identity}/2)

## 読むときに注意する点

この結果は5回のシミュレーションに基づく。実際の生産設備における信頼性は検証されておらず、センサー遅延や機器故障への対応が残る。
"""
    (folder / "article.md").write_text(article, "utf-8")
    window.library.add_exchange(identity, "実験の限界は？", f"実機での検証は行っていません。センサー遅延とハードウェア故障は未解決の課題です。 [p.2](paperdesk://{identity}/2)")
    window.show()
    window.refresh_list()
    window.select_paper(identity)
    window.status_label.setText("動作検証用サンプル / 翻訳・サマリーは手作業のテストデータです。")
    for _ in range(5):
        app.processEvents()
        time.sleep(0.08)
    window.render_pages()
    window.grab().save(str(OUT / "reader.png"))
    window.tabs.setCurrentIndex(1)
    app.processEvents()
    window.grab().save(str(OUT / "article.png"))
    (OUT / "translated-page-1.png").write_bytes(page_png(folder / "translated.pdf", 0, 1100))
    bilingual_pdf(folder / "original.pdf", folder / "translated.pdf", OUT / "sample-bilingual.pdf")
    (OUT / "bilingual-page-1.png").write_bytes(page_png(OUT / "sample-bilingual.pdf", 0, 1400))
    print(json.dumps(report, ensure_ascii=False))
    window.close()
print("Saved preview artifacts to", OUT)
