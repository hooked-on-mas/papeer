/** Shortcuts registered in AppShell, listed for the settings dialog. Keep the two in sync. */
export const SHORTCUT_GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: "全体",
    items: [
      { keys: ["Ctrl", "O"], label: "PDF を追加" },
      { keys: ["Ctrl", "B"], label: "ライブラリの表示を切り替え" },
      { keys: ["Ctrl", "1〜4"], label: "タブを切り替え（PDF を読む / サマリー / 質問 / メモ・整理）。集中表示中は右パネルに開閉" },
      { keys: ["F11"], label: "集中表示" },
      { keys: ["Esc"], label: "集中表示を終了" },
    ],
  },
  {
    title: "ライブラリ",
    items: [
      { keys: ["Ctrl", "F"], label: "ライブラリを検索" },
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
      { keys: ["Ctrl", "+"], label: "拡大" },
      { keys: ["Ctrl", "-"], label: "縮小" },
      { keys: ["Ctrl", "0"], label: "幅に合わせる" },
      { keys: ["Ctrl", "ホイール"], label: "拡大・縮小" },
      { keys: ["Ctrl", "T"], label: "翻訳ダイアログを開く" },
    ],
  },
];
