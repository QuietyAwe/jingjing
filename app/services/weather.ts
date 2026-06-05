import { apiRequest } from './api';

export interface WeatherData {
  time_of_day: string;
  weather_text: string;
}

export async function getWeather(lat?: number, lon?: number): Promise<WeatherData> {
  const params = lat && lon ? `?lat=${lat}&lon=${lon}` : '';
  return apiRequest<WeatherData>(`/api/weather${params}`);
}
