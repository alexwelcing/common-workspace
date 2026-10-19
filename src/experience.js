import { appURL } from './app-path.js';

// Persisted engine identifier: keep it compatible with existing rooms and admissions.
export const SPATIAL_EXPERIENCE = 'spatial-beta';
export const isSpatialRoom = room => room?.experience === SPATIAL_EXPERIENCE;

export function requestsSpace(url) {
  const selected = url.searchParams.get('experience');
  return selected === null ? url.searchParams.get('beta') === 'space' : selected === 'space';
}

export function selectExperience(url, spatial) {
  url.searchParams.delete('beta');
  if (spatial) url.searchParams.set('experience', 'space');
  else url.searchParams.delete('experience');
  return url;
}

export function spacePath(path = '/') {
  const url = selectExperience(new URL(appURL(path)), true);
  return `${url.pathname}${url.search}${url.hash}`;
}
