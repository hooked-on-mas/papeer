/** One chooser/import flight; stale asynchronous completions cannot release a later flight. */
export class FileChooserHold {
  private token: object | null = null;
  current() { return this.token; }
  begin(): object | null { if (this.token) return null; return this.token = {}; }
  end(token: object) { if (this.token === token) this.token = null; }
  clear() { this.token = null; }
}
