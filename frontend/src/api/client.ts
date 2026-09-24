import createClient from "openapi-fetch";
import type { paths } from "./schema";

const port = import.meta.env.VITE_PAPERDESK_PORT || 8000;
const token = import.meta.env.VITE_PAPERDESK_TOKEN || "";

export const api = createClient<paths>({
  baseUrl: `http://127.0.0.1:${port}/`,
  headers: {
    Authorization: `Bearer ${token}`
  }
});

