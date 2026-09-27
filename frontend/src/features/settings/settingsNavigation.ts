import { create } from "zustand";

export type SettingsSection = "connection" | "appearance" | "prompts" | "shortcuts" | "backup" | "drive" | "tags" | "reading-status" | "sticky-labels" | "note-templates";

export const useSettingsNavigation = create<{
  open: boolean;
  section: SettingsSection;
  templateNote: string | null;
  openSettings: (section?: SettingsSection, note?: string) => void;
  setOpen: (open: boolean) => void;
  setSection: (section: SettingsSection) => void;
}>(set => ({
  open: false,
  section: "connection",
  templateNote: null,
  openSettings: (section = "connection", note) => set({ open: true, section, templateNote: note ?? null }),
  setOpen: open => set(open ? { open } : { open, templateNote: null }),
  setSection: section => set({ section }),
}));

export const openSettings = (section: SettingsSection, note?: string) => useSettingsNavigation.getState().openSettings(section, note);
