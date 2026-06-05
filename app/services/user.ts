import { apiRequest } from './api';

export interface User {
  id: number;
  device_uuid: string;
  call_name: string;
  city: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

export async function createUser(deviceUuid: string, callName: string = 'gege'): Promise<User> {
  return apiRequest<User>('/api/users', {
    method: 'POST',
    body: JSON.stringify({ device_uuid: deviceUuid, call_name: callName }),
  });
}

export async function getUser(userId: number): Promise<User> {
  return apiRequest<User>(`/api/users/${userId}`);
}

export async function updateUser(
  userId: number,
  data: { call_name?: string; city?: string; phone?: string }
): Promise<User> {
  return apiRequest<User>(`/api/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
