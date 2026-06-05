import { create } from 'zustand';
import type { DiaryEntry, DiaryComment } from '../services/diary';

interface DiaryState {
  entries: DiaryEntry[];
  comments: Record<number, DiaryComment[]>; // diaryId -> comments
  isLoading: boolean;
  page: number;
  hasMore: boolean;

  setEntries: (entries: DiaryEntry[]) => void;
  appendEntries: (entries: DiaryEntry[]) => void;
  addEntry: (entry: DiaryEntry) => void;
  updateLikes: (diaryId: number, likes: number) => void;
  setComments: (diaryId: number, comments: DiaryComment[]) => void;
  addComment: (diaryId: number, comment: DiaryComment) => void;
  setLoading: (loading: boolean) => void;
  setPage: (page: number) => void;
  setHasMore: (hasMore: boolean) => void;
}

export const useDiaryStore = create<DiaryState>((set) => ({
  entries: [],
  comments: {},
  isLoading: false,
  page: 1,
  hasMore: true,

  setEntries: (entries) => set({ entries }),
  appendEntries: (newEntries) =>
    set((state) => ({ entries: [...state.entries, ...newEntries] })),
  addEntry: (entry) =>
    set((state) => ({ entries: [entry, ...state.entries] })),
  updateLikes: (diaryId, likes) =>
    set((state) => ({
      entries: state.entries.map((e) =>
        e.id === diaryId ? { ...e, likes } : e,
      ),
    })),
  setComments: (diaryId, comments) =>
    set((state) => ({
      comments: { ...state.comments, [diaryId]: comments },
    })),
  addComment: (diaryId, comment) =>
    set((state) => ({
      comments: {
        ...state.comments,
        [diaryId]: [...(state.comments[diaryId] || []), comment],
      },
      entries: state.entries.map((e) =>
        e.id === diaryId ? { ...e, comment_count: e.comment_count + 1 } : e,
      ),
    })),
  setLoading: (isLoading) => set({ isLoading }),
  setPage: (page) => set({ page }),
  setHasMore: (hasMore) => set({ hasMore }),
}));
