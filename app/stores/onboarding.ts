import { create } from 'zustand';

interface OnboardingState {
  // 用户数据
  userId: number | null;
  deviceUuid: string | null;
  callName: string;

  // Onboarding 步骤
  step: 'frequency' | 'anchor' | 'complete';

  // Actions
  setUserId: (id: number) => void;
  setDeviceUuid: (uuid: string) => void;
  setCallName: (name: string) => void;
  setStep: (step: 'frequency' | 'anchor' | 'complete') => void;
  reset: () => void;
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  userId: null,
  deviceUuid: null,
  callName: 'gege',
  step: 'frequency',

  setUserId: (id) => set({ userId: id }),
  setDeviceUuid: (uuid) => set({ deviceUuid: uuid }),
  setCallName: (name) => set({ callName: name }),
  setStep: (step) => set({ step }),
  reset: () => set({ userId: null, deviceUuid: null, callName: 'gege', step: 'frequency' }),
}));
