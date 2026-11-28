import { invoke } from '@tauri-apps/api/core';

/** The native dialog chooses the destination; document bytes use Tauri's binary IPC. */
export async function saveOutputFile(bytes: Uint8Array, mediaType: 'application/pdf' | 'image/png', suggestedName: string): Promise<'saved' | 'cancelled'> {
  const result = await invoke<{ status: 'saved' | 'cancelled' }>('save_output_file', bytes, { headers: {
    'X-Papeer-Output-Name': encodeURIComponent(suggestedName),
    'X-Papeer-Output-Format': mediaType === 'application/pdf' ? 'pdf' : 'png',
  } });
  return result.status;
}
