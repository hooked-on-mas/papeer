import { notifyIfAway, shell } from "@/shell";
import { useStore } from "@/store";
import type { JobHandlers } from "@/features/jobs/jobHandlers";
import { offerOcrAfterImport } from "@/features/ocr/ocrActions";
import { showToast } from "@/components/toast";
import { emitAppEvent } from "@/lib/appEvents";
import { MAX_ORGANIZE_PAPERS, organizableIds } from "@/features/library/organizePlan";

/** Jobs started by the library actions in ./actions: adding PDFs and writing paired PDFs. */
export const libraryJobHandlers: JobHandlers = {
  import: {
    succeeded: (event) => {
      const store = useStore.getState();
      const ids = event.result.paper_ids;
      const message = `${event.result.added}件を追加しました。重複するPDFは既存の論文を開きます。`;
      if (ids.length) store.setActivePaperId(ids[ids.length - 1]);
      store.setStatus(message);
      notifyIfAway("PDFを追加しました", message);
      if (event.result.metadata_failures?.length) showToast({
        title: "PDFは追加しましたが、一部の論文情報を取得できませんでした",
        description: event.result.metadata_failures.join("\n"), tone: "error", timeout: 0,
      });
      // Offer the AI's folder proposal for the papers just added (added_ids: not the PDFs that were in the
      // library already). Too many for one proposal: told, without a button that would lead nowhere.
      if (event.result.added > 0) {
        const organizable = organizableIds(event.result.added_ids ?? []);
        showToast({
          id: "import-organize", title: `${event.result.added}件のPDFを追加しました`,
          description: organizable ? "AIで内容別のフォルダー分けの案を作れます。"
            : `一度にAIで分けられるのは${MAX_ORGANIZE_PAPERS}件までです。フォルダーの右クリックから、絞って分けられます。`,
          tone: "info", timeout: 12_000,
          action: organizable ? { label: "AIで分類", run: () => emitAppEvent("open-organize-dialog", { paperIds: organizable }) } : undefined,
        });
      }
      // Scans that were not read while being added: offer to read them now (unless OCR is 使わない).
      void offerOcrAfterImport(event.result.needs_ocr ?? []);
    },
  },
  export: {
    succeeded: (event, { done }) => done(event.result.destination, {
      title: event.result.kind === "bilingual" ? "対訳PDFを保存しました" : "原文・日本語訳の交互PDFを保存しました",
    }),
  },
  interleaved: {
    succeeded: (event) => {
      if (!event.result.path) return;
      shell.openPath(event.result.path).catch(() =>
        useStore.getState().setStatus("PDFを開けませんでした。既定のPDFアプリを確認してください。"));
    },
  },
};
