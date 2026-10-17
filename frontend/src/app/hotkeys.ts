/**
 * Shortcuts registered in AppShell, listed for the settings dialog. Keep the two in sync.
 * Written as on Windows; the settings dialog shows them as the Mac's keyboard has them there (lib/platform.ts).
 */
export const SHORTCUT_GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: "PDFの書き込み（編集ツール選択中）",
    items: [
      { keys: ["Ctrl", "C / X / V"], label: "選択した書き込みのコピー・切り取り・貼り付け" },
      { keys: ["Ctrl", "A"], label: "範囲選択・投げ縄ツールでページの書き込みを全選択" },
      { keys: ["Ctrl", "Z / Y"], label: "編集を元に戻す・やり直す" },
      { keys: ["Delete"], label: "選択した書き込みを削除" },
      { keys: ["矢印", "Shift+矢印"], label: "選択した書き込みを少し移動・大きく移動" },
      { keys: ["Esc"], label: "選択を解除。選択がなければ本文選択に戻る" },
    ],
  },
  {
    title: "全体",
    items: [
      { keys: ["Ctrl", "O"], label: "PDF を追加" },
      { keys: ["Ctrl", "B"], label: "ライブラリの表示を切り替え" },
      { keys: ["Ctrl", "1〜4"], label: "タブを切り替え（本文（ノートではノート）/ サマリー / チャット / メモ）。集中表示中は右パネルに開閉" },
      { keys: ["Ctrl", "5"], label: "付箋タブを開く（集中表示を終了）" },
      { keys: ["Ctrl", "6"], label: "論文マップを開く（集中表示を終了）" },
      { keys: ["F11"], label: "集中表示" },
      { keys: ["Ctrl", ","], label: "接続・設定を開く" },
      { keys: ["Esc"], label: "集中表示を終了" },
    ],
  },
  {
    title: "ライブラリ",
    items: [
      { keys: ["Ctrl", "Shift", "F"], label: "ライブラリを検索" },
      { keys: ["Ctrl", "L"], label: "ライブラリの一覧へ移動（前にいた行、なければ開いている論文）" },
      { keys: ["↑", "↓"], label: "一覧の行を移動（Home / End で最初・最後の行）" },
      { keys: ["→"], label: "閉じたフォルダーを開く。開いたフォルダーでは最初の行へ" },
      { keys: ["←"], label: "開いたフォルダーを閉じる。それ以外では親フォルダーへ" },
      { keys: ["Enter"], label: "論文を開く・フォルダーを追加先に選ぶ" },
      { keys: ["文字"], label: "名前がその文字で始まる行へ移動" },
      { keys: ["Space"], label: "論文を持ち上げ、↑↓で移動先のフォルダーを選び、もう一度 Space で移動（Esc で取り消し）。選択中の論文はまとめて移動" },
      { keys: ["Ctrl", "クリック / Space"], label: "論文を複数選択に加える・外す" },
      { keys: ["Shift", "クリック / ↑↓ / Space"], label: "基準の行からその行までの論文を選択（Ctrl+Shift+クリックで追加）" },
      { keys: ["Ctrl", "A"], label: "一覧に見えている論文をすべて選択" },
      { keys: ["Esc"], label: "複数選択を解除（選択中の論文の右クリックでまとめて移動・タグ・読書状態・削除）" },
      { keys: ["Ctrl", "Shift", "N"], label: "新しいフォルダー" },
      { keys: ["Ctrl", "Alt", "N"], label: "新しいノート（追加先のフォルダーに作る）" },
      { keys: ["F2"], label: "名前を変更（一覧ではカーソルのある行）" },
      { keys: ["Delete"], label: "一覧でカーソルのあるフォルダー・論文を削除（確認あり）" },
    ],
  },
  {
    title: "リーダー",
    items: [
      { keys: ["←", "→"], label: "前後のページ" },
      { keys: ["PageDown", "Space"], label: "1 画面下へ。ページの末尾では次のページへ" },
      { keys: ["PageUp", "Shift+Space"], label: "1 画面上へ。ページの先頭では前のページの末尾へ" },
      { keys: ["ホイール"], label: "ページの末尾・先頭でさらに回すと次・前のページへ（PDF は書き込みツール選択中を除く。ノートはペン先が触れている間を除き、最後のページで新しいページは作らない）" },
      { keys: ["Home", "End"], label: "最初・最後のページ" },
      { keys: ["Alt", "← / →"], label: "リンク・目次・検索で移動する前の場所に戻る・進む" },
      { keys: ["Ctrl", "G"], label: "ページ番号を入力" },
      { keys: ["Ctrl", "F"], label: "開いている論文を検索" },
      { keys: ["Enter", "Shift+Enter"], label: "論文内検索で次・前の結果へ（F3 / Shift+F3 でも可）" },
      { keys: ["Ctrl", "+"], label: "拡大" },
      { keys: ["Ctrl", "-"], label: "縮小" },
      { keys: ["Ctrl", "0"], label: "幅に合わせる（ノートは「ページ全体」。ほかの倍率は倍率の選択から）" },
      { keys: ["Ctrl", "ホイール"], label: "拡大・縮小（タッチパッドのピンチでも可）" },
      { keys: ["Ctrl", "T"], label: "翻訳ダイアログを開く" },
      { keys: ["Delete"], label: "選択した付箋を削除（付箋タブのカードでも可）" },
    ],
  },
  {
    title: "ノートのページ一覧（サムネイル）",
    items: [
      { keys: ["Enter", "Space"], label: "そのページへ移動（重ねて開いているときは移動して畳む）" },
      { keys: ["Alt", "↑ / ↓"], label: "ページを上・下へ並べ替え（ドラッグでも可）" },
      { keys: ["Esc"], label: "重ねて開いた一覧を畳み、左端のつまみへフォーカスを戻す（Tab で外へ出ても畳む）" },
    ],
  },
];
