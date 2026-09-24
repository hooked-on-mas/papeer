import { create } from "zustand";

export interface Job {
  job_id: string;
  paper_id?: string;
  message?: string;
  done?: number;
  total?: number;
  status?: "running" | "succeeded" | "cancelled" | "failed";
}

interface UiState {
  activePaperId: string | null;
  activeTab: string;
  zoom: number; // 1.0 = 100%, 0 = fit-width
  currentPage: number;
  activeJobs: Job[];
  setActivePaperId: (id: string | null) => void;
  setActiveTab: (tab: string) => void;
  setZoom: (zoom: number) => void;
  setCurrentPage: (page: number) => void;
  addJob: (job: Job) => void;
  updateJob: (job_id: string, updates: Partial<Job>) => void;
  removeJob: (job_id: string) => void;
}

export const useStore = create<UiState>((set) => ({
  activePaperId: null,
  activeTab: "reader",
  zoom: 0, // 0 indicates "fit width"
  currentPage: 1,
  activeJobs: [],
  setActivePaperId: (id) => set({ activePaperId: id }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setZoom: (zoom) => set({ zoom }),
  setCurrentPage: (page) => set({ currentPage: page }),
  addJob: (job) => set((state) => ({ activeJobs: [...state.activeJobs, job] })),
  updateJob: (job_id, updates) => set((state) => ({
    activeJobs: state.activeJobs.map(j => j.job_id === job_id ? { ...j, ...updates } : j)
  })),
  removeJob: (job_id) => set((state) => ({
    activeJobs: state.activeJobs.filter(j => j.job_id !== job_id)
  })),
}));
