import { notifyIfAway, shell } from "@/shell";
import { useStore } from "@/store";
import type { JobHandlers } from "@/features/jobs/jobHandlers";
import { offerOcrAfterImport } from "@/features/ocr/ocrActions";

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
