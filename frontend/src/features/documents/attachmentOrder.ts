/** Move among the same format while keeping the other format's slots unchanged. */
export function reorderedAttachments(rows: readonly { id: string; format: string }[], id: string, direction: number): string[] {
  const current = rows.find(row => row.id === id);
  const peers = rows.filter(row => row.format === current?.format);
  const at = peers.findIndex(row => row.id === id), target = at + direction;
  const ids = rows.map(row => row.id);
  if (at < 0 || target < 0 || target >= peers.length) return ids;
  const first = ids.indexOf(id), second = ids.indexOf(peers[target].id);
  [ids[first], ids[second]] = [ids[second], ids[first]];
  return ids;
}
