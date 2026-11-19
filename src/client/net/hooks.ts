import { useSyncExternalStore } from 'react';
import { client, type ClientSnapshot } from './client';

export function useClient(): ClientSnapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}
