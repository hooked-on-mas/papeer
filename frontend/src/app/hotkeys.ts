/** Shortcuts registered in AppShell, listed for the settings dialog. Keep the two in sync. */
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
      { keys: ["Ctrl", "1〜4"], label: "タブを切り替え（PDF を読む / サマリー / チャット / メモ・整理）。集中表示中は右パネルに開閉" },
      { keys: ["Ctrl", "5"], label: "付箋タブを開く（集中表示を終了）" },
      { keys: ["F11"], label: "集中表示" },
      { keys: ["Esc"], label: "集中表示を終了" },
    ],
  },
  {
    title: "ライブラリ",
    items: [
      { keys: ["Ctrl", "Shift", "F"], label: "ライブラリを検索" },
      { keys: ["Ctrl", "L"], label: "開いている論文をライブラリで表示" },
      { keys: ["Ctrl", "Shift", "N"], label: "新しいフォルダー" },
      { keys: ["F2"], label: "名前を変更" },
    ],
  },
  {
    title: "リーダー",
    items: [
      { keys: ["←", "→"], label: "前後のページ" },
      { keys: ["Ctrl", "G"], label: "ページ番号を入力" },
      { keys: ["Ctrl", "F"], label: "開いている論文を検索" },
      { keys: ["Ctrl", "+"], label: "拡大" },
      { keys: ["Ctrl", "-"], label: "縮小" },
      { keys: ["Ctrl", "0"], label: "幅に合わせる" },
      { keys: ["Ctrl", "ホイール"], label: "拡大・縮小" },
      { keys: ["Ctrl", "T"], label: "翻訳ダイアログを開く" },
    ],
  },
];
