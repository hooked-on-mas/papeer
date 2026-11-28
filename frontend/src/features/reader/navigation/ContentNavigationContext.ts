import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ContentNavigationSession } from './ContentNavigationSession';

export const ContentNavigationContext = createContext<ContentNavigationSession | null>(null);
const noSubscribe = () => () => {};
const noSnapshot = () => null;
export function useContentNavigation() {
  const navigation = useContext(ContentNavigationContext);
  const state = useSyncExternalStore(navigation?.subscribe ?? noSubscribe, navigation?.getSnapshot ?? noSnapshot,
    navigation?.getSnapshot ?? noSnapshot);
  return { navigation, state };
}
