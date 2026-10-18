import type { PaperData } from "../../src/api/hooks.ts";

/**
 * A library row with every column a row has (PaperRow in the generated types), empty unless given:
 * tests name only the fields they are about.
 */
export function paperData(values: Pick<PaperData, "id"> & Partial<PaperData>): PaperData {
  return {
    sha256: "", title: values.id, original_name: "", pages: 1, status: "not_translated", collection_name: "", created_at: "",
    tags: [], read_status: "", first_author: "", publication_year: "", bibliography_version: 1, doi: "", arxiv_id: "", venue: "",
    kind: "pdf", parent_id: null,
    ...values,
  };
}
