import type { LegacyDriveReadPort } from '../../migrations/legacyDrive.ts';
import type { DesktopEditRequest } from './editRepository.ts';

export function createDesktopLegacyDriveRead(request: DesktopEditRequest): LegacyDriveReadPort {
  const call = <T>(path: string, body: object = {}) => request<T>('/api/edits/legacy-drive/' + path, body);
  return {
    account: () => call<string>('account'),
    metadata: fileId => call('metadata', { fileId }),
    children: fileId => call('children', { fileId }),
    libraryFiles: (libraryId, kind) => call('library-files', { libraryId, kind }),
    read: async fileId => {
      const { dataBase64 } = await call<{ dataBase64: string }>('read', { fileId });
      return Uint8Array.from(atob(dataBase64), char => char.charCodeAt(0));
    },
  };
}
